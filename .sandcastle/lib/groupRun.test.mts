// Pin group publication through fake external ports and the real group queue.
import { execFileSync } from "node:child_process";
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loggedCommand } from "./commandOutput.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubAccess } from "./githubAccess.mts";
import { runGroup, refreshBranch, type GroupRunPorts, type GroupPr, type MergedGroupPr } from "./groupRun.mts";
import { runGroupQueue } from "./groupQueue.mts";
import { RunFatalError } from "./issueLoop.mts";
import type { Group } from "./groups.mts";

const group: Group = {
  id: "42", parentIssue: 42,
  issues: [
    { number: 1, title: "First", labels: [] },
    { number: 2, title: "Second", labels: [] },
  ],
};
const options = { baseBranch: "main", baseRef: "origin/main" };

/** A missing blocker answer holds one issue until a later merge triggers a fresh plan (#1261). */
test("a failed blocker lookup holds its issue until a successful replan", async () => {
  const h = harness();
  let attempts = 0;
  h.ports.github.blockers = async (issue) => {
    if (issue.number === 2 && ++attempts === 1) throw new Error("blocker lookup forbidden");
    return [];
  };
  const workIssue = h.ports.workIssue;
  h.ports.workIssue = (issue, branch, signal) => {
    if (issue.id === "2") assert.ok(attempts > 1, "issue must wait for a successful lookup");
    return workIssue(issue, branch, signal);
  };

  assert.equal(await runGroup(h.ports, options, group), true, h.logs.join("\n"));
  assert.deepEqual(h.started, ["1", "2"]);
  assert.match(h.logs.join("\n"), /#2.*blocker lookup forbidden.*next replan/);
  assert.deepEqual(h.readied, ["sandcastle/batch-42-1234"]);
});

/** A failed dependency read cannot become an empty blocker list or an exhausted-attempts report. */
test("persistent blocker lookup failure leaves its issue out of the draft", async () => {
  const h = harness();
  h.ports.github.blockers = async (issue) => {
    if (issue.number === 2) throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("HTTP 403: blocker lookup forbidden") });
    return [];
  };
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual(h.started, ["1"]);
  assert.match(h.logs.join("\n"), /#2.*blocker lookup failed/);
  assert.match(h.logs.join("\n"), /HTTP 403: blocker lookup forbidden/);
  assert.match(h.creates[0].body, /#2: Second \(blocker lookup failed: Command failed\nHTTP 403: blocker lookup forbidden\)/);
  assert.doesNotMatch(h.creates[0].body, /Closes #2|ran out of attempts/);
  assert.deepEqual(h.readied, []);
});

/** An exhausted GitHub outage still ends the run rather than holding one issue. */
test("a blocker outage remains a network run stop", async () => {
  const h = harness();
  h.ports.github.blockers = async () => { throw new Error("error connecting to api.github.com"); };
  await assert.rejects(runGroup(h.ports, options, group), (error) => error instanceof RunFatalError && error.kind === "network");
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.closed, h.opened);
});

/** An unavailable merged-head list must stop before choosing or resuming a batch (#1261). */
test("a failed merged-head lookup stops before any batch branch is resumed", async () => {
  const h = harness({ resumed: true });
  h.ports.github.mergedPrHeads = () => {
    throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("HTTP 403: merged PR lookup forbidden") });
  };
  h.ports.git.catchUp = () => { assert.fail("must not resume the batch"); };
  await assert.rejects(runGroup(h.ports, options, group), /HTTP 403: merged PR lookup forbidden/);
  assert.deepEqual(h.branches, []);
  assert.equal(h.selected, "");
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
});

/** Startup must propagate failed board reads with their captured diagnostics. */
test("a failed startup board read throws its own error text before a group starts", async () => {
  const h = harness();
  const { access } = fakeOutage(h, () => true);
  const board = () => {
    throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("HTTP 401: board lookup unauthorized") });
  };
  await assert.rejects(async () => runGroup(h.ports, options, await access.run(board)), /HTTP 401: board lookup unauthorized/);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.pushes, []);
  assert.equal(h.waits, 0);
});
/** The one line an outage prints, however many callers met it. */
const WAIT_ANNOUNCEMENT = "checking again every minute";

/** Model external branch, sandbox and GitHub state without starting agents or git. */
function harness(settings: {
  resumed?: boolean; existingPr?: string; done?: number[]; ready?: number[];
  blockers?: Record<number, number[]>; ahead?: number; alreadyPushed?: boolean;
  fileChanges?: boolean; closedIssues?: number[];
  dirty?: number[]; unfinished?: string[]; failSync?: Error;
  pushFailures?: Error[]; recovered?: boolean;
  mergedDuringWrite?: MergedGroupPr; localOnly?: string[];
  prClosedUnmerged?: boolean; failMergedLookup?: Error;
  held?: Record<string, string>;
} = {}) {
  const logs: string[] = [];
  const warnings: string[] = [];
  const pushes: string[] = [];
  const creates: (GroupPr & { base: string })[] = [];
  const edits: GroupPr[] = [];
  const readied: string[] = [];
  const branches: { branch: string; from: string; force?: boolean }[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const started: string[] = [];
  const saved: number[] = [];
  const merged = new Set(settings.done ?? []);
  const ready = new Set(settings.ready ?? []);
  const dirty = new Set(settings.dirty ?? []);
  const writeups: string[] = [];
  const remoteMerges: string[] = [];
  let clock = 0;
  const access = createGitHubAccess({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    reachable: () => settings.recovered ?? false,
    log: (message) => { logs.push(message); },
  });
  const pushFailures = [...(settings.pushFailures ?? [])];
  let mergedPr: MergedGroupPr | undefined;
  let stranded = 0;
  let selected = "";
  let ended = false;
  let ahead = settings.ahead ?? (merged.size > 0 ? 1 : 0);
  const ports: GroupRunPorts = {
    github: {
      isIssueOpen: async (number) => !settings.closedIssues?.includes(number),
      issueTitle: async (number) => `Spec ${number}`,
      blockers: async (issue) => settings.blockers?.[issue.number] ?? [],
      mergedPrHeads: () => [],
      mergedPr: async () => {
        if (settings.failMergedLookup) throw settings.failMergedLookup;
        return settings.mergedDuringWrite ?? mergedPr;
      },
      openPr: async () => settings.prClosedUnmerged ? undefined : settings.existingPr,
      createDraftPr: async (pr) => { creates.push(pr); },
      editPr: async (pr) => { edits.push(pr); },
      readyPr: async (head) => { readied.push(head); },
    },
    git: {
      fetchBase: () => {},
      branchesMatching: (glob) => settings.resumed && glob.includes("batch") ? ["sandcastle/batch-42-old"] : [],
      isBatchBranchShipped: () => false,
      createBranch: (branch, from, force) => { branches.push({ branch, from, force }); },
      catchUp: () => {
        if (settings.held?.["sandcastle/batch-42-old"]) throw new Error("catch-up touched a held batch");
        return settings.resumed ? "fast-forwarded" : "no-remote";
      },
      foreignWorktree: (branch) => settings.held?.[branch],
      doneIssues: () => [...merged],
      worktreeExists: (branch) => dirty.has(Number(branch.split("-").at(-1))),
      worktreeIsDirty: (branch) => dirty.has(Number(branch.split("-").at(-1))),
      saveWorktree: (_branch, issue) => { saved.push(issue); dirty.delete(issue); return true; },
      isStale: () => false,
      resetWorktree: () => {},
      commitsAhead: () => ahead,
      hasFileChanges: () => settings.fileChanges ?? ahead > 0,
      commitsSince: (ref, branch) => {
        assert.equal(ref, "merged-head");
        assert.equal(branch, "sandcastle/batch-42-old");
        return settings.localOnly ?? [];
      },
      readyToMerge: (_branch, issues) => issues.filter((issue) => ready.has(issue.issueNumber)).map((issue) => issue.branch),
      unfinishedBranches: () => settings.unfinished ?? [],
      resolveCommit: () => "local-tip",
      resolveRemoteCommit: () => settings.alreadyPushed ? "local-tip" : undefined,
    },
    push: async (branch) => {
      pushes.push(branch);
      const failure = pushFailures.shift();
      if (failure) throw failure;
    },
    githubCall: access.run,
    createIntegrationSandbox: (branch) => {
      opened.push(branch);
      return {
        branch,
        mergeRemoteCopy: async (issues) => { remoteMerges.push(issues); },
        syncWithBase: async () => { if (settings.failSync) throw settings.failSync; },
        merge: async (issues) => {
          for (const issue of issues) { merged.add(Number(issue.id)); ready.delete(Number(issue.id)); ahead++; }
        },
        assertGreen: async () => {},
        writePr: async (issues) => {
          writeups.push(issues);
          mergedPr = settings.mergedDuringWrite;
          return { title: "Reviewed batch title", body: "Reviewed batch writeup." };
        },
        close: async () => { closed.push(branch); },
      };
    },
    runQueue: runGroupQueue,
    workIssue: async (issue) => {
      started.push(issue.id);
      ready.add(Number(issue.id));
      return { completed: true, commits: [{ sha: `commit-${issue.id}` }] };
    },
    clearSession: () => {},
    prAttribution: () => ({ implementers: { byIssue: {}, fallback: "Test agent" } }),
    integrationBranchSelected: (branch) => { selected = branch; },
    recordStranded: (count) => { stranded += count; },
    endTimeReached: () => { ended = true; },
    pastEndTime: () => false,
    sharedFailureStop: (message) => new RunFatalError("shared", message),
    waitForGitHub: access.wait,
    now: () => 1234,
    log: (message) => { logs.push(message); },
    warn: (message) => { warnings.push(message); },
  };
  return { ports, logs, warnings, pushes, creates, edits, readied, branches, opened, closed,
    started, saved, writeups, remoteMerges, get stranded() { return stranded; },
    get waits() { return logs.filter((line) => line.includes(WAIT_ANNOUNCEMENT)).length; }, get selected() { return selected; }, get ended() { return ended; } };
}

/** A fresh partial batch publishes only merged issues and stays draft. */
test("a fresh group pushes a draft with outstanding blockers", async () => {
  const h = harness({ blockers: { 2: [99] } });
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual(h.branches, [{ branch: "sandcastle/batch-42-1234", from: "origin/main", force: undefined }]);
  assert.deepEqual(h.pushes, ["sandcastle/batch-42-1234"]);
  assert.deepEqual(h.started, ["1"]);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].head, "sandcastle/batch-42-1234");
  assert.equal(h.creates[0].base, "main");
  assert.equal(h.creates[0].title, "Spec 42");
  assert.match(h.creates[0].body, /Closes #1: First/);
  assert.match(h.creates[0].body, /#2: Second/);
  assert.doesNotMatch(h.creates[0].body, /Closes #2/);
  assert.deepEqual(h.readied, []);
  assert.deepEqual(h.writeups, []);
  assert.deepEqual(h.logs.slice(0, 4), [
    "\n" + "=".repeat(70), "Group sandcastle:42 — 2 open issue(s)", "=".repeat(70),
    "\nCut integration branch: sandcastle/batch-42-1234",
  ]);
  assert.deepEqual(h.logs.slice(-2), [
    "\nOpened draft PR for sandcastle/batch-42-1234 → main.",
    "Group sandcastle:42 still has outstanding work — PR left as a draft.",
  ]);
  assert.deepEqual(h.closed, h.opened);
});

/** A resumed batch picks up finished work, saves dirt and refreshes its existing PR. */
test("a resumed group grows its existing draft without redoing merged issues", async () => {
  const h = harness({ resumed: true, existingPr: "https://example.test/pr/7", ready: [1], dirty: [2], blockers: { 2: [99] } });
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual(h.branches, []);
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.saved, [2]);
  assert.deepEqual(h.pushes, ["sandcastle/batch-42-old"]);
  assert.deepEqual(h.creates, []);
  assert.equal(h.edits.length, 1);
  assert.equal(h.edits[0].head, "sandcastle/batch-42-old");
  assert.match(h.edits[0].body, /Closes #1: First/);
  assert.deepEqual(h.readied, []);
  assert.ok(h.logs.includes("\nResuming integration branch: sandcastle/batch-42-old"));
  assert.ok(h.logs.includes("Fast-forwarded sandcastle/batch-42-old to origin/sandcastle/batch-42-old."));
  assert.ok(h.logs.includes("Saved #2: sandcastle/issue-2 was left dirty by an interrupted run."));
  assert.ok(h.logs.includes("\nPicking up 1 branch(es) from a prior run:"));
  assert.ok(h.logs.includes("\nRefreshed PR for sandcastle/batch-42-old: https://example.test/pr/7"));
  assert.deepEqual(h.closed, ["sandcastle/batch-42-old"]);
});

/** An unchanged file tree means no push and no PR mutation. */
test("a group with nothing merged leaves an existing PR untouched", async () => {
  const h = harness({ existingPr: "https://example.test/pr/7", blockers: { 1: [99], 2: [99] } });
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.readied, []);
  assert.deepEqual(h.writeups, []);
  assert.equal(h.logs.at(-1), "\nsandcastle:42: no file changes against main in sandcastle/batch-42-1234. No PR opened; any existing PR left untouched.");
  assert.deepEqual(h.closed, h.opened);
});

/** A finished batch gets the writer's body and is marked ready after its draft is created. */
test("a complete group publishes the written body and marks its PR ready", async () => {
  const h = harness({ blockers: { 2: [1] } });
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual(h.started, ["1", "2"]);
  assert.deepEqual(h.writeups, ["Parent spec #42: Spec 42\n\n- 1: First\n- 2: Second"]);
  assert.equal(h.creates[0].title, "Reviewed batch title");
  assert.deepEqual(h.pushes, ["sandcastle/batch-42-1234"]);
  assert.match(h.creates[0].body, /Reviewed batch writeup\./);
  assert.match(h.creates[0].body, /Closes #1: First/);
  assert.match(h.creates[0].body, /Closes #2: Second/);
  assert.deepEqual(h.readied, ["sandcastle/batch-42-1234"]);
  assert.equal(h.logs.at(-1), "Group sandcastle:42 is complete — PR marked ready for review.");
});

/** An already-pushed complete batch refreshes its PR without another push. */
test("a complete resumed group skips an unchanged push and marks the existing PR ready", async () => {
  const h = harness({ resumed: true, existingPr: "https://example.test/pr/7", done: [1, 2], alreadyPushed: true });
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.equal(h.edits.length, 1);
  assert.deepEqual(h.readied, ["sandcastle/batch-42-old"]);
  assert.ok(h.logs.includes("\nsandcastle/batch-42-old is already on origin; nothing to push."));
});

/** A failed sync still closes the sandbox and cannot publish the branch. */
test("a failed group closes its sandbox and propagates the error", async () => {
  const failure = new Error("sync failed");
  const h = harness({ failSync: failure });
  await assert.rejects(runGroup(h.ports, options, group), (error) => error === failure);
  assert.deepEqual(h.closed, h.opened);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
});

/** Merge commits and Done markers alone must never create an empty PR (#1263). */
test("a batch with only merge commits and Done markers opens no PR", async () => {
  const h = harness({ resumed: true, done: [1, 2], ahead: 4, fileChanges: false });
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.writeups, []);
  assert.equal(h.logs.at(-1), "\nsandcastle:42: no file changes against main in sandcastle/batch-42-old. No PR opened; any existing PR left untouched.");
  assert.deepEqual(h.closed, h.opened);
});

/** An existing PR for a marker-only finished batch remains untouched (#1263). */
test("a finished batch with no file changes leaves its open PR untouched", async () => {
  const h = harness({ resumed: true, done: [1, 2], ahead: 4, fileChanges: false, existingPr: "https://example.test/pr/7" });
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.readied, []);
  assert.deepEqual(h.writeups, []);
  assert.match(h.logs.at(-1)!, /sandcastle:42: no file changes against main.*No PR opened; any existing PR left untouched/);
  assert.deepEqual(h.closed, h.opened);
});

/** A stale board must not send an already-closed issue to the planner or agents. */
test("a group drops issues closed since the board read before planning", async () => {
  const h = harness({ closedIssues: [1], dirty: [1], ready: [1] });
  const planned: number[] = [];
  h.ports.github.blockers = async (issue) => { planned.push(issue.number); return []; };
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual([...new Set(planned)], [2]);
  assert.deepEqual(h.started, ["2"]);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.writeups, ["Parent spec #42: Spec 42\n\n- 2: Second"]);
  assert.doesNotMatch(h.creates[0].body, /Closes #1:/);
  assert.ok(h.logs.some((line) => /#1.*closed/.test(line)));
  assert.deepEqual(group.issues.map((issue) => issue.number), [1, 2]);
});

/** All-closed groups report a skip without any git or sandbox effects or failure. */
test("an all-closed group is neither published nor failed and opens nothing", async () => {
  const h = harness({ closedIssues: [1, 2], dirty: [1, 2] });
  let published = 0;
  let failed = 0;
  h.ports.git.fetchBase = () => { throw new Error("must not fetch for a skipped group"); };
  try {
    if (await runGroup(h.ports, options, group)) published++;
  } catch { failed++; }
  assert.equal(published, 0);
  assert.equal(failed, 0);
  assert.deepEqual(h.branches, []);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.readied, []);
  assert.match(h.logs.at(-1)!, /Skipping group sandcastle:42: no open issues remain/);
});

/** Restarting the same board group after a quota wait must ask GitHub again. */
test("a quota restart drops issues that closed during the wait", async () => {
  const quota = new RunFatalError("quota", "Quota spent");
  const h = harness({ failSync: quota });
  const closedDuringWait = new Set<number>();
  h.ports.github.isIssueOpen = async (number) => !closedDuringWait.has(number);
  await assert.rejects(runGroup(h.ports, options, group), (error) => error === quota);
  closedDuringWait.add(1);
  closedDuringWait.add(2);
  h.branches.length = 0;
  h.opened.length = 0;
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.branches, []);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.creates, []);
  assert.match(h.logs.at(-1)!, /no open issues remain/);
});

/** An unavailable issue state is a failure, never evidence that the issue closed. */
test("a failed freshness lookup stops before creating branches or sandboxes", async () => {
  const h = harness();
  const failure = new Error("GitHub refused issue state lookup");
  h.ports.github.isIssueOpen = async () => { throw failure; };
  await assert.rejects(runGroup(h.ports, options, group), (error) => error === failure);
  assert.deepEqual(h.branches, []);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.logs, []);
});

/** Fallback blocker checks use the group's freshness answer throughout this start. */
test("planning reuses start-time issue states for blockers", async () => {
  const h = harness({ closedIssues: [1] });
  const lookedUp: number[] = [];
  const lookup = h.ports.github.isIssueOpen;
  h.ports.github.isIssueOpen = async (number) => { lookedUp.push(number); return lookup(number); };
  h.ports.github.blockers = async (_issue, isOpen) =>
    (await isOpen(1)) ? [1] : (await isOpen(99)) ? [99] : [];
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.started, []);
  assert.deepEqual(lookedUp, [1, 2, 99]);
});

/** A refused push reports its cause and captured output through the run logger. */
for (const [stderr, category] of [
  ["! [rejected] batch -> batch (non-fast-forward)", "pushed copy moved on"],
  ["remote: error: GH013: Repository rule violations found", "repository rule"],
  ["fatal: Could not resolve host: github.com", "unreachable"],
  ["fatal: Authentication failed", "other"],
]) {
  /** Pin the classification and raw error visible to the owner. */
  test(`a failed push logs ${category} and git's own error`, async () => {
    const failure = Object.assign(new Error("Command failed: git push"), { stderr: Buffer.from(stderr) });
    const h = harness({ pushFailures: [failure] });
    await assert.rejects(runGroup(h.ports, options, group), new RegExp(category));
    assert.ok(h.logs.some((line) => line.includes(category) && line.includes(stderr)));
    assert.deepEqual(h.creates, []);
    assert.deepEqual(h.closed, h.opened);
  });
}

/** A network interruption is logged before waiting and retrying the push. */
test("a push retries once GitHub answers again", async () => {
  const stderr = "fatal: Failed to connect to github.com port 443";
  const h = harness({ pushFailures: [Object.assign(new Error("Command failed: git push"), { stderr })], recovered: true });
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.equal(h.waits, 1);
  assert.equal(h.pushes.length, 2);
  assert.ok(h.logs.some((line) => line.includes("unreachable") && line.includes(stderr)));
  assert.equal(h.creates.length, 1);
});

/** A failed GitHub command reaches the file logger even when its caller catches the error. */
test("a failed gh call records captured diagnostics in the run log file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-command-log-"));
  const logFile = join(directory, "run.log");
  const h = harness();
  h.ports.log = (message) => { appendFileSync(logFile, `${message}\n`); };
  h.ports.github.createDraftPr = async () => {
    loggedCommand(() => execFileSync(process.execPath, ["-e",
      'process.stdout.write("PR request failed\\n"); process.stderr.write("GraphQL: Resource not accessible by integration\\n"); process.exit(1);',
    ], { stdio: "pipe" }), h.ports.log);
  };
  try {
    await assert.rejects(runGroup(h.ports, options, group));
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /PR request failed/);
    assert.match(log, /GraphQL: Resource not accessible by integration/);
    assert.deepEqual(h.readied, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Exhausting the existing outage wait leaves the push classified and unpublished. */
test("a push stops when GitHub never answers", async () => {
  const failure = new Error("fatal: Could not resolve host: github.com");
  const h = harness({ pushFailures: [failure] });
  await assert.rejects(runGroup(h.ports, options, group), /unreachable/);
  assert.equal(h.waits, 1);
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(h.creates, []);
});

/** A failed retry gets its own diagnosis rather than hiding behind the first failure. */
test("a refused retry reports the new push failure", async () => {
  const h = harness({ pushFailures: [
    new Error("fatal: Could not resolve host: github.com"),
    new Error("remote: error: GH006: Protected branch update failed"),
  ], recovered: true });
  await assert.rejects(runGroup(h.ports, options, group), /repository rule/);
  assert.equal(h.waits, 1);
  assert.equal(h.pushes.length, 2);
  assert.ok(h.logs.some((line) => line.includes("unreachable")));
  assert.ok(h.logs.some((line) => line.includes("repository rule") && line.includes("GH006")));
  assert.deepEqual(h.creates, []);
});

/** A publish-time remote merge precedes the body marker, so resuming reuses the body (#1266). */
test("a pushed-copy merge leaves the recorded PR body reusable on the next run", async () => {
  const h = harness({ resumed: true, done: [1, 2], existingPr: "https://example.test/pr/7" });
  let revision = 1;
  let markerRevision: number | undefined;
  let writerRuns = 0;
  let fetches = 0;
  let remotePending = false;
  h.ports.git.catchUp = () => {
    if (++fetches === 2) remotePending = true;
    return remotePending ? "diverged" : "up-to-date";
  };
  const open = h.ports.createIntegrationSandbox;
  h.ports.createIntegrationSandbox = (branch) => ({
    ...open(branch),
    mergeRemoteCopy: async () => {
      if (remotePending) { revision++; remotePending = false; return true; }
      return false;
    },
    writePr: async () => {
      if (markerRevision !== revision) { writerRuns++; markerRevision = ++revision; }
      return { body: "Recorded body including the pushed copy." };
    },
  });
  h.ports.push = async (branch) => {
    assert.equal(markerRevision, revision, "the pushed tip must carry the body marker");
    h.pushes.push(branch);
  };

  await runGroup(h.ports, options, group);
  await runGroup(h.ports, options, group);

  assert.equal(writerRuns, 1);
  assert.equal(h.edits.length, 2);
  assert.match(h.edits[1].body, /Recorded body including the pushed copy/);
});

/** Refresh fetches again after syncing the base, so a concurrent remote update can be pushed (#1266). */
test("refresh merges a pushed copy that moves during the base merge", async () => {
  const h = harness({ resumed: true });
  const branch = "sandcastle/batch-42-old";
  const local = new Set(["issue-work"]);
  const remote = new Set(["issue-work"]);
  let fetched = new Set(remote);
  h.ports.git.catchUp = () => {
    fetched = new Set(remote);
    return [...fetched].every((commit) => local.has(commit)) ? "up-to-date" : "diverged";
  };
  const open = h.ports.createIntegrationSandbox;
  h.ports.createIntegrationSandbox = (head) => ({
    ...open(head),
    syncWithBase: async () => {
      local.add("base-update");
      remote.add("pushed-update");
      return true;
    },
    mergeRemoteCopy: async () => {
      for (const commit of fetched) local.add(commit);
      return true;
    },
  });
  h.ports.push = async (head) => {
    assert.ok([...remote].every((commit) => local.has(commit)), "push must be a fast-forward");
    h.pushes.push(head);
  };

  assert.equal(await refreshBranch({
    ...h.ports,
    git: { ...h.ports.git, isBehindBase: () => true },
    prTitle: async () => "Batch title",
  }, options, branch), true);

  assert.deepEqual([...local].sort(), ["base-update", "issue-work", "pushed-update"]);
  assert.deepEqual(h.pushes, [branch]);
  assert.deepEqual(h.closed, [branch]);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.readied, []);
  assert.deepEqual(h.started, []);
});

/** A merge during the writer must not resurrect the deleted head or create a duplicate PR (#1264). */
test("a batch PR merged during the group stays local and names its remaining commits", async () => {
  const h = harness({
    resumed: true,
    mergedDuringWrite: { number: 534, url: "https://example.test/pr/534", headRefOid: "merged-head" },
    localOnly: ["abc123 Fix remaining work", "def456 Sandcastle: #2 done"],
  });
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.readied, []);
  assert.match(h.logs.join("\n"), /sandcastle\/batch-42-old.*#534.*https:\/\/example.test\/pr\/534/);
  assert.match(h.logs.join("\n"), /local-only.*abc123 Fix remaining work/s);
  assert.match(h.logs.join("\n"), /local-only.*def456 Sandcastle: #2 done/s);
  assert.deepEqual(h.closed, h.opened);
});

/** Closing without merging leaves the batch eligible for a new draft (#1264). */
test("a closed-unmerged batch PR is replaced by a new draft", async () => {
  const h = harness({ resumed: true, prClosedUnmerged: true, blockers: { 2: [99] } });
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual(h.pushes, ["sandcastle/batch-42-old"]);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].head, "sandcastle/batch-42-old");
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.readied, []);
  assert.match(h.logs.join("\n"), /Opened draft PR/);
});

/** A merged head with no later commits still cannot be recreated (#1264). */
test("a merged batch with no remaining commits reports that nothing is local-only", async () => {
  const h = harness({
    resumed: true,
    mergedDuringWrite: { number: 534, url: "https://example.test/pr/534", headRefOid: "merged-head" },
  });
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.ok(h.logs.includes("No local-only commits since that merge."));
});

/** An unavailable merged-PR answer cannot authorize recreating a shipped head. */
test("a failed publish merged-PR lookup stops the group without pushing", async () => {
  const failure = new Error("merged PR lookup refused");
  const h = harness({ failMergedLookup: failure });
  await assert.rejects(runGroup(h.ports, options, group), (error) => error === failure);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.readied, []);
  assert.deepEqual(h.closed, h.opened);
});

/** A foreign batch fails before catch-up, allowing the caller to count it and continue. */
test("a held batch fails its group before opening anything and the next group runs", async () => {
  const h = harness({ resumed: true, held: { "sandcastle/batch-42-old": "/owner/hand fix" }, dirty: [1] });
  await assert.rejects(runGroup(h.ports, options, group), /Skipping group sandcastle:42.*sandcastle\/batch-42-old.*\/owner\/hand fix/);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.branches, []);
  const next = harness();
  assert.equal(await runGroup(next.ports, options, { ...group, id: "43" }), true);
  assert.deepEqual(next.opened, ["sandcastle/batch-43-1234"]);
});

/** A held issue never reaches an agent, a save, or prior-work pickup, while its sibling runs. */
test("a held issue is excluded without attempts and the remaining work stays draft", async () => {
  const h = harness({ held: { "sandcastle/issue-1": "/owner/issue fix" }, dirty: [1], ready: [1] });
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.deepEqual(h.started, ["2"]);
  assert.deepEqual(h.saved, []);
  assert.match(h.warnings.join("\n"), /Skipping #1.*sandcastle\/issue-1.*\/owner\/issue fix/);
  assert.match(h.creates[0].body, /Closes #2: Second/);
  assert.doesNotMatch(h.creates[0].body, /Closes #1/);
  assert.match(h.creates[0].body, /#1: First \(checked out in foreign worktree \/owner\/issue fix\)/);
  assert.doesNotMatch(h.creates[0].body, /ran out of attempts/);
  assert.deepEqual(h.readied, []);
  assert.deepEqual(h.writeups, []);
});

/** A group with every issue held starts no agents and publishes nothing. */
test("a group with all issue branches held spends no attempts", async () => {
  const h = harness({ held: { "sandcastle/issue-1": "/owner/one", "sandcastle/issue-2": "/owner/two" } });
  assert.equal(await runGroup(h.ports, options, group), false);
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.creates, []);
  assert.match(h.warnings.join("\n"), /\/owner\/one/);
  assert.match(h.warnings.join("\n"), /\/owner\/two/);
});

/**
 * Point a harness at its own GitHub access over a fake clock, so a 30-minute
 * outage is observable without waiting one. The clock moves only when the
 * policy sleeps, which makes `clock.ms === 0` mean "still in the outage".
 */
function fakeOutage(h: ReturnType<typeof harness>, reachable: (elapsedMs: number) => boolean) {
  const clock = { ms: 0 };
  const access = createGitHubAccess({
    now: () => clock.ms,
    sleep: async (ms) => { clock.ms += ms; },
    reachable: () => reachable(clock.ms),
    log: (message) => { h.ports.log(message); },
  });
  h.ports.githubCall = access.run;
  return { clock, access };
}

/** Concurrent freshness calls share one fake-clock outage before the group publishes (#1260). */
test("concurrent group GitHub calls wait together and publish after recovery", async () => {
  const h = harness();
  const { clock } = fakeOutage(h, () => true);
  let failures = 0;
  h.ports.github.isIssueOpen = async () => {
    if (clock.ms === 0) { failures++; throw new Error("error connecting to api.github.com"); }
    return true;
  };
  assert.equal(await runGroup(h.ports, options, group), true);
  assert.equal(clock.ms, 60_000);
  assert.equal(failures, 2);
  assert.equal(h.waits, 1);
  assert.equal(h.creates.length, 1);
});

/** A startup board read uses the same policy as a group's GitHub calls (#1260). */
for (const recovers of [true, false]) {
  test(`startup board ${recovers ? "recovers and runs" : "ends as a network stop"}`, async () => {
    const h = harness();
    const { clock, access } = fakeOutage(h, () => recovers);
    /** Model the GitHub board port used before any group or sandbox exists. */
    const board = () => {
      if (!recovers || clock.ms === 0) throw new Error("error connecting to api.github.com");
      return group;
    };
    const run = async () => runGroup(h.ports, options, await access.run(board));
    if (recovers) {
      assert.equal(await run(), true);
      assert.equal(h.creates.length, 1);
      assert.equal(clock.ms, 60_000);
    } else {
      await assert.rejects(run(), (error) => error instanceof RunFatalError && error.kind === "network");
      assert.equal(clock.ms, 30 * 60_000);
      assert.deepEqual(h.opened, []);
      assert.deepEqual(h.pushes, []);
    }
    assert.equal(h.waits, 1);
  });
}

/** Each GitHub operation in the group lifecycle must recover through the same policy. */
for (const operation of ["fetch", "catch-up", "merged heads", "merged PR", "find", "create", "edit", "ready"] as const) {
  /** Fail a single external operation until the fake clock reaches recovery. */
  test(`${operation} waits for GitHub before publishing`, async () => {
    const h = harness({ existingPr: operation === "edit" ? "https://example.test/pr/7" : undefined });
    const { clock } = fakeOutage(h, () => true);
    /** Simulate an unreachable port and delegate to its normal behavior once Wi-Fi returns. */
    function offline<T>(call: () => T): T {
      if (clock.ms === 0) throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("fatal: Could not resolve host: github.com") });
      return call();
    }
    if (operation === "fetch") h.ports.git.fetchBase = () => offline(() => {});
    if (operation === "catch-up") h.ports.git.catchUp = () => offline(() => "no-remote" as const);
    if (operation === "merged heads") h.ports.github.mergedPrHeads = () => offline(() => []);
    if (operation === "merged PR") h.ports.github.mergedPr = async () => offline(() => undefined);
    if (operation === "find") h.ports.github.openPr = async () => offline(() => undefined);
    if (operation === "create") h.ports.github.createDraftPr = async (pr) => offline(() => { h.creates.push(pr); });
    if (operation === "edit") h.ports.github.editPr = async (pr) => offline(() => { h.edits.push(pr); });
    if (operation === "ready") h.ports.github.readyPr = async (head) => offline(() => { h.readied.push(head); });
    assert.equal(await runGroup(h.ports, options, group), true);
    assert.equal(clock.ms, 60_000);
    assert.equal(h.waits, 1);
    assert.equal(h.creates.length + h.edits.length, 1);
    assert.deepEqual(h.readied, ["sandcastle/batch-42-1234"]);
    assert.deepEqual(h.closed, h.opened);
  });
}

/** A permanent outage in PR publication stops the whole run and preserves its local work. */
test("a PR outage exhausts one shared budget and raises a network ending", async () => {
  const h = harness();
  const { clock } = fakeOutage(h, () => false);
  h.ports.github.createDraftPr = async () => { throw new Error("error connecting to api.github.com"); };
  await assert.rejects(runGroup(h.ports, options, group), (error) => error instanceof RunFatalError && error.kind === "network");
  assert.equal(clock.ms, 30 * 60_000);
  assert.deepEqual(h.creates, []);
  assert.deepEqual(h.readied, []);
  assert.deepEqual(h.closed, h.opened);
});

/** Refresh shares normal publication's recovery policy and network ending. */
for (const recovers of [true, false]) {
  /** Keep a failed refresh local until its push can reach GitHub. */
  test(`refresh push ${recovers ? "recovers" : "stops as network"}`, async () => {
    const h = harness({ resumed: true, recovered: recovers,
      pushFailures: [new Error("fatal: Failed to connect to github.com port 443")] });
    const run = () => refreshBranch({
      ...h.ports,
      git: { ...h.ports.git, isBehindBase: () => true },
      prTitle: async () => "Batch title",
    }, options, "sandcastle/batch-42-old");
    if (recovers) assert.equal(await run(), true);
    else await assert.rejects(run(), (error) => error instanceof RunFatalError && error.kind === "network");
    assert.equal(h.waits, 1);
    assert.equal(h.pushes.length, recovers ? 2 : 1);
    assert.deepEqual(h.closed, h.opened);
  });
}

/** An issue agent and a host PR call that lose GitHub together share the same wait (#1260). */
test("agent and host outages share the deadline and network stop", async () => {
  const h = harness();
  const { clock, access } = fakeOutage(h, () => false);
  h.ports.github.isIssueOpen = async () => { throw new Error("error connecting to api.github.com"); };
  const [host, agent] = await Promise.allSettled([runGroup(h.ports, options, group), access.wait()]);
  assert.equal(host.status, "rejected");
  if (host.status === "rejected") {
    assert.ok(host.reason instanceof RunFatalError);
    assert.equal(host.reason.kind, "network");
  }
  assert.deepEqual(agent, { status: "fulfilled", value: false });
  assert.equal(clock.ms, 30 * 60_000);
  assert.equal(h.waits, 1);
  assert.deepEqual(h.opened, []);
});
