// The scheduling of one group: a work queue that merges each issue as it
// finishes and starts whatever that merge unblocked. Everything that touches
// GitHub, git or a sandbox arrives as a port, so the timing cases are tested
// with fakes and main.mts only wires real functions in.

import {
  isGitHubUnreachable,
  isSettledWithNothingToDo,
  replannedAfterMerge,
  sharedFailure,
  type IssueFailure,
  type IssueOutcome,
} from "./groups.mts";
import { BranchStateError, RunFatalError, runFatalStop } from "./issueLoop.mts";

/** An issue as the queue names it: its number, title and branch. */
export type QueueIssue = { id: string; title: string; branch: string };

/** An issue still waiting on blockers outside the integration branch. */
export type BlockedIssue = { id: string; title: string; blockedBy: number[]; heldIn?: string; lookupError?: string };

/** One planning pass: what can start now and what is still blocked. */
export type GroupPlan = { planned: QueueIssue[]; blocked: BlockedIssue[] };

/** Everything the queue needs from outside: planning, work, merging, git state and logging. */
export type GroupQueuePorts = {
  /** What can start now and what is blocked, given the issues this run has merged. */
  plan(mergedThisRun: readonly string[]): Promise<GroupPlan>;
  /** Throws a BranchStateError when the integration branch is red. */
  assertGreen(): Promise<void>;
  /** Work one issue to its Done marker. Rejects when it fails. */
  workIssue(
    issue: QueueIssue,
    signal: AbortSignal,
  ): Promise<{ commits: { sha: string }[]; completed: boolean }>;
  /** Merge a batch and check it once. Throws a BranchStateError or a RunFatalError. */
  merge(batch: readonly QueueIssue[]): Promise<void>;
  /** Ids of the issues carrying a Done marker that the integration branch lacks. */
  readyToMerge(): readonly string[] | Promise<readonly string[]>;
  /** Whether the run's end time has passed. */
  pastEndTime(): boolean;
  /** The run-fatal stop for two issues failing alike; may name a quota stop it probes for. */
  sharedFailureStop(message: string): RunFatalError;
  /** Wait for GitHub to answer again; false when it never did within the wait. */
  waitForGitHub(): Promise<boolean>;
  /** Write one line to the run log. */
  log(message: string): void;
};

/** What the group's publish step needs. */
export type GroupQueueResult = {
  stoppedAtEndTime: boolean;
  /** The last plan's blocked issues. */
  blocked: BlockedIssue[];
  /** The last plan's plannable issues: those never merged, whatever became of them. */
  plannable: QueueIssue[];
  /** Issues that used up their attempts; treated as blocked for the rest of the run. */
  outOfAttempts: QueueIssue[];
  settledWithNothingToDo: boolean;
};

/** Attempts an issue gets per run; counted in memory, so every run starts afresh. */
export const MAX_ATTEMPTS = 3;

/** Render issue ids as `#1, #2`. */
const named = (ids: readonly string[]) => ids.map((id) => `#${id}`).join(", ");

/**
 * Run one group to its end: start every plannable issue, merge finished ones
 * one batch at a time, re-plan after each merge, and stop when nothing runs,
 * merges or can start. A red merge or a run-fatal failure stops new work,
 * waits for the running issues, then throws. Two different issues failing
 * alike back to back, with no success between, is a run-fatal failure too.
 */
export async function runGroupQueue(
  ports: GroupQueuePorts,
  options: { integrationBranch: string },
): Promise<GroupQueueResult> {
  const abort = new AbortController();
  const startedIssues = new Map<string, QueueIssue>();
  const finishedIssues = new Set<string>();
  const mergedThisRun = new Set<string>();
  /** Each issue's latest outcome: a failed attempt that a retry later redeems no longer counts. */
  const finalOutcomes = new Map<string, IssueOutcome>();
  const attempts = new Map<string, number>();
  /** Starts lost to GitHub being unreachable: they never count against MAX_ATTEMPTS. */
  const forgiven = new Map<string, number>();
  const countedAttempts = (id: string) => (attempts.get(id) ?? 0) - (forgiven.get(id) ?? 0);
  const outOfAttempts: QueueIssue[] = [];
  const running = new Map<string, Promise<void>>();
  let merging: Promise<void> | undefined;
  /** The latest failure, until a success clears it: the streak the shared-failure stop reads. */
  let lastFailure: IssueFailure | undefined;
  let plan: GroupPlan = { planned: [], blocked: [] };
  let runFatal: unknown;
  let stopError: unknown;
  let stoppedAtEndTime = false;
  let greenAsserted = false;
  /** The tail of the integration-sandbox gate: merges and retries' green checks run one at a time. */
  let gate: Promise<unknown> = Promise.resolve();

  /** Whether a stop reason has been recorded. */
  const stopped = () => runFatal !== undefined || stopError !== undefined;

  /** Record why the queue stops starting and merging; a run-fatal reason also aborts the siblings. */
  function stopWith(error: unknown): void {
    const fatal = runFatalStop(error);
    if (fatal) {
      runFatal ??= fatal;
      if (!abort.signal.aborted) abort.abort(fatal);
    } else {
      stopError ??= error;
    }
  }

  /** Run `task` once every earlier merge and retry check has finished, so none overlaps another. */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = gate.then(task);
    gate = result.catch(() => undefined);
    return result;
  }

  /** Whether the end time has passed, logging and recording it the first time. */
  function endTimeReached(): boolean {
    if (!ports.pastEndTime()) return false;
    if (!stoppedAtEndTime) ports.log("End time reached — no new issue starts.");
    stoppedAtEndTime = true;
    return true;
  }

  /** Plan again from what this run has merged; throws if a merged issue plans again. */
  async function replan(): Promise<void> {
    plan = await ports.plan([...mergedThisRun]);
    const again = replannedAfterMerge([...mergedThisRun], plan.planned.map((issue) => issue.id));
    if (again.length > 0) {
      throw new BranchStateError(
        `${named(again)} merged into ${options.integrationBranch} earlier in this run but planned again: their Done markers are not being seen there. Stopping the group rather than re-working finished issues. Check \`git log ${options.integrationBranch} --grep=^Sandcastle-Done:\`, then re-run Sandcastle.`,
      );
    }
  }

  /** Begin one attempt at an issue and track it until it settles. */
  function start(issue: QueueIssue): void {
    startedIssues.set(issue.id, issue);
    const attempt = (attempts.get(issue.id) ?? 0) + 1;
    attempts.set(issue.id, attempt);
    ports.log(`#${issue.id} starting: ${issue.title}`);
    running.set(
      `${issue.id}#${attempt}`,
      (async () => {
        try {
          const result = await ports.workIssue(issue, abort.signal);
          finalOutcomes.set(issue.id, { failed: false, commits: result.commits.length, completed: result.completed });
          finishedIssues.add(issue.id);
          lastFailure = undefined;
          ports.log(
            result.completed
              ? `#${issue.id} finished (${result.commits.length} commit(s))`
              : `#${issue.id} stopped before its Done marker (${result.commits.length} commit(s) this run) — the next run continues it`,
          );
        } catch (error) {
          finalOutcomes.set(issue.id, { failed: true, commits: 0, completed: false });
          const reason = error instanceof Error ? error.message : String(error);
          if (runFatalStop(error)) {
            // Run-fatal failures end the run and never count as an attempt.
            ports.log(`#${issue.id} failed: ${reason}`);
            stopWith(error);
          } else if (isGitHubUnreachable(reason)) {
            // Checked before the shared-failure stop: every issue loses GitHub alike.
            forgiven.set(issue.id, (forgiven.get(issue.id) ?? 0) + 1);
            ports.log(`#${issue.id} failed: GitHub is unreachable — not counted as an attempt.`);
            if (await ports.waitForGitHub()) {
              await retryOrGiveUp(issue, countedAttempts(issue.id));
            } else {
              stopWith(
                new RunFatalError("network", reason.slice(0, 200), {
                  reason: "GitHub stayed unreachable",
                }),
              );
            }
          } else {
            const failure: IssueFailure = { issue: issue.id, message: reason };
            const shared = sharedFailure(lastFailure, failure);
            lastFailure = failure;
            if (shared !== undefined && !stopped()) {
              // Like any run-fatal failure, this one is not an attempt.
              ports.log(`#${issue.id} failed: ${reason}`);
              ports.log(`Two issues failed alike back to back — stopping the run.`);
              stopWith(ports.sharedFailureStop(shared));
              return;
            }
            const counted = countedAttempts(issue.id);
            ports.log(`#${issue.id} failed (attempt ${counted}/${MAX_ATTEMPTS}): ${reason}`);
            await retryOrGiveUp(issue, counted);
          }
        } finally {
          running.delete(`${issue.id}#${attempt}`);
        }
      })(),
    );
  }

  /** Retry straight away while counted attempts are left; otherwise record the issue as out of attempts. */
  async function retryOrGiveUp(issue: QueueIssue, attempt: number): Promise<void> {
    if (attempt >= MAX_ATTEMPTS) {
      outOfAttempts.push(issue);
      ports.log(`#${issue.id} ran out of attempts (${MAX_ATTEMPTS}): ${issue.title}`);
      return;
    }
    if (stopped()) return;
    if (endTimeReached()) return;
    // Behind the same gate as merges: the branch is neither asserted nor used to
    // recreate the issue's branch while a merge is moving it.
    await exclusive(async () => {
      if (stopped()) return;
      try {
        await ports.assertGreen();
      } catch (error) {
        stopWith(error);
        return;
      }
      if (stopped()) return;
      start(issue);
    });
  }

  /** Start every planned issue not yet started, once the branch is green and the end time not passed. */
  async function startPlannable(): Promise<void> {
    for (const issue of plan.planned) {
      if (stopped()) return;
      if (startedIssues.has(issue.id) || mergedThisRun.has(issue.id)) continue;
      if (endTimeReached()) return;
      if (!greenAsserted) {
        await ports.assertGreen();
        greenAsserted = true;
      }
      start(issue);
    }
  }

  /** Merge the finished issues whose Done marker is ready, unless a merge is already running. */
  async function mergeFinished(): Promise<void> {
    if (merging || stopped()) return;
    const ready = new Set(await ports.readyToMerge());
    const batch = [...finishedIssues]
      .filter((id) => ready.has(id) && !mergedThisRun.has(id))
      .map((id) => startedIssues.get(id)!);
    if (batch.length === 0) return;

    ports.log(`Merging ${named(batch.map((issue) => issue.id))} into ${options.integrationBranch}`);
    merging = exclusive(async () => {
      try {
        if (stopped()) return;
        await ports.merge(batch);
        for (const issue of batch) mergedThisRun.add(issue.id);
        await replan();
        const unblocked = plan.planned.filter((issue) => !startedIssues.has(issue.id));
        ports.log(
          unblocked.length > 0
            ? `Merged ${named(batch.map((issue) => issue.id))}; ${named(unblocked.map((issue) => issue.id))} unblocked`
            : `Merged ${named(batch.map((issue) => issue.id))}; nothing unblocked`,
        );
      } catch (error) {
        stopWith(error);
      } finally {
        merging = undefined;
      }
    });
  }

  await replan();
  if (plan.blocked.length > 0) {
    ports.log(`${plan.blocked.length} issue(s) blocked:`);
    for (const issue of plan.blocked) {
      const reason = issue.lookupError !== undefined
        ? `blocker lookup failed: ${issue.lookupError}`
        : `blocked by ${issue.blockedBy.map((n) => `#${n}`).join(", ")}`;
      ports.log(`  #${issue.id}: ${issue.title} (${reason})`);
    }
  }

  for (;;) {
    if (!stopped()) {
      await startPlannable();
      await mergeFinished();
    }
    const pending = [...running.values(), ...(merging ? [merging] : [])];
    if (pending.length === 0) break;
    await Promise.race(pending);
  }

  if (runFatal !== undefined) throw runFatal;
  if (stopError !== undefined) throw stopError;

  return {
    stoppedAtEndTime,
    blocked: plan.blocked,
    plannable: plan.planned.filter(
      (issue) => !mergedThisRun.has(issue.id) && !outOfAttempts.some((spent) => spent.id === issue.id),
    ),
    outOfAttempts,
    settledWithNothingToDo: isSettledWithNothingToDo([...finalOutcomes.values()]),
  };
}
