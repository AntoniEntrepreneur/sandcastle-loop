// The per-issue pipeline that runs once an issue's sandbox exists: implementer
// iterations, the dead-run breaker, the reviewer, the Done marker and the WIP
// saves. Everything that touches the SDK, git or Docker arrives as a port, so
// the loop is tested with fakes and the orchestrator only wires real functions in.

import {
  checkFailureTail,
  classifyFailure,
  isDeadRun,
  isRunFatal,
  parseQuotaReset,
  type FailureKind,
} from "./groups.mts";
import { quotaStopKind, type QuotaStopKind } from "./overnight.mts";

/** Fix-and-recheck rounds allowed after a red check, per role. */
export const MAX_CHECK_ROUNDS = 3;

/** How much of a red check's output goes back to the agent. */
export const CHECK_TAIL_CHARS = 6000;

/** A failure that should end the whole run rather than just its group. */
const FATAL_REASONS: Record<Exclude<FailureKind, "local">, string> = {
  quota: "Claude usage exhausted",
  auth: "Agent authentication failed",
  network: "Cannot reach the API from inside the sandbox",
};

export class RunFatalError extends Error {
  readonly kind: Exclude<FailureKind, "local">;
  /** For a quota stop: when the quota resets, if the message said. */
  readonly resetAt: Date | undefined;
  /** For a quota stop: which limit, read from the whole text rather than the trimmed detail. */
  readonly quotaStop: QuotaStopKind | undefined;

  constructor(
    kind: Exclude<FailureKind, "local">,
    detail: string,
    resetAt?: Date,
    quotaStop?: QuotaStopKind,
  ) {
    super(`${FATAL_REASONS[kind]} — stopping the run. (${detail})`);
    this.kind = kind;
    this.resetAt = resetAt;
    this.quotaStop = quotaStop;
  }
}

/** Rethrow as fatal when the text names a failure that would kill every group. */
export function throwIfRunFatal(text: string): void {
  const kind = classifyFailure(text);
  if (isRunFatal(kind)) {
    const resetAt = kind === "quota" ? parseQuotaReset(text, new Date()) : undefined;
    const quotaStop = kind === "quota" ? quotaStopKind(text) : undefined;
    throw new RunFatalError(kind, text.slice(0, 200), resetAt, quotaStop);
  }
}

/**
 * The integration branch's own state is wrong — a red check, a merge left
 * unfinished — judged by git and the check, never by an agent's words. Its
 * message carries the check's output tail, which is test output: a test that
 * prints "Network Error" would otherwise stop the whole run as unreachable.
 */
export class BranchStateError extends Error {
  override name = "BranchStateError";
}

/**
 * The run-fatal stop a caught error names, or undefined when it is the
 * group's own failure. A BranchStateError is always the group's own.
 */
export function runFatalStop(error: unknown): RunFatalError | undefined {
  if (error instanceof RunFatalError) return error;
  if (error instanceof BranchStateError) return undefined;
  try {
    throwIfRunFatal(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
  } catch (stop) {
    return stop as RunFatalError;
  }
  return undefined;
}

/**
 * The session id a thrown run still carries. Set by our SDK patch
 * (patches/@ai-hero+sandcastle+0.12.0.patch) when the agent exits with an
 * error, e.g. on a usage limit, after its session was copied to the host.
 */
function sessionIdOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("sessionId" in error)) return undefined;
  return typeof error.sessionId === "string" ? error.sessionId : undefined;
}

/** What one agent run reports back, already translated from the SDK's result. */
export type RunResult = {
  stdout: string;
  commits: { sha: string }[];
  /** The agent emitted its completion signal. */
  completed: boolean;
  /** `resumeSession` can continue this run's session. */
  resumable: boolean;
  /** The agent's session id, when the SDK captured one. */
  sessionId?: string;
};

export type Role = "implementer" | "reviewer";

export type IssueLoopPorts = {
  /** Start a fresh run for the role. `model` is set for the reviewer only. */
  startRun(request: {
    role: Role;
    model?: string;
    /** Continue this saved session (implementer only). */
    resumeSessionId?: string;
    /** Failure context a cold implementer start must be told, e.g. a red check's tail. */
    extraPrompt?: string;
  }): Promise<RunResult>;
  /** Continue the most recent run's session with a short prompt. */
  resumeSession(prompt: string): Promise<RunResult>;
  /** Run a shell command in the issue's sandbox. */
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Commit whatever is loose in the worktree; true when a commit was made. */
  saveWorktree(reason: "iteration-ended" | "run-died" | "formatted"): boolean;
  /** Write the Done marker for this issue. */
  writeDone(): void;
  /** The saved session id of an earlier run, if any. */
  readSession(): string | undefined;
  writeSession(sessionId: string): void;
  /** Forget the saved session. */
  clearSession(): void;
  abortSignal: AbortSignal;
  /** Picked when the reviewer starts, from the branch's diff by then. */
  reviewerModel(): { model: string; reason: string };
};

export type IssueLoopOptions = {
  maxSteps: number;
  continuePrompt: string;
  /** The full check, already wrapped in its time limit. */
  checkCommand: string;
  /** The project's formatter, run and committed before every check; none when absent. */
  formatCommand?: string;
  /** Called with a message for the operator log. */
  log?: (message: string) => void;
  /** True once an overnight run's end time has passed: no further agent run starts. */
  pastEndTime?: () => boolean;
};

export type IssueLoopResult = {
  commits: { sha: string }[];
  completed: boolean;
  /** Present when `completed` is false. */
  reason?: "dead-run" | "step-limit" | "check-rounds-used-up" | "end-time";
};

const fixPrompt = (tail: string) =>
  `The check (full test suite and lint) failed. The end of its output:\n\n${tail}\n\nFix these failures, commit, and signal completion again.`;

/**
 * Run the formatter, commit what it changed, then the full check. Returns the
 * output tail when the check is red (a timeout counts as red), undefined when green.
 */
async function formatAndCheck(
  ports: IssueLoopPorts,
  options: IssueLoopOptions,
): Promise<string | undefined> {
  if (options.formatCommand !== undefined) {
    await ports.exec(options.formatCommand);
    ports.saveWorktree("formatted");
  }
  const result = await ports.exec(options.checkCommand);
  return checkFailureTail(result.exitCode, result.stdout, result.stderr, CHECK_TAIL_CHARS);
}

/**
 * Drive the implementer one step at a time until it finishes or dies, then
 * review it. A fired `abortSignal` stops it at the next step boundary (after
 * saving) by throwing the signal's reason. Done means the reviewer finished without a fatal failure. Throws
 * RunFatalError when any run's output names a run-fatal failure; loose work is
 * saved first.
 */
export async function runIssueLoop(
  ports: IssueLoopPorts,
  options: IssueLoopOptions,
): Promise<IssueLoopResult> {
  const log = options.log ?? (() => {});
  const pastEndTime = options.pastEndTime ?? (() => false);

  /** An implementer run that throws still saves its session, so the next run resumes it. */
  const keepingSession = async (run: () => Promise<RunResult>): Promise<RunResult> => {
    try {
      return await run();
    } catch (error) {
      const sessionId = sessionIdOf(error);
      if (sessionId) ports.writeSession(sessionId);
      throw error;
    }
  };

  /** Step 1 picks up a session saved by an earlier run; a failed resume starts cold. */
  const startImplementer = async (step: number, extraPrompt?: string): Promise<RunResult> => {
    const saved = step === 1 ? ports.readSession() : undefined;
    if (saved) {
      try {
        return await keepingSession(() =>
          ports.startRun({ role: "implementer", resumeSessionId: saved, extraPrompt }),
        );
      } catch (error) {
        // An abort is not a stale session: starting cold would run a second agent.
        if (ports.abortSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throwIfRunFatal(message);
        log(`Could not resume saved session ${saved} (${message.slice(0, 120)}) — starting cold.`);
      }
    }
    return keepingSession(() => ports.startRun({ role: "implementer", extraPrompt }));
  };

  try {
    const history: { commits: number; completed: boolean }[] = [];
    const commits: { sha: string }[] = [];
    let previous: RunResult | undefined;
    let checkRounds = 0;
    let pendingFix: string | undefined;

    for (let step = 1; step <= options.maxSteps; step++) {
      // A sibling's run-fatal failure stops this issue at the step boundary;
      // the finally below saves whatever is loose.
      ports.abortSignal.throwIfAborted();
      // A run already going finishes; the end time only stops the next one.
      if (pastEndTime()) {
        log("End time reached — not starting another implementer run.");
        return { commits, completed: false, reason: "end-time" };
      }
      if (step > 1 && !previous?.resumable) {
        log(`No session to resume — step ${step} starts cold.`);
      }
      const result = previous?.resumable
        ? await keepingSession(() => ports.resumeSession(pendingFix ?? options.continuePrompt))
        : await startImplementer(step, pendingFix);
      previous = result;
      pendingFix = undefined;
      if (result.sessionId) ports.writeSession(result.sessionId);

      // A quota death usually throws (see keepingSession) but can resolve its run, so stdout matters too.
      throwIfRunFatal(result.stdout);

      commits.push(...result.commits);
      const saved = ports.saveWorktree("iteration-ended");
      history.push({
        commits: result.commits.length + (saved ? 1 : 0),
        completed: result.completed,
      });

      if (result.completed) {
        ports.abortSignal.throwIfAborted();
        const tail = await formatAndCheck(ports, options);
        if (tail !== undefined) {
          // Each fix round is a step, so it counts against maxSteps.
          if (++checkRounds > MAX_CHECK_ROUNDS) {
            log("Check still red after three fix rounds — leaving the branch unfinished.");
            return { commits, completed: false, reason: "check-rounds-used-up" };
          }
          pendingFix = fixPrompt(tail);
          continue;
        }

        if (pastEndTime()) {
          log("End time reached — the reviewer starts on the next run.");
          return { commits, completed: false, reason: "end-time" };
        }
        const reviewer = ports.reviewerModel();
        log(`Reviewer: ${reviewer.model} (${reviewer.reason}).`);
        let review = await ports.startRun({ role: "reviewer", model: reviewer.model });
        commits.push(...review.commits);
        throwIfRunFatal(review.stdout);
        ports.saveWorktree("iteration-ended");
        for (let round = 0; ; round++) {
          ports.abortSignal.throwIfAborted();
          const reviewTail = await formatAndCheck(ports, options);
          if (reviewTail === undefined) break;
          if (round >= MAX_CHECK_ROUNDS) {
            log("Check still red after the reviewer's three fix rounds — leaving the branch unfinished.");
            return { commits, completed: false, reason: "check-rounds-used-up" };
          }
          if (pastEndTime()) {
            log("End time reached — the reviewer's fix round waits for the next run.");
            return { commits, completed: false, reason: "end-time" };
          }
          review = review.resumable
            ? await ports.resumeSession(fixPrompt(reviewTail))
            : await ports.startRun({ role: "reviewer", model: reviewer.model });
          commits.push(...review.commits);
          throwIfRunFatal(review.stdout);
          ports.saveWorktree("iteration-ended");
        }
        ports.writeDone();
        ports.clearSession();
        return { commits, completed: true };
      }

      if (isDeadRun(history)) {
        return { commits, completed: false, reason: "dead-run" };
      }
    }

    return { commits, completed: false, reason: "step-limit" };
  } finally {
    // Safety net for a fatal failure anywhere above. A no-op on a clean tree.
    ports.saveWorktree("run-died");
  }
}
