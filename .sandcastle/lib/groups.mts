// Grouping, ordering and failure classification for the Sandcastle run.
//
// Everything here is a pure function over strings and lists, deliberately
// separated from main.mts so the paths that only fire when nobody is watching
// — the circuit breaker, the quota match, the completion test — can be tested
// without a sandbox or a quota. main.mts owns all git, gh and agent calls.

/** The admission label for an issue with no group: one issue, one PR. */
export const SOLO_LABEL = "sandcastle";

/** Prefix that admits an issue to a Sandcastle group. */
export const GROUP_LABEL_PREFIX = "sandcastle:";

/** Consecutive dead implementer iterations before a run is presumed dead. */
export const DEAD_ITERATION_THRESHOLD = 3;

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  readonly labels: string[];
}

export interface Group {
  /** Group id: the label suffix, or `solo-<issue>` for an ungrouped issue. */
  readonly id: string;
  /** A numeric group id names the parent spec issue that it closes. */
  readonly parentIssue: number | undefined;
  readonly issues: Issue[];
}

/** Read the group id an issue is admitted under, or undefined if it is not admitted. */
export function groupIdOf(issue: Issue): string | undefined {
  const groupLabel = issue.labels.find((label) =>
    label.startsWith(GROUP_LABEL_PREFIX),
  );
  if (groupLabel) {
    const id = groupLabel.slice(GROUP_LABEL_PREFIX.length).trim();
    return id.length > 0 ? id : undefined;
  }
  return issue.labels.includes(SOLO_LABEL) ? `solo-${issue.number}` : undefined;
}

/** A group id that is purely numeric names the parent spec issue to close. */
export function parentIssueOf(groupId: string): number | undefined {
  return /^\d+$/.test(groupId) ? Number(groupId) : undefined;
}

/** A group id of the `solo-<issue>` shape, and the issue number in it. */
function soloIssueOf(groupId: string): number | undefined {
  const match = groupId.match(/^solo-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Name a group the way a message to a human should name it.
 *
 * A grouped issue is named by the label that admitted it, because that label
 * is the thing you would search the board for. A solo group has no such label:
 * its id is synthesised from the issue number (see groupIdOf), so prefixing it
 * printed `sandcastle:solo-365` — a label that does not exist and cannot be
 * created. It names the issue instead.
 *
 * Deliberately not shared with buildPrTitle, which renders the same group
 * differently on purpose: a PR title names the spec a group serves (`#218` for
 * `sandcastle:218`), while a message names the label (`sandcastle:218`).
 */
export function describeGroup(groupId: string): string {
  const solo = soloIssueOf(groupId);
  return solo === undefined ? `${GROUP_LABEL_PREFIX}${groupId}` : `#${solo}`;
}

/**
 * Partition open issues into the groups a run will work, in run order.
 *
 * Groups and solo issues interleave in issue order: each is placed by the
 * issue it stands for (see issueOrderOf). Stability matters more than
 * cleverness: a run that keeps being interrupted must keep draining the same
 * end of the queue rather than scattering half-finished work across every
 * group.
 */
export function partitionIntoGroups(issues: Issue[]): Group[] {
  const byId = new Map<string, Issue[]>();

  for (const issue of issues) {
    const id = groupIdOf(issue);
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) existing.push(issue);
    else byId.set(id, [issue]);
  }

  const groups = [...byId.entries()].map(([id, groupIssues]) => ({
    id,
    parentIssue: parentIssueOf(id),
    issues: [...groupIssues].sort((a, b) => a.number - b.number),
  }));

  return groups.sort(compareGroups);
}

/**
 * The issue number a group is queued by.
 *
 * A numeric group stands for its parent spec, and a solo group for its own
 * issue. A named group has no issue of its own, so it queues at its earliest
 * member.
 */
function issueOrderOf(group: Group): number {
  return (
    group.parentIssue ??
    soloIssueOf(group.id) ??
    Math.min(...group.issues.map((issue) => issue.number))
  );
}

/** Rank two groups into run order: by issue number, then by id on a tie. */
function compareGroups(a: Group, b: Group): number {
  return issueOrderOf(a) - issueOrderOf(b) || a.id.localeCompare(b.id);
}

/** Name the integration branch a group's work is merged into. */
export function batchBranchName(groupId: string, timestamp: number): string {
  return `sandcastle/batch-${groupId}-${timestamp}`;
}

/** Glob matching every integration branch belonging to one group. */
export function batchBranchGlob(groupId: string): string {
  return `sandcastle/batch-${groupId}-*`;
}

/** Name the working branch for a single issue. */
export function issueBranchName(issueNumber: number): string {
  return `sandcastle/issue-${issueNumber}`;
}

/** Read the issue number out of a `sandcastle/issue-<N>` branch name. */
export function issueNumberOfBranch(branch: string): number | undefined {
  const match = branch.match(/^sandcastle\/issue-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Decide whether a failure is specific to one group or fatal to the whole run.
 *
 * Quota exhaustion and a broken login kill every group equally, so continuing
 * only burns container starts. Anything else is the group's own problem and
 * the next group deserves its turn.
 */
export type FailureKind = "quota" | "auth" | "network" | "local";

const QUOTA_PATTERNS = [
  /usage limit reached/i,
  /usage limit will reset/i,
  /credit balance is too low/i,
  /insufficient credits/i,
  // The session-limit stop a resolved run's stdout carries when the
  // developer's Claude usage runs out mid-turn, e.g. "You've hit your
  // session limit · resets 2:40pm (UTC)". Missing this let a run keep
  // planning after every implementer had already died (#407).
  /session limit/i,
  // "You've hit your weekly limit · resets 2am (UTC)" — seen in an implementer
  // log; unmatched, it failed one group and let the run start the next.
  /weekly limit/i,
];

// A machine that cannot reach the API will not be able to reach it on the next
// iteration either, and each retry costs a container start. Observed during the
// #260 smoke test, where a transient outage burned three cycles.
const NETWORK_PATTERNS = [
  /can't reach the api server/i,
  /\bENOTFOUND\b/,
  /\bECONNREFUSED\b/,
  /\bEAI_AGAIN\b/,
  /getaddrinfo/i,
  /network[_ ]error/i,
];

const AUTH_PATTERNS = [
  /invalid api key/i,
  /authentication[_ ]error/i,
  /please run \/login/i,
  /oauth token has expired/i,
];

/** Classify agent output or an error message as a run-fatal failure or a local one. */
export function classifyFailure(text: string): FailureKind {
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return "quota";
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) return "auth";
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(text))) return "network";
  return "local";
}

/** Quota, auth and network failures end the whole run; a local one ends only its group. */
export function isRunFatal(kind: FailureKind): kind is Exclude<FailureKind, "local"> {
  return kind !== "local";
}

/** Offset in ms of `zone` from UTC at the given instant, or undefined for an unknown zone. */
function zoneOffsetMs(at: number, zone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(at));
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
    const asUtc = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    if (Number.isNaN(asUtc)) return undefined;
    return asUtc - Math.floor(at / 1000) * 1000;
  } catch {
    return undefined;
  }
}

/** The instant at which the wall clock in `zone` reads the given date and time. */
function zonedInstant(
  y: number,
  mo: number,
  d: number,
  h: number,
  min: number,
  zone: string,
): number | undefined {
  const guess = Date.UTC(y, mo, d, h, min);
  const first = zoneOffsetMs(guess, zone);
  if (first === undefined) return undefined;
  const second = zoneOffsetMs(guess - first, zone) ?? first;
  return guess - second;
}

/**
 * Read the quota reset time out of a quota message such as
 * "You've hit your session limit · resets 1:10pm (UTC)".
 *
 * Returns the next instant after `now` at which the stated clock time occurs
 * in the stated timezone, or undefined when the text has no readable reset.
 */
export function parseQuotaReset(text: string, now: Date): Date | undefined {
  const match = text.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!match) return undefined;
  const hour12 = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  const zone = match[4].trim();

  const offset = zoneOffsetMs(now.getTime(), zone);
  if (offset === undefined) return undefined;
  const local = new Date(now.getTime() + offset);
  for (let dayShift = 0; dayShift <= 1; dayShift++) {
    const instant = zonedInstant(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + dayShift,
      hour,
      minute,
      zone,
    );
    if (instant !== undefined && instant > now.getTime()) return new Date(instant);
  }
  return undefined;
}

/** Whether a run may start, and when it may if not. */
export type QuotaGateDecision =
  | { allowed: true }
  | { allowed: false; resetAt: Date; minutesLeft: number };

/** Refuse a run started before the saved quota reset, unless overridden. */
export function quotaGate(
  savedReset: Date | undefined,
  now: Date,
  override: boolean,
): QuotaGateDecision {
  if (override || !savedReset || savedReset.getTime() <= now.getTime()) {
    return { allowed: true };
  }
  const minutesLeft = Math.ceil((savedReset.getTime() - now.getTime()) / 60_000);
  return { allowed: false, resetAt: savedReset, minutesLeft };
}

/**
 * Whether to spend one tiny Haiku call checking the quota before any sandbox.
 * Only when the gate allows the run and no reset time is still pending, and
 * never on a dry run.
 */
export function shouldProbeQuota(
  gate: QuotaGateDecision,
  savedReset: Date | undefined,
  now: Date,
  dryRun: boolean,
): boolean {
  if (dryRun || !gate.allowed) return false;
  return !savedReset || savedReset.getTime() <= now.getTime();
}

/** Seconds an orchestrator-run check may take before `timeout` kills it. */
export const CHECK_TIME_LIMIT_SECONDS = 1800;

/** Exit code `timeout` returns when it had to kill the command. */
const TIMEOUT_EXIT_CODE = 124;

/** Wrap a shell command, `&&` chains included, in the check time limit. */
export function withTimeLimit(command: string): string {
  const quoted = `'${command.replaceAll("'", `'\\''`)}'`;
  return `timeout ${CHECK_TIME_LIMIT_SECONDS} sh -c ${quoted}`;
}

/**
 * The output tail to report for a finished check, or undefined when it was
 * green. A timeout (exit 124) is red, and the report says so.
 */
export function checkFailureTail(
  exitCode: number,
  stdout: string,
  stderr: string,
  tailChars: number,
): string | undefined {
  if (exitCode === 0) return undefined;
  const tail = `${stdout}\n${stderr}`.slice(-tailChars);
  if (exitCode !== TIMEOUT_EXIT_CODE) return tail;
  return `The check timed out after ${CHECK_TIME_LIMIT_SECONDS / 60} minutes and was killed.\n\n${tail}`;
}

/**
 * What to do when the merger agent's run throws. Quota, auth and network
 * failures end the run; anything else, the SDK's idle timeout included, is
 * judged by the branch state the merger left behind.
 */
export function mergerFailureVerdict(errorText: string): "rethrow" | "judge-branch" {
  return isRunFatal(classifyFailure(errorText)) ? "rethrow" : "judge-branch";
}

/**
 * Decide whether a run of iterations has stopped making progress.
 *
 * The backstop behind classifyFailure(): it needs nothing from the agent's
 * wording, so it catches a quota message we failed to anticipate, a crashed
 * image and a wedged sandbox alike. The implementer's prompt tells it to commit
 * at the end of every iteration, so consecutive commit-less iterations that
 * never signalled completion are already abnormal.
 */
export function isDeadRun(
  iterations: { commits: number; completed: boolean }[],
  threshold: number = DEAD_ITERATION_THRESHOLD,
): boolean {
  if (iterations.length < threshold) return false;
  return iterations
    .slice(-threshold)
    .every((iteration) => iteration.commits === 0 && !iteration.completed);
}

/**
 * Decide whether a group has nothing left outstanding.
 *
 * Three halves matter: an empty plan alone would call a group done while one
 * of its branches sat stranded with unmerged commits (that PR would go out as
 * ready for review with work missing from it), and it would also call a group
 * done while one of its issues is open but blocked — that issue isn't
 * finished, it's just not this batch's to do anything about right now. Only a
 * blocker outside this batch reaches here (see liveBlockers), so the PR stays a
 * draft until that blocker ships; a future run that finds it closed folds the
 * dependent into the same PR.
 *
 * A plan is also exhausted when its issues settled with nothing to do (see
 * isSettledWithNothingToDo): the loop stops on that before replanning, so the
 * last plan is still non-empty even though nothing in it is outstanding.
 */
export function isGroupComplete(state: {
  plannedIssues: number;
  blockedIssues: number;
  settledWithNothingToDo: boolean;
  strandedBranches: number;
}): boolean {
  const planExhausted = state.plannedIssues === 0 || state.settledWithNothingToDo;
  return planExhausted && state.blockedIssues === 0 && state.strandedBranches === 0;
}

/** A Done marker's trailers, parsed from one commit's message. */
export interface DoneMarker {
  readonly issue: number;
  readonly batch: string;
}

const DONE_TRAILER = /^Sandcastle-Done:\s*#(\d+)\s*$/m;
const BATCH_TRAILER = /^Sandcastle-Batch:\s*(\S+)\s*$/m;

/**
 * Read a Done marker's trailers out of one commit message, or undefined if
 * this commit carries neither. Markers are found by trailer, never by
 * content, so an empty commit's missing diff never matters here.
 */
export function parseDoneTrailers(commitMessage: string): DoneMarker | undefined {
  const doneMatch = commitMessage.match(DONE_TRAILER);
  const batchMatch = commitMessage.match(BATCH_TRAILER);
  if (!doneMatch || !batchMatch) return undefined;
  return { issue: Number(doneMatch[1]), batch: batchMatch[1] };
}

/**
 * A `Blocked by: #<n>, #<n>` line at the top of an issue body — the documented
 * fallback (docs/agents/issue-tracker.md:42) for a blocker that predates
 * native GitHub issue dependencies or was never wired up natively.
 */
const BLOCKED_BY_LINE = /^Blocked by:\s*(#\d+(?:\s*,\s*#\d+)*)\s*$/im;

/** Issue numbers named on a `Blocked by:` line, or none if the body has no such line. */
export function parseBlockedByLine(body: string | undefined): number[] {
  if (!body) return [];
  const match = body.match(BLOCKED_BY_LINE);
  if (!match) return [];
  return [...match[1].matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/**
 * Narrow a blocker list to the blockers this batch is still waiting on.
 *
 * A blocker whose own work is already merged into the integration branch is
 * resolved as far as this batch is concerned, even though GitHub still reports
 * its issue as open: a Sandcastle issue closes when the batch PR merges, not
 * when its commits land on the branch. Reading GitHub's state alone deadlocked
 * exactly the case the cycle loop exists for — a group whose blocker and
 * dependent are both in the batch could never finish, because the dependent
 * waited on a close that waited on the PR that waited on the dependent.
 *
 * `mergedIssues` must be the issues merged into *this* integration branch. A
 * blocker merged into some other group's branch is still a live block: its work
 * is not in this batch, so building on it here would build on nothing.
 */
export function liveBlockers(
  blockers: number[],
  mergedIssues: number[],
): number[] {
  const merged = new Set(mergedIssues);
  return blockers.filter((blocker) => !merged.has(blocker));
}

/** Title the PR for a group's batch. */
export function buildPrTitle(group: Group, mergedIssues: number): string {
  const scope = group.parentIssue
    ? `#${group.parentIssue}`
    : group.id.startsWith("solo-")
      ? `#${group.id.replace(/^solo-/, "")}`
      : group.id;
  return `Sandcastle: ${scope} — ${mergedIssues} issue(s)`;
}

/**
 * Build the PR body for a group's batch.
 *
 * The parent spec is only closed once the group is complete: a draft PR that
 * already said `Closes #218` would close the spec the moment you merged a
 * partial batch.
 *
 * `writeup` is the reviewer-facing body the PR writer drafted with the `pr`
 * skill. It sits under the Sandcastle marker; the `Closes` lines stay generated
 * here, because which issues a merge closes is not the writer's call.
 */
export function buildPrBody(options: {
  group: Group;
  mergedIssues: { id: string; title: string }[];
  blockedIssues: { id: string; title: string; blockedBy: number[] }[];
  complete: boolean;
  writeup?: string;
}): string {
  const { group, mergedIssues, blockedIssues, complete, writeup } = options;
  const solo = soloIssueOf(group.id);
  const lines = [
    // A batch of one is not a batch, and there is no group label to name: a
    // solo group's PR says what it is instead of naming a label nobody can
    // find. Both forms keep the "by Sandcastle, not by a human" marker.
    solo === undefined
      ? `Automated batch for \`${GROUP_LABEL_PREFIX}${group.id}\`, completed by Sandcastle.`
      : `Automated work on #${solo}, completed by Sandcastle.`,
    "",
  ];

  if (writeup !== undefined) lines.push(writeup, "");

  if (mergedIssues.length > 0) {
    lines.push(...mergedIssues.map((i) => `Closes #${i.id}: ${i.title}`));
  } else {
    lines.push(
      "Carried forward from an earlier interrupted run; see the commits on this branch.",
    );
  }

  if (blockedIssues.length > 0) {
    lines.push("");
    lines.push("Excluded this batch — blocked:");
    lines.push(
      ...blockedIssues.map(
        (i) =>
          `- #${i.id}: ${i.title} (blocked by ${i.blockedBy.map((n) => `#${n}`).join(", ")})`,
      ),
    );
  }

  if (group.parentIssue !== undefined) {
    lines.push("");
    lines.push(
      complete
        ? `Closes #${group.parentIssue}`
        : `Part of #${group.parentIssue}`,
    );
  }

  if (!complete) {
    lines.push("");
    lines.push(
      "Draft: this group still has outstanding work. Re-running Sandcastle folds it into this PR.",
    );
  }

  return lines.join("\n");
}

/**
 * Did a cycle prove there is nothing left for this group to do?
 *
 * An issue that signals completion without producing a commit is telling us its
 * work was already done. When that holds for every issue in a cycle, replanning
 * can only produce the same answer, so the group is finished and further cycles
 * are pure waste. A failure, or an issue that never signalled, means the
 * opposite — a retry may still get somewhere.
 */
export function isSettledWithNothingToDo(
  outcomes: { failed: boolean; commits: number; completed: boolean }[],
): boolean {
  return (
    outcomes.length > 0 &&
    outcomes.every((o) => !o.failed && o.commits === 0 && o.completed)
  );
}
