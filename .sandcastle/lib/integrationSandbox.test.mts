// Fake-driven tests for the integration branch's pipeline: no Docker, no quota.
//
// Each test builds a throwaway repo with the batch and issue branches the step
// would meet, and asserts which agents started and what was logged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { antigravity } from "./antigravity.mts";
import { withCheckSlot } from "./checkSlots.mts";
import { ciHasPassedBase } from "./ciGreen.mts";
import { markDone, markPrWritten } from "./gitFacts.mts";
import { buildPrBody } from "./groups.mts";
import {
  IntegrationSandbox,
  type IntegrationSandboxPort,
  type IntegrationSandboxPorts,
} from "./integrationSandbox.mts";
import { BranchStateError, RunFatalError } from "./issueLoop.mts";
import { rolePlan } from "./rolePlan.mts";
import { openRunState, type RunState } from "./runState.mts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

const BRANCH = "sandcastle/batch-test";

/** A throwaway repo with an initial commit, checked out on the batch branch. */
function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "integrationsandbox-test-"));
  git(dir, ["init", "--initial-branch=main", "--quiet"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "root\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "root", "--quiet"]);
  git(dir, ["checkout", "-b", BRANCH, "--quiet"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function commitFile(cwd: string, name: string, contents: string, message: string): void {
  writeFileSync(join(cwd, name), contents);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message, "--quiet"]);
}

/**
 * The repo itself standing in for the sandbox: every check passes, and each
 * agent is recorded by name rather than run. `onRun` leaves behind whatever
 * the real agent would have committed.
 */
function fakeSandbox(dir: string, onRun?: () => void) {
  const started: string[] = [];
  const port: IntegrationSandboxPort = {
    worktreePath: dir,
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async run(request) {
      started.push(request.name);
      onRun?.();
      if (request.name === "merger") {
        return { iterations: [], stdout: "Merge resolved\n<promise>COMPLETE</promise>" };
      }
      return {
        iterations: [],
        stdout: "<pr-title>Draft the PR\nfrom the diff</pr-title>\n<pr-body>\n## Summary\n\nFreshly drafted PR body\n</pr-body>\n<promise>COMPLETE</promise>",
      };
    },
    async close() {},
  };
  return { port, started };
}

function integrationSandbox(
  dir: string,
  port: IntegrationSandboxPort,
  extra: {
    log?: (message: string) => void;
    runState?: RunState;
    agy?: boolean;
    refreshDepsCommand?: string;
    withCheckSlot?: IntegrationSandboxPorts["withCheckSlot"];
    ciHasPassedBase?: IntegrationSandboxPorts["ciHasPassedBase"];
    recordRoleUsage?: IntegrationSandboxPorts["recordRoleUsage"];
  } = {},
) {
  return new IntegrationSandbox(
    BRANCH,
    {
      openSandbox: async () => port,
      agentFor: ({ model }) => antigravity(model),
      withCheckSlot: extra.withCheckSlot ?? ((work) => work()),
      ciHasPassedBase: extra.ciHasPassedBase ?? (() => false),
      runState: extra.runState ?? openRunState(join(dir, "runstate")),
      recordRoleUsage: extra.recordRoleUsage ?? (() => {}),
    },
    {
      cwd: dir,
      baseRef: "main",
      refreshDepsCommand: extra.refreshDepsCommand,
      check: { command: "true", label: "make test && make lint", tailChars: 6000 },
      prompts: { merge: "merge-prompt.md", pr: "pr-prompt.md" },
      rolePlan: rolePlan(extra.agy ? { merger: "agy", prWriter: "agy" } : {}),
      log: extra.log,
    },
  );
}

/** Reuse a persisted verdict across sandboxes without taking another slot. */
test("integration reuses persisted clean-tree success", async () => {
  const { dir, cleanup } = makeRepo();
  const statePath = join(dir, ".git", "runstate");
  const { port } = fakeSandbox(dir);
  const commands: string[] = [];
  port.exec = async (command) => {
    commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  let slots = 0;
  const slot: IntegrationSandboxPorts["withCheckSlot"] = async (work) => {
    slots++;
    return work();
  };
  try {
    const first = integrationSandbox(dir, port, { runState: openRunState(statePath), withCheckSlot: slot });
    await first.assertGreen();
    await first.assertGreen();
    const logs: string[] = [];
    await integrationSandbox(dir, port, {
      runState: openRunState(statePath),
      withCheckSlot: slot,
      log: (message) => logs.push(message),
    }).assertGreen();
    assert.deepEqual(commands, ["true"]);
    assert.equal(slots, 1);
    assert.ok(logs.some((message) => message.includes("already passed")));
  } finally {
    cleanup();
  }
});

/** Keep dirty work out of persisted reuse even when HEAD has a green verdict. */
test("integration checks dirty trees without remembering them or consulting CI", async () => {
  const { dir, cleanup } = makeRepo();
  const statePath = join(dir, ".git", "runstate");
  const tree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  const state = openRunState(statePath);
  const { port } = fakeSandbox(dir);
  let checks = 0;
  port.exec = async () => {
    checks++;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  try {
    writeFileSync(join(dir, "README.md"), "dirty\n");
    const extra = { runState: state, ciHasPassedBase: () => assert.fail("dirty work cannot reuse CI") };
    await integrationSandbox(dir, port, extra).assertGreen();
    assert.equal(openRunState(statePath).isGreenTree(tree), false);
    state.recordGreenTree(tree);
    await integrationSandbox(dir, port, extra).assertGreen();
    assert.equal(checks, 2);
  } finally {
    cleanup();
  }
});

/** Preserve integration-only CI evidence and record it for later sandboxes. */
test("integration records a clean tree accepted by its CI lookup", async () => {
  const { dir, cleanup } = makeRepo();
  const statePath = join(dir, ".git", "runstate");
  const tree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  const { port } = fakeSandbox(dir);
  port.exec = async () => assert.fail("CI evidence should skip execution");
  try {
    await integrationSandbox(dir, port, {
      runState: openRunState(statePath),
      ciHasPassedBase: (candidate) => {
        assert.equal(candidate, tree);
        return true;
      },
      withCheckSlot: async () => assert.fail("CI evidence should skip the slot"),
    }).assertGreen();
    assert.equal(openRunState(statePath).isGreenTree(tree), true);
  } finally {
    cleanup();
  }
});

for (const verdict of ["green", "failure", "race-then-green", "repeated-race"] as const) {
  /** Exercise retries, failure tails, and persisted verdicts through integration checks. */
  test(`integration check attempts: ${verdict}`, async () => {
    const { dir, cleanup } = makeRepo();
    const statePath = join(dir, ".git", "runstate");
    const slotsDir = join(dir, ".git", "slots");
    const tree = git(dir, ["rev-parse", "HEAD^{tree}"]);
    const { port } = fakeSandbox(dir);
    const logs: string[] = [];
    let attempts = 0;
    let slots = 0;
    const race = { exitCode: 1, stdout: "", stderr: "npm error code ENOTEMPTY\n" };
    port.exec = async (command) => {
      assert.equal(command, "true");
      assert.equal(existsSync(join(slotsDir, "slot-0")), true);
      attempts++;
      if (verdict === "repeated-race" || (verdict === "race-then-green" && attempts === 1)) return race;
      if (verdict === "failure") return { exitCode: 1, stdout: "DISCARD" + "x".repeat(7000), stderr: "FAILURE END" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      const integration = integrationSandbox(dir, port, {
        runState: openRunState(statePath),
        log: (message) => logs.push(message),
        withCheckSlot: (work) => {
          assert.equal(existsSync(join(slotsDir, "slot-0")), false);
          slots++;
          return withCheckSlot(slotsDir, work, { slots: 1, pollMs: 1 });
        },
      });
      const success = verdict === "green" || verdict === "race-then-green";
      if (success) await integration.assertGreen();
      else {
        await assert.rejects(integration.assertGreen(), (error: Error) => {
          assert.ok(error.message.includes(verdict === "failure" ? "FAILURE END" : "ENOTEMPTY"));
          assert.ok(!error.message.includes("DISCARD"));
          return true;
        });
      }
      assert.equal(attempts, verdict.includes("race") ? 2 : 1);
      assert.equal(slots, attempts);
      assert.equal(existsSync(join(slotsDir, "slot-0")), false);
      assert.equal(openRunState(statePath).isGreenTree(tree), success);
      assert.equal(logs.filter((message) => message.includes("npm cache race")).length, verdict.includes("race") ? 1 : 0);
      if (!success) {
        await assert.rejects(integration.assertGreen());
        assert.equal(attempts, verdict === "failure" ? 2 : 4);
      }
    } finally {
      cleanup();
    }
  });
}

// --- the merger ----------------------------------------------------------

/** Pins that an issue already merged costs no merger run, and says so once (#995). */
test("when an issue's merge is already on the integration branch, the merger agent never starts for it, and the skip is logged", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const logs: string[] = [];
    const { port, started } = fakeSandbox(dir);
    // #42's Done marker for this batch is reachable from it: the merge happened.
    markDone(dir, 42, BRANCH);

    const integration = integrationSandbox(dir, port, { log: (message) => logs.push(message) });
    await integration.merge([{ id: "42", title: "Issue 42", branch: "sandcastle/issue-42" }]);

    assert.deepEqual(started, []);
    assert.deepEqual(logs, [
      "Merger for #42 skipped — its merge is already on the integration branch.",
    ]);
  } finally {
    cleanup();
  }
});

/** Pins that an unmerged issue still reaches the merger when git cannot merge it alone. */
test("when an issue is not merged and conflicts, the merger agent does start", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, "conflict.txt", "batch version\n", "batch commit");

    const issueBranch = "sandcastle/issue-43";
    git(dir, ["checkout", "main", "--quiet"]);
    git(dir, ["checkout", "-b", issueBranch, "--quiet"]);
    commitFile(dir, "conflict.txt", "issue version\n", "issue commit");
    markDone(dir, 43, BRANCH);
    git(dir, ["checkout", BRANCH, "--quiet"]);

    const { port, started } = fakeSandbox(dir, () => {
      git(dir, ["merge", "--no-ff", "-Xtheirs", "-m", "merged by the merger", issueBranch]);
    });

    const integration = integrationSandbox(dir, port);
    await integration.merge([{ id: "43", title: "Issue 43", branch: issueBranch }]);

    assert.deepEqual(started, ["merger"]);
  } finally {
    cleanup();
  }
});

/** Pins that the merger starts on current dependencies and an idle allowance past a full test run (#1218's merger died in a silent `make test`). */
test("the merger agent starts after a dependency refresh, with an idle timeout past a full test run", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, "conflict.txt", "batch version\n", "batch commit");
    const issueBranch = "sandcastle/issue-44";
    git(dir, ["checkout", "main", "--quiet"]);
    git(dir, ["checkout", "-b", issueBranch, "--quiet"]);
    commitFile(dir, "conflict.txt", "issue version\n", "issue commit");
    markDone(dir, 44, BRANCH);
    git(dir, ["checkout", BRANCH, "--quiet"]);

    const order: string[] = [];
    let idle: number | undefined;
    const { port } = fakeSandbox(dir, () => {
      git(dir, ["merge", "--no-ff", "-Xtheirs", "-m", "merged by the merger", issueBranch]);
    });
    const exec = port.exec;
    const run = port.run;
    port.exec = async (command) => {
      if (command === "refresh-deps") order.push("refresh");
      return exec(command);
    };
    port.run = async (request) => {
      order.push(request.name);
      idle = request.idleTimeoutSeconds;
      return run(request);
    };

    const integration = integrationSandbox(dir, port, { refreshDepsCommand: "refresh-deps" });
    await integration.merge([{ id: "44", title: "Issue 44", branch: issueBranch }]);

    assert.deepEqual(order, ["refresh", "merger"]);
    assert.ok((idle ?? 0) >= 20 * 60);
  } finally {
    cleanup();
  }
});

/** Pin #1268: a second merger turn receives the latest failure and can finish the batch. */
test("a red check after the merger gets one more turn and records both runs' usage", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "main", "--quiet"]);
    commitFile(dir, "shipped.txt", "shipped\n", "main moved");
    git(dir, ["checkout", BRANCH, "--quiet"]);

    const { port, started } = fakeSandbox(dir);
    let checks = 0;
    port.exec = async () => {
      checks++;
      return checks < 3
        ? { exitCode: 1, stdout: `failure ${checks}`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    };
    const outputs: string[] = [];
    const run = port.run;
    port.run = async (request) => {
      outputs.push(request.promptArgs.CHECK_OUTPUT);
      return run(request);
    };
    const usage: string[] = [];
    const integration = integrationSandbox(dir, port, {
      recordRoleUsage: (role) => { usage.push(role); },
    });

    assert.equal(await integration.syncWithBase("- 1: Issue 1"), true);
    assert.deepEqual(started, ["merger", "merger"]);
    assert.deepEqual(outputs, ["failure 1\n", "failure 2\n"]);
    assert.deepEqual(usage, ["merger", "merger"]);
    await integration.assertGreen();
    assert.equal(checks, 3);
  } finally {
    cleanup();
  }
});

/** Pin #1268: persistent red checks stop at two paid merger runs and expose the latest failure. */
test("red checks after both merger turns throw the branch-state error with two runs recorded", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "main", "--quiet"]);
    commitFile(dir, "shipped.txt", "shipped\n", "main moved");
    git(dir, ["checkout", BRANCH, "--quiet"]);
    const { port, started } = fakeSandbox(dir);
    let checks = 0;
    port.exec = async () => ({ exitCode: 1, stdout: `failure ${++checks}`, stderr: "" });
    const usage: string[] = [];
    const integration = integrationSandbox(dir, port, {
      recordRoleUsage: (role) => { usage.push(role); },
    });

    await assert.rejects(integration.syncWithBase("- 1: Issue 1"), (error) => {
      assert.ok(error instanceof BranchStateError);
      assert.match(error.message, /resolve it by hand/);
      assert.match(error.message, /failure 3/);
      return true;
    });
    assert.deepEqual(started, ["merger", "merger"]);
    assert.deepEqual(usage, ["merger", "merger"]);
    assert.equal(checks, 3);
  } finally {
    cleanup();
  }
});

/** Pin #1268: an unfinished merge stops immediately even when its check is red. */
test("an unmerged branch after the first merger turn gets no second turn", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, "conflict.txt", "batch\n", "batch changed");
    git(dir, ["checkout", "main", "--quiet"]);
    commitFile(dir, "conflict.txt", "main\n", "main changed");
    const pinned = git(dir, ["rev-parse", "main"]);
    git(dir, ["checkout", BRANCH, "--quiet"]);
    const { port, started } = fakeSandbox(dir);
    port.exec = async () => ({ exitCode: 1, stdout: "still red", stderr: "" });

    await assert.rejects(integrationSandbox(dir, port).syncWithBase("- 1: Issue 1"), (error) => {
      assert.ok(error instanceof BranchStateError);
      assert.ok(error.message.includes(`Still unmerged: main (${pinned.slice(0, 8)})`));
      return true;
    });
    assert.deepEqual(started, ["merger"]);
  } finally {
    cleanup();
  }
});

for (const kind of ["quota", "auth", "network"] as const) {
  /** Pin #1268: a run-fatal stop in the retry cannot become a branch-state failure. */
  test(`a ${kind} stop thrown in the second merger turn rethrows`, async () => {
    const { dir, cleanup } = makeRepo();
    try {
      git(dir, ["checkout", "main", "--quiet"]);
      commitFile(dir, "shipped.txt", "shipped\n", "main moved");
      git(dir, ["checkout", BRANCH, "--quiet"]);
      const stop = new RunFatalError(kind, "second merger stopped");
      const { port, started } = fakeSandbox(dir, () => {
        if (started.length === 2) throw stop;
      });
      let checks = 0;
      port.exec = async () => {
        checks++;
        return { exitCode: 1, stdout: "still red", stderr: "" };
      };

      await assert.rejects(integrationSandbox(dir, port).syncWithBase("- 1: Issue 1"), (error) => error === stop);
      assert.deepEqual(started, ["merger", "merger"]);
      assert.equal(checks, 2);
    } finally {
      cleanup();
    }
  });
}

/** Pin #1268: quota output in a returned second run stops before another check, after usage is recorded. */
test("a quota stop in the second merger's output rethrows and records both runs", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "main", "--quiet"]);
    commitFile(dir, "shipped.txt", "shipped\n", "main moved");
    git(dir, ["checkout", BRANCH, "--quiet"]);
    const { port, started } = fakeSandbox(dir);
    const run = port.run;
    port.run = async (request) => {
      const result = await run(request);
      return started.length === 2
        ? { ...result, stdout: "Claude AI usage limit reached|1700000000" }
        : result;
    };
    let checks = 0;
    port.exec = async () => {
      checks++;
      return { exitCode: 1, stdout: "still red", stderr: "" };
    };
    const usage: string[] = [];
    const integration = integrationSandbox(dir, port, {
      recordRoleUsage: (role) => { usage.push(role); },
    });

    await assert.rejects(integration.syncWithBase("- 1: Issue 1"), (error) => {
      assert.ok(error instanceof RunFatalError);
      assert.equal(error.kind, "quota");
      return true;
    });
    assert.deepEqual(started, ["merger", "merger"]);
    assert.deepEqual(usage, ["merger", "merger"]);
    assert.equal(checks, 2);
  } finally {
    cleanup();
  }
});

// --- syncing with main ---------------------------------------------------

/**
 * Pins that main moving while the merger works does not fail its finished
 * merge: batch-1218's merger merged main, a fetch elsewhere then moved
 * origin/main on, and the live-ref check reported "Still unmerged".
 */
test("when main moves on while the merger resolves a sync conflict, the sync still succeeds against the main it started from", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, "conflict.txt", "batch version\n", "batch commit");
    git(dir, ["checkout", "main", "--quiet"]);
    commitFile(dir, "conflict.txt", "main version\n", "main commit");
    const mainAtStart = git(dir, ["rev-parse", "main"]);
    git(dir, ["checkout", BRANCH, "--quiet"]);

    const logs: string[] = [];
    const { port, started } = fakeSandbox(dir, () => {
      git(dir, ["merge", "--no-ff", "-Xtheirs", "-m", "merged by the merger", "main"]);
      // Another PR lands on main and is fetched before the merger finishes.
      git(dir, ["checkout", "main", "--quiet"]);
      commitFile(dir, "later.txt", "later\n", "later commit on main");
      git(dir, ["checkout", BRANCH, "--quiet"]);
    });

    const integration = integrationSandbox(dir, port, { log: (message) => logs.push(message) });
    assert.equal(await integration.syncWithBase("- 1: Issue 1"), true);

    const label = `main (${mainAtStart.slice(0, 8)})`;
    assert.deepEqual(started, ["merger"]);
    assert.ok(logs.includes(`  ${label} (in conflict.txt) conflicts — handing it to the merger agent`));
    assert.ok(logs.includes(`${BRANCH} is up to date with ${label}.`));
  } finally {
    cleanup();
  }
});

// --- merging the pushed copy ---------------------------------------------

/** Makes `origin/BRANCH` point at the commit `from`, with no real remote. */
function setRemoteCopy(dir: string, from: string): void {
  git(dir, ["update-ref", `refs/remotes/origin/${BRANCH}`, from]);
}

/**
 * Pins the batch-1071 failure: a fix pushed by hand while the local branch
 * held its own commits left both sides ahead, and the group was abandoned.
 */
test("a branch that diverged from its pushed copy merges it in without the merger when the files do not conflict", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const base = git(dir, ["rev-parse", "HEAD"]);
    commitFile(dir, "pushed.txt", "pushed\n", "pushed by hand");
    setRemoteCopy(dir, "HEAD");
    git(dir, ["reset", "--hard", base, "--quiet"]);
    commitFile(dir, "local.txt", "local\n", "local work");

    const { port, started } = fakeSandbox(dir);
    const integration = integrationSandbox(dir, port);
    assert.equal(await integration.mergeRemoteCopy("- 1: Issue 1"), true);

    assert.deepEqual(started, []);
    git(dir, ["merge-base", "--is-ancestor", `origin/${BRANCH}`, "HEAD"]);
  } finally {
    cleanup();
  }
});

test("a branch that diverged from its pushed copy hands conflicting files to the merger agent", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const base = git(dir, ["rev-parse", "HEAD"]);
    commitFile(dir, "fix.txt", "pushed fix\n", "pushed fix");
    setRemoteCopy(dir, "HEAD");
    git(dir, ["reset", "--hard", base, "--quiet"]);
    commitFile(dir, "fix.txt", "local fix\n", "local fix");

    const logs: string[] = [];
    const { port, started } = fakeSandbox(dir, () => {
      git(dir, ["merge", "--no-ff", "-Xtheirs", "-m", "merged by the merger", `origin/${BRANCH}`]);
    });
    const integration = integrationSandbox(dir, port, { log: (message) => logs.push(message) });
    assert.equal(await integration.mergeRemoteCopy("- 1: Issue 1"), true);

    assert.deepEqual(started, ["merger"]);
    assert.ok(logs.some((line) => line.includes("(in fix.txt) conflicts — handing it to the merger agent")));
  } finally {
    cleanup();
  }
});

/**
 * Pins the batch-1175 failure: while the run worked, GitHub's "Update branch"
 * merged the same main commit into the pushed copy that the run had merged
 * locally. The trees match, so the two merges combine without the merger.
 */
test("a pushed copy that merged the same base commit mid-run is merged in without the merger", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const base = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "--quiet", "-b", "main-moved"]);
    commitFile(dir, "shipped.txt", "shipped\n", "shipped on main");
    const main = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "--quiet", BRANCH]);
    git(dir, ["reset", "--hard", base, "--quiet"]);

    git(dir, ["merge", "--no-ff", "--quiet", "-m", "Merge branch 'main' (GitHub)", main]);
    setRemoteCopy(dir, "HEAD");
    git(dir, ["reset", "--hard", base, "--quiet"]);
    git(dir, ["merge", "--no-ff", "--quiet", "-m", "Merge main (run)", main]);
    commitFile(dir, "body.txt", "PR body\n", "Sandcastle: PR body complete");

    const { port, started } = fakeSandbox(dir);
    const integration = integrationSandbox(dir, port);
    assert.equal(await integration.mergeRemoteCopy("- 1: Issue 1"), true);

    assert.deepEqual(started, []);
    git(dir, ["merge-base", "--is-ancestor", `origin/${BRANCH}`, "HEAD"]);
  } finally {
    cleanup();
  }
});

test("a branch with no pushed copy, or one level with it, is left alone", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { port, started } = fakeSandbox(dir);
    const integration = integrationSandbox(dir, port);
    assert.equal(await integration.mergeRemoteCopy("- 1: Issue 1"), false);
    setRemoteCopy(dir, "HEAD");
    assert.equal(await integration.mergeRemoteCopy("- 1: Issue 1"), false);
    assert.deepEqual(started, []);
  } finally {
    cleanup();
  }
});

// --- the check -----------------------------------------------------------

/** Pins that a check lost to another sandbox's npm install is re-run, not reported red. */
test("an integration check that died on an npm cache race is re-run once, and the branch counts as green", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const logs: string[] = [];
    const { port } = fakeSandbox(dir);
    let checks = 0;
    port.exec = async () => {
      checks++;
      return checks === 1
        ? { exitCode: 1, stdout: "npm error code EEXIST\nnpm error path /home/agent/.npm/_cacache\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    };

    const integration = integrationSandbox(dir, port, { log: (message) => logs.push(message) });
    await integration.assertGreen();

    assert.equal(checks, 2);
    assert.ok(logs.includes(`${BRANCH} lost an npm cache race with another sandbox — checking again.`));
  } finally {
    cleanup();
  }
});

/** Prevent a later commit's green CI from authorizing the original base tree (#1247). */
test("moving the base ref between reads cannot reuse another commit's successful CI", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const original = git(dir, ["rev-parse", "main"]);
    commitFile(dir, "later.txt", "later\n", "later base");
    const later = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["reset", "--hard", original]);
    const { port } = fakeSandbox(dir);
    let checks = 0;
    port.exec = async () => {
      checks++;
      return { exitCode: 1, stdout: "sandbox check failed", stderr: "" };
    };
    const queried: string[] = [];
    const integration = integrationSandbox(dir, port, {
      ciHasPassedBase: (tree) => ciHasPassedBase(tree, "main", (command) => {
        if (command.startsWith("git ")) {
          const result = git(dir, command.split(" ").slice(1));
          if (command.endsWith("^{tree}")) git(dir, ["update-ref", "refs/heads/main", later]);
          return result;
        }
        queried.push(command);
        return JSON.stringify({ check_runs: [{
          name: "check", status: "completed",
          conclusion: command.includes(later) ? "success" : "failure",
        }] });
      }),
    });

    await assert.rejects(integration.assertGreen(), /sandbox check failed/);
    assert.equal(checks, 1);
    assert.deepEqual(queried, [`gh api repos/{owner}/{repo}/commits/${original}/check-runs`]);
    assert.equal(git(dir, ["rev-parse", "main"]), later);
  } finally {
    cleanup();
  }
});

/** Keep CI reuse restricted to clean matching trees with usable successful evidence. */
test("integration CI reuse falls back to the sandbox unless all evidence qualifies", async (t) => {
  const cases = ["success", "different tree", "dirty", "missing commit", "missing tree",
    "missing CI", "malformed CI", "pending CI", "failed CI"];
  for (const scenario of cases) {
    await t.test(scenario, async () => {
      const { dir, cleanup } = makeRepo();
      try {
        if (scenario === "different tree") commitFile(dir, "extra.txt", "extra\n", "batch change");
        if (scenario === "dirty") writeFileSync(join(dir, "README.md"), "dirty\n");
        const { port } = fakeSandbox(dir);
        let checks = 0;
        port.exec = async () => {
          checks++;
          return { exitCode: 0, stdout: "", stderr: "" };
        };
        const integration = integrationSandbox(dir, port, {
          ciHasPassedBase: (tree) => ciHasPassedBase(tree, "main", (command) => {
            if (command.startsWith("git ")) {
              if (scenario === "missing commit" && command.endsWith("^{commit}")) return undefined;
              if (scenario === "missing tree" && command.endsWith("^{tree}")) return undefined;
              return git(dir, command.split(" ").slice(1));
            }
            if (scenario === "missing CI") return undefined;
            if (scenario === "malformed CI") return "not JSON";
            return JSON.stringify({ check_runs: [{
              name: "check",
              status: scenario === "pending CI" ? "in_progress" : "completed",
              conclusion: scenario === "failed CI" ? "failure" : "success",
            }] });
          }),
        });
        await integration.assertGreen();
        assert.equal(checks, scenario === "success" ? 0 : 1);
      } finally {
        cleanup();
      }
    });
  }
});

// --- the PR writer -------------------------------------------------------

/** Pins that a current PR body costs no writer run, and is handed on as it stands (#995). */
test("when the PR body is recorded for the integration branch's current commit, the PR writer agent never starts, and the skip is logged", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const logs: string[] = [];
    const { port, started } = fakeSandbox(dir);
    markPrWritten(dir, BRANCH, { body: "## Summary\n\nAlready written PR body." });

    const integration = integrationSandbox(dir, port, { log: (message) => logs.push(message) });
    const body = await integration.writePr("- 42: Issue 42").then((pr) => pr?.body);

    assert.deepEqual(started, []);
    assert.equal(body, "## Summary\n\nAlready written PR body.");
    assert.deepEqual(logs, ["PR writer skipped — its PR body is still current."]);
  } finally {
    cleanup();
  }
});

/** Pins that a commit after the recorded body sends the step back to the writer (#995). */
test("when a commit landed on the integration branch after the PR body was written, the PR writer does start", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const logs: string[] = [];
    const { port, started } = fakeSandbox(dir);
    markPrWritten(dir, BRANCH, { body: "## Summary\n\nOld body." });
    commitFile(dir, "extra.txt", "extra content\n", "a later commit");

    const integration = integrationSandbox(dir, port, { log: (message) => logs.push(message) });
    const body = await integration.writePr("- 42: Issue 42").then((pr) => pr?.body);

    assert.deepEqual(started, ["pr-writer"]);
    assert.equal(body, "## Summary\n\nFreshly drafted PR body");
    assert.equal(logs.some((message) => message.includes("skipped")), false);
  } finally {
    cleanup();
  }
});

/** Pins that the writer's title and body are recorded, so the next run skips it instead of rewriting them. */
test("a written PR title and body are recorded, and the next run reuses them", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { port, started } = fakeSandbox(dir);
    const written = { title: "Draft the PR from the diff", body: "## Summary\n\nFreshly drafted PR body" };
    assert.deepEqual(await integrationSandbox(dir, port).writePr("- 42: Issue 42"), written);
    assert.deepEqual(await integrationSandbox(dir, port).writePr("- 42: Issue 42"), written);
    assert.deepEqual(started, ["pr-writer"]);
  } finally {
    cleanup();
  }
});

// --- the labels a skipped step keeps -------------------------------------

/** Pins that a run which skips both batch steps still credits the agents that ran them (#995). */
test("the earlier merger and PR-writer labels are kept in the run report and PR body", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const runState = openRunState(join(dir, "runstate"));
    const label = rolePlan({ merger: "agy", prWriter: "agy" }).merger.label;
    runState.recordBatchRole("merger", label);
    runState.recordBatchRole("pr-writer", label);

    // The second run finds both steps' results current.
    markDone(dir, 42, BRANCH);
    markPrWritten(dir, BRANCH, { body: "## Summary\n\nPreserved writeup" });

    const { port, started } = fakeSandbox(dir);
    const integration = integrationSandbox(dir, port, { runState, agy: true });
    await integration.merge([{ id: "42", title: "Issue 42", branch: "sandcastle/issue-42" }]);
    const writeup = await integration.writePr("- 42: Issue 42").then((pr) => pr?.body);

    assert.deepEqual(started, []);
    assert.equal(runState.batchRole("merger"), label);
    assert.equal(runState.batchRole("pr-writer"), label);

    const prBody = buildPrBody({
      group: { id: "solo-42", parentIssue: undefined, issues: [] },
      mergedIssues: [{ id: "42", title: "Issue 42" }],
      blockedIssues: [],
      complete: true,
      writeup,
      merger: runState.batchRole("merger"),
      prWriter: runState.batchRole("pr-writer"),
    });
    assert.ok(prBody.includes(`Merged by ${label}`));
    assert.ok(prBody.includes(`PR body written by ${label}`));
    assert.ok(prBody.includes("Preserved writeup"));
  } finally {
    cleanup();
  }
});

/** Integration checks refresh broken dependencies before blaming the branch (#1267). */
test("an integration check repairs installed dependencies and counts the branch as green", async () => {
  const { dir, cleanup } = makeRepo();
  const { port, started } = fakeSandbox(dir);
  const commands: string[] = [];
  port.exec = async (command) => {
    commands.push(command);
    return commands.length === 1
      ? { exitCode: 1, stdout: "", stderr: "  code: 'ERR_MODULE_NOT_FOUND'" }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
  try {
    await integrationSandbox(dir, port, { refreshDepsCommand: "REFRESH" }).assertGreen();
    assert.deepEqual(commands, ["true", "REFRESH", "true"]);
    assert.deepEqual(started, []);
  } finally {
    cleanup();
  }
});
