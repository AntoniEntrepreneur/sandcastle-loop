// Run one group from branch resolution through publication behind external ports.

import { batchBranchGlob, batchBranchName, buildPrBody, buildPrTitle, describeGroup,
  isGroupComplete, issueBranchName, issueNumberOfBranch, liveBlockers,
  type Group, type Issue } from "./groups.mts";
import { commandErrorText, pushFailure } from "./commandOutput.mts";
import { RunFatalError } from "./issueLoop.mts";
import type { GitHubCall } from "./githubAccess.mts";
import type { IssueBranch, CatchUp } from "./gitFacts.mts";
import type { IntegrationSandbox } from "./integrationSandbox.mts";
import type { BlockedIssue, GroupPlan, GroupQueuePorts, GroupQueueResult, QueueIssue } from "./groupQueue.mts";

/** The integration operations a group owns until it closes the sandbox. */
export type GroupIntegration = Pick<IntegrationSandbox,
  "branch" | "mergeRemoteCopy" | "syncWithBase" | "merge" | "assertGreen" | "writePr" | "close">;

/** A PR's editable fields, passed as values rather than shell text. */
export type GroupPr = { head: string; title: string; body: string };

/** The merged PR and the original head it shipped, including for squash merges. */
export type MergedGroupPr = { number: number; url: string; headRefOid: string };

/** External facts and effects used by the group lifecycle. */
export interface GroupRunPorts {
  github: {
    isIssueOpen(number: number): Promise<boolean>;
    /** The title a human gave this issue. */
    issueTitle(number: number): Promise<string>;
    blockers(issue: Issue, isIssueOpen: (number: number) => Promise<boolean>): Promise<number[]>;
    mergedPrHeads(glob: string): string[] | Promise<string[]>;
    /** The already-merged PR for this head, or nothing when none has merged. */
    mergedPr(head: string): Promise<MergedGroupPr | undefined>;
    /** The open PR's url for this head, or nothing when it has none. */
    openPr(head: string): Promise<string | undefined>;
    editPr(pr: GroupPr): Promise<void>;
    createDraftPr(pr: GroupPr & { base: string }): Promise<void>;
    readyPr(head: string): Promise<void>;
  };
  git: {
    fetchBase(): void | Promise<void>;
    branchesMatching(glob: string): string[];
    isBatchBranchShipped(branch: string, mergedHeads: string[]): boolean;
    createBranch(branch: string, from: string, force?: boolean): void;
    /** Fast-forward a branch onto its pushed copy, reporting what that took. */
    catchUp(branch: string): CatchUp | Promise<CatchUp>;
    /** The checkout holding this branch outside the folder Sandcastle owns. */
    foreignWorktree(branch: string): string | undefined;
    doneIssues(branch: string): number[];
    worktreeExists(branch: string): boolean;
    worktreeIsDirty(branch: string): boolean;
    /** Commit whatever a worktree holds mid-edit. False when there was nothing to save. */
    saveWorktree(branch: string, issue: number): boolean;
    isStale(branch: string): boolean;
    resetWorktree(branch: string, from: string): void;
    commitsAhead(ref: string, branch: string): number;
    /** Compare the branch and base file trees, ignoring commit-only changes. */
    hasFileChanges(ref: string, branch: string): boolean;
    /** Commit summaries on the batch beyond the head shipped by a merged PR. */
    commitsSince(ref: string, branch: string): string[];
    readyToMerge(branch: string, issues: IssueBranch[]): string[];
    unfinishedBranches(branch: string, issues: IssueBranch[]): string[];
    resolveCommit(branch: string): string;
    resolveRemoteCommit(branch: string): string | undefined;
  };
  push(branch: string): Promise<void>;
  githubCall: GitHubCall;
  createIntegrationSandbox(branch: string): GroupIntegration;
  runQueue(ports: GroupQueuePorts, options: { integrationBranch: string }): Promise<GroupQueueResult>;
  workIssue(issue: QueueIssue, branch: string, signal: AbortSignal): ReturnType<GroupQueuePorts["workIssue"]>;
  clearSession(issue: number): void;
  prAttribution(): Pick<Parameters<typeof buildPrBody>[0], "implementers" | "reviewers" | "merger" | "prWriter">;
  integrationBranchSelected(branch: string): void;
  recordStranded(count: number): void;
  endTimeReached(): void;
  pastEndTime: GroupQueuePorts["pastEndTime"];
  sharedFailureStop: GroupQueuePorts["sharedFailureStop"];
  waitForGitHub: GroupQueuePorts["waitForGitHub"];
  now(): number;
  log(message: string): void;
  warn(message: string): void;
}

/** Run the existing group lifecycle with its effects supplied by the caller. */
export async function runGroup(
  ports: GroupRunPorts,
  options: { baseBranch: string; baseRef: string },
  group: Group,
): Promise<boolean> {
  const states = await Promise.all(group.issues.map(async (issue) =>
    [issue.number, await ports.githubCall(() => ports.github.isIssueOpen(issue.number))] as const,
  ));
  const openAtStart = new Map(states);
  /** Keep blocker checks consistent with this start while looking up outside issues live. */
  async function isOpenForPlan(number: number): Promise<boolean> {
    return openAtStart.get(number) ?? ports.githubCall(() => ports.github.isIssueOpen(number));
  }

  for (const issue of group.issues) {
    if (!openAtStart.get(issue.number)) {
      ports.log(`${describeGroup(group.id)}: dropping #${issue.number} — closed since the board was read.`);
    }
  }
  group = { ...group, issues: group.issues.filter((issue) => openAtStart.get(issue.number)) };
  if (group.issues.length === 0) {
    ports.log(`Skipping group ${describeGroup(group.id)}: no open issues remain. No branch, sandbox or PR opened.`);
    return false;
  }

  let availableIssues = group.issues;
  const heldIssues: BlockedIssue[] = [];
  let issueBranches: IssueBranch[] = group.issues.map((issue) => ({
    issueNumber: issue.number,
    branch: issueBranchName(issue.number),
  }));

  /**
   * Resume an unshipped batch branch of this group, or cut a fresh one.
   *
   * A run is resumable: a branch left by an earlier run is continued so its
   * work — and its PR — carry forward. A branch counts as shipped, and is
   * never resumed, once the base ref has it as an ancestor or once a PR with
   * that head branch has merged. The second case is what a squash merge
   * needs: it never makes the branch an ancestor of the base ref.
   */
  async function resolveIntegrationBranch(): Promise<string> {
    await ports.githubCall(() => ports.git.fetchBase());
    const glob = batchBranchGlob(group.id);
    const mergedPrHeads = await ports.githubCall(() => ports.github.mergedPrHeads(glob));
    const outstanding = ports.git.branchesMatching(glob).find(
      (branch) => !ports.git.isBatchBranchShipped(branch, mergedPrHeads),
    );

    if (outstanding) {
      const held = ports.git.foreignWorktree(outstanding);
      if (held) {
        throw new Error(`Skipping group ${describeGroup(group.id)}: ${outstanding} is checked out in foreign worktree ${held}.`);
      }
      ports.log(`\nResuming integration branch: ${outstanding}`);
      await catchUpIntegrationBranch(ports, outstanding);
      return outstanding;
    }

    const fresh = batchBranchName(group.id, ports.now());
    ports.git.createBranch(fresh, options.baseRef);
    ports.log(`\nCut integration branch: ${fresh}`);
    return fresh;
  }

  /**
   * Which of the group's issues the integration branch already covers.
   *
   * Driven by Done markers reachable from the integration branch, not by
   * ancestry or commit counts: an issue is merged once the orchestrator marked
   * it done, whether or not its branch produced a diff.
   */
  function resolveMergedIssues(integrationBranch: string): QueueIssue[] {
    const titles = new Map(group.issues.map((i) => [i.number, i.title]));

    return ports.git.doneIssues(integrationBranch)
      .filter((number) => titles.has(number))
      .map((number) => ({
        id: String(number),
        title: titles.get(number) ?? `Issue #${number}`,
        branch: issueBranchName(number),
      }))
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  /**
   * Commit whatever a killed process left mid-edit in the group's issue
   * worktrees, before Phase 0 even looks at them. Nothing else runs between a
   * Ctrl-C and the next invocation of Sandcastle, so this is the only point
   * that ever sees that dirt.
   */
  function saveDirtyWorktreesAtGroupStart(): void {
    for (const issue of availableIssues) {
      const branch = issueBranchName(issue.number);
      if (!ports.git.worktreeExists(branch)) continue;
      if (!ports.git.worktreeIsDirty(branch)) continue;

      if (ports.git.saveWorktree(branch, issue.number)) {
        ports.log(
          `Saved #${issue.number}: ${branch} was left dirty by an interrupted run.`,
        );
      }
    }
  }

  /**
   * Recreate an issue branch left pointing at content already on the base ref
   * — e.g. commits later squash-merged (#253, #258, #355, #356). Safe because
   * a stale branch holds nothing the base ref lacks.
   *
   * A dirty worktree is saved first rather than recreated out from under it:
   * the save gives the branch content of its own, so it is no longer stale —
   * it is kept, and called out by name here rather than left to the generic
   * "no Done marker yet" warning `warnAboutUnfinishedBranches` would otherwise
   * give it.
   */
  function recreateStaleBranches(
    planned: { id: string; branch: string }[],
    integrationBranch: string,
  ): void {
    for (const { id, branch } of planned) {
      if (ports.git.branchesMatching(branch).length === 0) continue;
      if (!ports.git.isStale(branch)) continue;

      if (ports.git.worktreeIsDirty(branch)) {
        if (ports.git.saveWorktree(branch, Number(id))) {
          ports.warn(
            `#${id}: ${branch} was stale AND mid-edit — saved its loose changes instead of recreating it. Kept, not deleted; it will look unfinished until this issue's implementer or reviewer finishes.`,
          );
        }
        continue;
      }

      // Git refuses `branch -f` on a branch checked out in a worktree, so a
      // clean worktree left by an interrupted run is moved from inside instead.
      if (ports.git.worktreeExists(branch)) {
        ports.git.resetWorktree(branch, integrationBranch);
      } else {
        ports.git.createBranch(branch, integrationBranch, true);
      }
      // A session saved against the old branch would resume into work that no longer exists.
      ports.clearSession(Number(id));
      ports.log(
        `#${id}: ${branch} was stale (its commits already reached ${options.baseBranch}, likely via a squash merge) — recreated from ${integrationBranch}.`,
      );
    }
  }

  /**
   * Report the group's work that is saved but not yet marked done.
   *
   * A branch lands here either because an implementer is still mid-issue, or
   * because it was interrupted before signalling completion — the save points
   * in gitFacts mean neither case loses work, so there is nothing to do by
   * hand. This just makes the omission loud at PR time.
   */
  function warnAboutUnfinishedBranches(integrationBranch: string): void {
    const unfinished = ports.git.unfinishedBranches(integrationBranch, issueBranches);
    if (unfinished.length === 0) return;

    ports.warn(
      `\n⚠️  ${describeGroup(group.id)}: ${unfinished.length} branch(es) hold saved work with no Done marker yet:\n`,
    );

    for (const branch of unfinished) {
      const ahead = ports.git.commitsAhead(integrationBranch, branch);
      const dirty = ports.git.worktreeIsDirty(branch);
      ports.warn(
        `  ${branch} — ${ahead} commit(s), ${dirty ? "currently mid-edit" : "idle, waiting for its implementer or reviewer to finish"}`,
      );
    }
    ports.warn(`\n  Nothing to do by hand — re-run Sandcastle and it will be continued.\n`);
  }

  /**
   * Merge this group's branches that a prior run finished but never merged —
   * "finished" meaning carrying a Done marker for this integration branch, not
   * merely carrying commits. A branch with agent commits but no marker is left
   * alone: it is unfinished, not ready, however far it got.
   */
  async function pickUpPriorWork(integration: GroupIntegration): Promise<void> {
    const ready = new Set(ports.git.readyToMerge(integration.branch, issueBranches));
    const pickedUp = availableIssues
      .map((issue) => ({
        id: String(issue.number),
        title: issue.title,
        branch: issueBranchName(issue.number),
      }))
      .filter(({ branch }) => ready.has(branch));

    if (pickedUp.length === 0) return;

    ports.log(`\nPicking up ${pickedUp.length} branch(es) from a prior run:`);
    for (const { id, title, branch } of pickedUp) {
      ports.log(`  ${id}: ${title} → ${branch}`);
    }

    await integration.merge(pickedUp);
    ports.log("\nPrior-run branches merged into integration branch.");
  }

  /**
   * Split the group's remaining issues into what can run now and what is
   * blocked, by checking each one deterministically rather than inferring a
   * dependency graph.
   *
   * `alreadyMerged` does double duty: it drops the issues this batch has
   * already done, and it satisfies blockers pointing at them, so a group whose
   * own members block each other drains as they merge instead of stalling on
   * issues GitHub will only close when the batch PR merges.
   */
  async function planGroup(alreadyMerged: number[]): Promise<GroupPlan> {
    const remaining = availableIssues.filter(
      (issue) => !alreadyMerged.includes(issue.number),
    );
    const blockers = await Promise.all(remaining.map(async (issue) => {
      try {
        return await ports.githubCall(() => ports.github.blockers(issue, isOpenForPlan));
      } catch (error) {
        if (error instanceof RunFatalError) throw error;
        const lookupError = commandErrorText(error);
        ports.log(`#${issue.number}: blocker lookup failed: ${lookupError}; keeping issue blocked until the next replan.`);
        return { lookupError };
      }
    }));

    const planned: QueueIssue[] = [];
    const blocked: BlockedIssue[] = [];

    for (const [i, issue] of remaining.entries()) {
      const answer = blockers[i]!;
      if (!Array.isArray(answer)) {
        blocked.push({ id: String(issue.number), title: issue.title, blockedBy: [], lookupError: answer.lookupError });
        continue;
      }
      const blockedBy = liveBlockers(answer, alreadyMerged);
      if (blockedBy.length > 0) {
        blocked.push({ id: String(issue.number), title: issue.title, blockedBy });
      } else {
        planned.push({
          id: String(issue.number),
          title: issue.title,
          branch: issueBranchName(issue.number),
        });
      }
    }

    return { planned, blocked };
  }

  /**
   * Push the group's batch and open or refresh its PR.
   *
   * Always a draft while work is outstanding: a partial batch is worth
   * publishing — the next run grows the same PR — but it is not worth anyone's
   * review yet. Once it is complete, the PR writer drafts the body a reviewer
   * reads.
   */
  async function publish(
    integration: GroupIntegration,
    complete: boolean,
    excluded: BlockedIssue[],
  ): Promise<boolean> {
    const integrationBranch = integration.branch;
    // Include any update made to the pushed copy while this run was working.
    await catchUpIntegrationBranch(ports, integrationBranch);
    await integration.mergeRemoteCopy(describeIssuesForMerge());

    if (!ports.git.hasFileChanges(options.baseRef, integrationBranch)) {
      ports.log(`\n${describeGroup(group.id)}: no file changes against ${options.baseBranch} in ${integrationBranch}. No PR opened; any existing PR left untouched.`);
      return false;
    }

    const mergedPr = await ports.githubCall(() => ports.github.mergedPr(integrationBranch));
    if (mergedPr) {
      ports.log(`\n${integrationBranch}: PR #${mergedPr.number} already merged (${mergedPr.url}). Nothing pushed; no PR opened.`);
      const localOnly = ports.git.commitsSince(mergedPr.headRefOid, integrationBranch);
      ports.log(localOnly.length > 0
        ? `Commits kept local-only since that merge:\n${localOnly.map((commit) => `  ${commit}`).join("\n")}`
        : "No local-only commits since that merge.");
      return false;
    }

    const mergedIssues = resolveMergedIssues(integrationBranch);
    const parent = group.parentIssue;
    const parentTitle = parent === undefined
      ? undefined
      : await ports.githubCall(() => ports.github.issueTitle(parent));
    const writeup = complete
      ? await integration.writePr(
          [
            ...(parentTitle === undefined ? [] : [`Parent spec #${parent}: ${parentTitle}`, ""]),
            ...mergedIssues.map((issue) => `- ${issue.id}: ${issue.title}`),
          ].join("\n"),
        )
      : undefined;
    const title = writeup?.title ?? buildPrTitle(group, mergedIssues, parentTitle);

    const local = ports.git.resolveCommit(integrationBranch);
    const pushed = ports.git.resolveRemoteCommit(integrationBranch);
    if (local === pushed) {
      ports.log(`\n${integrationBranch} is already on origin; nothing to push.`);
    } else {
      await pushWithGitHub(ports, integrationBranch);
    }
    const body = buildPrBody({
      group,
      mergedIssues,
      blockedIssues: excluded,
      complete,
      writeup: writeup?.body,
      ...ports.prAttribution(),
    });

    const existing = await ports.githubCall(() => ports.github.openPr(integrationBranch));
    if (existing) {
      await ports.githubCall(() => ports.github.editPr({ head: integrationBranch, title, body }));
      ports.log(`\nRefreshed PR for ${integrationBranch}: ${existing}`);
    } else {
      await ports.githubCall(() => ports.github.createDraftPr({ head: integrationBranch, base: options.baseBranch, title, body }));
      ports.log(`\nOpened draft PR for ${integrationBranch} → ${options.baseBranch}.`);
    }

    if (complete) {
      // `gh pr ready` on an already-ready PR is a no-op, so a resumed run that
      // finishes a group needs no check of the current draft state.
      await ports.githubCall(() => ports.github.readyPr(integrationBranch));
      ports.log(`Group ${describeGroup(group.id)} is complete — PR marked ready for review.`);
    } else {
      ports.log(`Group ${describeGroup(group.id)} still has outstanding work — PR left as a draft.`);
    }

    return true;
  }

  /** The group's issues as the merger agent is told about them. */
  function describeIssuesForMerge(): string {
    return group.issues.map((issue) => `- ${issue.number}: ${issue.title}`).join("\n");
  }

  /** Resolve the batch and own its sandbox until the group finishes. */
  async function start(): Promise<boolean> {
    ports.log(`\n${"=".repeat(70)}`);
    ports.log(`Group ${describeGroup(group.id)} — ${group.issues.length} open issue(s)`);
    ports.log(`${"=".repeat(70)}`);

    const integrationBranch = await resolveIntegrationBranch();
    ports.integrationBranchSelected(integrationBranch);

    availableIssues = group.issues.filter((issue) => {
      const branch = issueBranchName(issue.number);
      const held = ports.git.foreignWorktree(branch);
      if (!held) return true;
      ports.warn(`Skipping #${issue.number}: ${branch} is checked out in foreign worktree ${held}.`);
      heldIssues.push({ id: String(issue.number), title: issue.title, blockedBy: [], heldIn: held });
      return false;
    });
    const availableNumbers = new Set(availableIssues.map((issue) => issue.number));
    issueBranches = issueBranches.filter((issue) => availableNumbers.has(issue.issueNumber));

    // Covers the process-killed-with-Ctrl-C path: nothing else runs between an
    // interrupted invocation and this one, so this is the only point that ever
    // sees a worktree left dirty by it.
    saveDirtyWorktreesAtGroupStart();

    const integration = ports.createIntegrationSandbox(integrationBranch);
    try {
      return await workGroup(integration);
    } finally {
      await integration.close();
    }
  }

  /** Phases 0–4 for one group, merging and checking through `integration`. */
  async function workGroup(integration: GroupIntegration): Promise<boolean> {
    const integrationBranch = integration.branch;

    await integration.mergeRemoteCopy(describeIssuesForMerge());
    await integration.syncWithBase(describeIssuesForMerge());
    await pickUpPriorWork(integration);

    // The queue owns scheduling (lib/groupQueue.mts); these ports only wire in
    // the real planner, sandboxes and git.
    const queuePorts: GroupQueuePorts = {
      // The integration branch's Done markers are git's own record of what is
      // merged, so a blocker merged by this run unblocks its dependents here too.
      plan: (mergedThisRun) =>
        planGroup([
          ...new Set([
            ...resolveMergedIssues(integrationBranch).map((issue) => Number(issue.id)),
            ...mergedThisRun.map(Number),
          ]),
        ]),
      assertGreen: () => integration.assertGreen(),
      workIssue: (issue, signal) => {
        recreateStaleBranches([issue], integrationBranch);
        return ports.workIssue(issue, integrationBranch, signal);
      },
      merge: (batch) => integration.merge([...batch]),
      readyToMerge: () =>
        ports.git.readyToMerge(integrationBranch, issueBranches)
          .map((branch) => issueNumberOfBranch(branch))
          .filter((number): number is number => number !== undefined)
          .map(String),
      pastEndTime: ports.pastEndTime,
      sharedFailureStop: ports.sharedFailureStop,
      waitForGitHub: ports.waitForGitHub,
      log: (message) => ports.log(message),
    };

    const queued = await ports.runQueue(queuePorts, { integrationBranch });
    const { blocked, plannable, settledWithNothingToDo, stoppedAtEndTime } = queued;
    if (stoppedAtEndTime) ports.endTimeReached();

    warnAboutUnfinishedBranches(integrationBranch);
    const stillUnfinished = ports.git.unfinishedBranches(integrationBranch, issueBranches).length;
    ports.recordStranded(stillUnfinished);

    // An out-of-attempts issue is reported like a blocked one: the group is not complete.
    const complete = !stoppedAtEndTime && heldIssues.length === 0 && isGroupComplete({
      plannedIssues: plannable.length + queued.outOfAttempts.length,
      blockedIssues: blocked.length,
      settledWithNothingToDo,
      strandedBranches: stillUnfinished,
    });

    // The PR body lists an out-of-attempts issue as excluded, as it does a blocked one.
    const excluded = [
      ...heldIssues,
      ...blocked,
      ...queued.outOfAttempts.map((issue) => ({ id: issue.id, title: issue.title, blockedBy: [] })),
    ];
    return publish(integration, complete, excluded);
  }

  return start();
}

/** External operations needed to refresh one batch without changing its PR. */
export type RefreshBranchPorts = Pick<GroupRunPorts, "push" | "createIntegrationSandbox" | "log" | "githubCall"> & {
  git: Pick<GroupRunPorts["git"], "branchesMatching" | "createBranch" | "catchUp"> & {
    isBehindBase(branch: string): boolean;
  };
  prTitle(branch: string): Promise<string>;
};

/** Fetch the pushed copy and report a fast-forward; the sandbox handles divergence. */
async function catchUpIntegrationBranch(
  ports: { git: Pick<GroupRunPorts["git"], "catchUp">; githubCall: GitHubCall; log(message: string): void },
  branch: string,
): Promise<CatchUp> {
  const result = await ports.githubCall(() => ports.git.catchUp(branch));
  if (result === "fast-forwarded") {
    ports.log(`Fast-forwarded ${branch} to origin/${branch}.`);
  }
  return result;
}

/** Merge the base and pushed copy into a batch, then push without editing its PR. */
export async function refreshBranch(
  ports: RefreshBranchPorts,
  options: { baseRef: string },
  branch: string,
): Promise<boolean> {
  let caughtUp: CatchUp = "up-to-date";
  if (ports.git.branchesMatching(branch).length === 0) {
    ports.git.createBranch(branch, `origin/${branch}`);
  } else {
    caughtUp = await catchUpIntegrationBranch(ports, branch);
  }
  if (!ports.git.isBehindBase(branch) && caughtUp !== "diverged") {
    ports.log(`Already up to date with ${options.baseRef}.`);
    return false;
  }
  const integration = ports.createIntegrationSandbox(branch);
  try {
    const issues = `- the PR "${await ports.githubCall(() => ports.prTitle(branch))}"`;
    await integration.mergeRemoteCopy(issues);
    await integration.syncWithBase(issues);
    // A remote update during the base merge must be included in this push too.
    await catchUpIntegrationBranch(ports, branch);
    await integration.mergeRemoteCopy(issues);
    await pushWithGitHub(ports, branch);
    return true;
  } finally {
    await integration.close();
  }
}

/** Classify each push failure while applying the same outage policy as all GitHub calls. */
async function pushWithGitHub(
  ports: Pick<GroupRunPorts, "push" | "githubCall" | "log">,
  branch: string,
): Promise<void> {
  await ports.githubCall(async () => {
    try {
      await ports.push(branch);
    } catch (error) {
      throw pushFailure(branch, error, ports.log);
    }
  });
}
