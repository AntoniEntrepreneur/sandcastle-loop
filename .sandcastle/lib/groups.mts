// Grouping, ordering and failure classification for the Sandcastle run.
//
// Everything here is a pure function over strings and lists, deliberately
// separated from main.mts so the paths that only fire when nobody is watching
// — the circuit breaker, the quota match, the completion test — can be tested
// without a sandbox or a quota. main.mts owns all git, gh and agent calls.

import { isNonClaudeLabel } from "./rolePlan.mts";

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
 * A PR title names the change instead (see buildPrTitle), and falls back to
 * this only for a group with no issues to name it by.
 */
export function describeGroup(groupId: string): string {
  const solo = soloIssueOf(groupId);
  return solo === undefined ? `${GROUP_LABEL_PREFIX}${groupId}` : `#${solo}`;
}

export type GroupResolution =
  | { ok: true; groups: Group[] }
  | { ok: false; message: string };

/**
 * Resolve typed ids against the board, keeping the typed order.
 *
 * An id is a group id (including `solo-N`) or a bare number: the group of that
 * id if the board has one, else the solo issue. A number that is both is
 * ambiguous. Nothing resolves unless every id does.
 */
export function resolveGroupIds(ids: readonly string[], board: readonly Group[]): GroupResolution {
  const byId = new Map(board.map((group) => [group.id, group]));
  const chosen: Group[] = [];
  const unresolved: string[] = [];
  const notes: string[] = [];
  for (const id of ids) {
    let found = byId.get(id);
    if (/^\d+$/.test(id)) {
      const solo = byId.get(`solo-${id}`);
      if (found && solo) {
        notes.push(`${id} is both the group ${GROUP_LABEL_PREFIX}${id} and the solo issue #${id} — it is ambiguous. Close one of them, or run solo-${id} for the solo issue.`);
        continue;
      }
      found ??= solo;
      if (!found) {
        const inside = board.find((group) => group.issues.some((issue) => issue.number === Number(id)));
        if (inside) {
          notes.push(`#${id} is in group ${GROUP_LABEL_PREFIX}${inside.id} — run ${inside.id} instead`);
          continue;
        }
      }
    }
    if (!found) unresolved.push(id);
    else if (!chosen.includes(found)) chosen.push(found);
  }
  if (unresolved.length === 0 && notes.length === 0) return { ok: true, groups: chosen };
  const lines = [...notes];
  if (unresolved.length > 0) {
    lines.push(`No Sandcastle group or solo issue matches ${unresolved.map((id) => JSON.stringify(id)).join(", ")}.`);
  }
  // Raw ids, not describeGroup's rendering: these are the strings you type.
  lines.push(`Groups on the board: ${board.map((g) => g.id).join(", ") || "(none)"}`);
  return { ok: false, message: lines.join("\n") };
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
 * the next group deserves its turn. "shared" is never read from text: it is
 * two issues failing alike back to back (see sharedFailure).
 */
export type FailureKind = "quota" | "auth" | "network" | "shared" | "local";

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
  // "You've hit your 5-hour limit · resets 1:20am (UTC)" — the session stop's
  // newer wording. Unmatched, an overnight run never slept: it failed every
  // issue as local for six cycles and opened the PR hours before the reset.
  /5-hour limit/i,
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

// `agy` reports its own failures on a line of their own, e.g. "AGY_ERROR:
// Your AI credits balance is too low to continue." Anchored to the start of a
// line, so an agent's output that merely quotes one — a diff or a test failure
// naming this repo's own fixtures — is not read as `agy` failing (#729).
const AGY_ERROR_LINE = /^AGY_ERROR\b.*/m;

/** The `AGY_ERROR` line `text` carries, if any — `agy`'s own error channel. */
export function agyErrorLine(text: string): string | undefined {
  return text.match(AGY_ERROR_LINE)?.[0];
}

/**
 * What an agent said, out of stdout that may be `agy`'s or Codex's event stream. That
 * stream carries every tool's output (`tool_info.output`), so a file the agent
 * merely read — this repo's own quota patterns, say — would read as a spent
 * quota. For an `agy` stream, only its final `result` (response and error)
 * and its non-JSON lines (`AGY_ERROR`) count; anything else is returned as-is.
 */
export function agentSaidText(stdout: string): string {
  const lines = stdout.split("\n");
  if (lines.some((line) => CODEX_EVENT_LINE.test(line))) return codexSaidText(lines);
  if (!lines.some((line) => line.startsWith('{"event":'))) return stdout;
  const said: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) {
      said.push(line);
      continue;
    }
    try {
      const { event, result } = JSON.parse(line) as {
        event?: string;
        result?: { response?: unknown; error?: unknown };
      };
      if (event !== "result") continue;
      for (const part of [result?.response, result?.error]) {
        if (typeof part === "string") said.push(part);
      }
    } catch {
      // A truncated JSON line carries nothing to judge.
    }
  }
  return said.join("\n");
}

// A `codex exec --json` event line. Its names are the thread, turn and item
// lifecycle `codex exec` prints, which Claude Code's stream never uses.
const CODEX_EVENT_LINE = /^\{"type":"(?:thread\.started|turn\.(?:started|completed|failed)|item\.(?:started|updated|completed))"/;

/**
 * What a Codex agent said, out of its `codex exec --json` stream. The stream
 * carries every command's output (`item.aggregated_output`), so only the
 * agent's own messages, Codex's `error` events, a failed turn's error and any
 * non-JSON line count, the same guard agy's stream gets above.
 */
function codexSaidText(lines: readonly string[]): string {
  const said: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) {
      said.push(line);
      continue;
    }
    try {
      const { type, item, message, error } = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: unknown };
        message?: unknown;
        error?: { message?: unknown };
      };
      if (type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        said.push(item.text);
      } else if (type === "error" && typeof message === "string") {
        said.push(message);
      } else if (type === "turn.failed" && typeof error?.message === "string") {
        said.push(error.message);
      }
    } catch {
      // A truncated JSON line carries nothing to judge.
    }
  }
  return said.join("\n");
}

// Codex's own usage-limit wording, e.g. "You've hit your usage limit. Upgrade
// to Plus to continue using Codex (...), or try again at 3:20 PM." and the
// `usage_limit_reached` error code. Distinct from Claude's QUOTA_PATTERNS
// above, which say "usage limit reached", never "hit your usage limit".
const CODEX_QUOTA_PATTERNS = [/hit your usage limit/i, /\busage_limit_reached\b/];

/** Whether `text` names a spent Codex usage limit. */
export function isCodexQuotaStop(text: string): boolean {
  return CODEX_QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

// Every way Codex 0.169.0 says a sign-in renewal failed (codex-rs/login, the
// REFRESH_TOKEN_*_MESSAGE constants), e.g. "Your access token could not be
// refreshed because your refresh token was already used. Please log out and
// sign in again." A sandbox's sign-in has no refresh token (lib/codex.mts
// sandboxAuth), so a renewal there always fails this way.
const CODEX_AUTH_PATTERNS = [/access token could not be refreshed/i];

/** Whether `text` names a Codex sign-in that could not be renewed. */
export function isCodexAuthStop(text: string): boolean {
  return CODEX_AUTH_PATTERNS.some((pattern) => pattern.test(text));
}

// `agy`'s own credit/quota wording on an AGY_ERROR line (e.g. "Your AI
// credits balance is too low to continue."), distinct from Claude's
// QUOTA_PATTERNS above — "credits balance" there, not "credit balance".
const AGY_QUOTA_PATTERNS = [
  /credits balance is too low/i,
  /insufficient credits/i,
  /out of credits/i,
  // "RESOURCE_EXHAUSTED (code 429): Individual quota reached. ... Resets in
  // 2h2m19s." Unmatched, a solo group spent its remaining cycles on it (#820).
  /quota reached/i,
  /RESOURCE_EXHAUSTED/,
];

/**
 * Whether an AGY_ERROR line names a spent Gemini quota or credits balance, as
 * opposed to any other `agy` failure (a model or agent error), which is the
 * group's own dead run rather than run-fatal.
 */
export function isAgyQuotaStop(line: string): boolean {
  return AGY_QUOTA_PATTERNS.some((pattern) => pattern.test(line));
}

/** When a quota stop saying "Resets in 2h2m19s" lifts, or undefined when it names no such time. */
export function parseQuotaResetIn(text: string, now: Date): Date | undefined {
  const match = text.match(/resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return new Date(now.getTime() + seconds * 1000);
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
 * The end of each stream, joined by a newline, within `tailChars`. The streams
 * are captured apart, so their interleaving is lost; keeping the end of both
 * stops noisy stderr from pushing a stdout failure out of the tail.
 */
function balancedTail(stdout: string, stderr: string, tailChars: number): string {
  if (stdout.length + 1 + stderr.length <= tailChars) return `${stdout}\n${stderr}`;
  const budget = Math.max(tailChars - 1, 0);
  const stderrShare = Math.min(stderr.length, Math.ceil(budget / 2));
  const stdoutShare = Math.min(stdout.length, budget - stderrShare);
  const stderrKept = Math.min(stderr.length, budget - stdoutShare);
  const end = (text: string, n: number) => (n > 0 ? text.slice(-n) : "");
  return `${end(stdout, stdoutShare)}\n${end(stderr, stderrKept)}`;
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
  const tail = balancedTail(stdout, stderr, tailChars);
  if (exitCode !== TIMEOUT_EXIT_CODE) return tail;
  return `The check timed out after ${CHECK_TIME_LIMIT_SECONDS / 60} minutes and was killed.\n\n${tail}`;
}

// What `gh` and `git` print on the host when GitHub cannot be reached (#999's
// run: a Wi-Fi drop burned all three attempts within seconds, then the push).
const GITHUB_UNREACHABLE = [
  /error connecting to (?:api\.)?github\.com/i,
  /Could not resolve host: (?:api\.)?github\.com/i,
  /Failed to connect to (?:api\.)?github\.com/i,
];

/** Whether a failure is the host losing GitHub, which says nothing about the issue. */
export function isGitHubUnreachable(text: string): boolean {
  return GITHUB_UNREACHABLE.some((pattern) => pattern.test(text));
}

/**
 * How long an agent may print nothing before the SDK kills it. The SDK's own
 * default is 600s, which a full `make test` (~10 minutes, silent) can outlast:
 * a Codex merger died mid-check on #1218's run. Half an hour is well past the
 * longest silent command and still ends a genuinely wedged agent.
 */
export const AGENT_IDLE_TIMEOUT_SECONDS = 30 * 60;

// npm's own error code when two sandboxes write the shared download cache at
// once (EEXIST on a rename into _cacache, #990's run) or a tree it is replacing
// (ENOTEMPTY). Anchored to npm's line, so a test merely printing one is no match.
const INSTALL_RACE = /^npm (?:error|ERR!) code (?:EEXIST|ENOTEMPTY)$/m;

/**
 * Whether a red check died installing rather than testing: a race over the
 * shared npm cache, which no change of the agent's caused or can fix. Worth one
 * re-run before an agent is handed the output.
 */
export function isInstallRace(stdout: string, stderr: string): boolean {
  return INSTALL_RACE.test(stderr) || INSTALL_RACE.test(stdout);
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
 * isSettledWithNothingToDo): the queue stops on that without replanning, so the
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

/** An implementer-complete marker's trailer, parsed from one commit's message. */
export interface ImplementerMarker {
  readonly issue: number;
}

/** A reviewer-complete marker's trailer, parsed from one commit's message. */
export interface ReviewerMarker {
  readonly issue: number;
}

/** What the PR writer drafted: the body, and the title when it wrote one. */
export interface WrittenPr {
  readonly title?: string;
  readonly body: string;
}

/** A PR-body marker, parsed from one commit's message. */
export interface PrBodyMarker extends WrittenPr {
  /** The integration branch the body was written for. */
  readonly batch: string;
}

const DONE_TRAILER = /^Sandcastle-Done:\s*#(\d+)\s*$/m;
const BATCH_TRAILER = /^Sandcastle-Batch:\s*(\S+)\s*$/m;
const IMPLEMENTER_TRAILER = /^Sandcastle-Implementer:\s*#(\d+)\s*$/m;
const REVIEWER_TRAILER = /^Sandcastle-Reviewer:\s*#(\d+)\s*$/m;
const PR_BODY_TRAILER = /^Sandcastle-Pr-Body:\s*(\S+)\s*$/m;
const PR_TITLE_TRAILER = /^Sandcastle-Pr-Title:[ \t]*(.+?)[ \t]*$/m;

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
 * Read an implementer marker's trailer out of one commit message, or
 * undefined if this commit does not carry it.
 */
export function parseImplementerTrailers(commitMessage: string): ImplementerMarker | undefined {
  const match = commitMessage.match(IMPLEMENTER_TRAILER);
  if (!match) return undefined;
  return { issue: Number(match[1]) };
}

/**
 * Read a reviewer marker's trailer out of one commit message, or
 * undefined if this commit does not carry it.
 */
export function parseReviewerTrailers(commitMessage: string): ReviewerMarker | undefined {
  const match = commitMessage.match(REVIEWER_TRAILER);
  if (!match) return undefined;
  return { issue: Number(match[1]) };
}

/**
 * Read a PR-body marker out of one commit message, or undefined if this
 * commit does not carry its trailer. The trailer alone makes it a marker; the
 * body is whatever the orchestrator wrote between the subject and the trailer,
 * and the title rides in its own trailer below it. A marker written before
 * titles were recorded has none.
 */
export function parsePrBodyTrailers(commitMessage: string): PrBodyMarker | undefined {
  const match = PR_BODY_TRAILER.exec(commitMessage);
  if (!match) return undefined;
  const aboveTrailer = commitMessage.slice(0, match.index).split("\n").slice(1);
  const title = commitMessage.slice(match.index).match(PR_TITLE_TRAILER)?.[1];
  const body = aboveTrailer.join("\n").trim();
  return title ? { batch: match[1], title, body } : { batch: match[1], body };
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
 * exactly the case the group queue exists for — a group whose blocker and
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

/**
 * Title the PR for a group's batch when the PR writer wrote none: a draft
 * batch, or a writer that left the title out.
 *
 * Follows the `pr` skill's title rule with the titles a human already wrote:
 * a batch serving a parent spec takes the spec's title, and otherwise the
 * first merged issue names it, with a count of the rest.
 */
export function buildPrTitle(
  group: Group,
  mergedIssues: { title: string }[],
  parentTitle: string | undefined,
): string {
  if (parentTitle) return parentTitle;
  const [first, ...rest] = mergedIssues.length > 0 ? mergedIssues : group.issues;
  if (!first) return describeGroup(group.id);
  if (rest.length === 0) return first.title;
  return `${first.title}, and ${rest.length} more change${rest.length === 1 ? "" : "s"}`;
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
 *
 * `implementers` adds one "implemented by" line per merged issue (#731), so a
 * reviewer can tell which work to scrutinise: a batch spans runs, and each run
 * can pick a different implementer. `byIssue` holds the label recorded for an
 * issue, `fallback` names the rest — an issue merged before a run recorded its
 * implementer has no entry. Omitted, the lines are left out entirely.
 *
 * `reviewers` (by issue), `merger` and `prWriter` are the labels those roles
 * recorded. They print only where agy or Codex ran, so a human reviewer knows
 * which parts of the batch Gemini or Codex produced and an all-Claude batch's body is
 * unchanged (#802).
 */
export function buildPrBody(options: {
  group: Group;
  mergedIssues: { id: string; title: string }[];
  blockedIssues: { id: string; title: string; blockedBy: number[]; heldIn?: string; lookupError?: string }[];
  complete: boolean;
  writeup?: string;
  implementers?: { byIssue: Record<string, string>; fallback: string };
  reviewers?: Record<string, string>;
  merger?: string;
  prWriter?: string;
}): string {
  const { group, mergedIssues, blockedIssues, complete, writeup, implementers, reviewers = {}, merger, prWriter } =
    options;
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
    // One block for who ran what: every merged issue's implementer, then only
    // the roles agy or Codex ran. Collected first so the blank line above them is
    // written once, and not at all for a body that names nobody.
    const byRole: string[] = [];
    if (implementers !== undefined) {
      byRole.push(
        ...mergedIssues.map((i) => `#${i.id}: implemented by ${implementers.byIssue[i.id] ?? implementers.fallback}`),
      );
    }
    byRole.push(
      ...mergedIssues
        .filter((i) => isNonClaudeLabel(reviewers[i.id]))
        .map((i) => `#${i.id}: reviewed by ${reviewers[i.id]}`),
    );
    if (isNonClaudeLabel(merger)) byRole.push(`Merged by ${merger}`);
    if (isNonClaudeLabel(prWriter)) byRole.push(`PR body written by ${prWriter}`);
    if (byRole.length > 0) lines.push("", ...byRole);
  } else {
    lines.push(
      "Carried forward from an earlier interrupted run; see the commits on this branch.",
    );
  }

  if (blockedIssues.length > 0) {
    lines.push("");
    lines.push("Excluded this batch — blocked:");
    lines.push(
      // No blockers means the issue ran out of attempts rather than waiting on
      // one, unless its branch is held by a foreign worktree or its lookup failed instead.
      ...blockedIssues.map((i) => {
        let reason: string;
        if (i.heldIn !== undefined) {
          reason = `checked out in foreign worktree ${i.heldIn}`;
        } else if (i.lookupError !== undefined) {
          reason = `blocker lookup failed: ${i.lookupError}`;
        } else if (i.blockedBy.length > 0) {
          reason = `blocked by ${i.blockedBy.map((n) => `#${n}`).join(", ")}`;
        } else {
          reason = "ran out of attempts";
        }
        return `- #${i.id}: ${i.title} (${reason})`;
      }),
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

/** How one issue's work ended: failed, or the commits it made and whether it signalled completion. */
export type IssueOutcome = { failed: boolean; commits: number; completed: boolean };

/** One failure, as the shared-failure backstop compares them: the issue and its message. */
export type IssueFailure = { issue: string; message: string };

/**
 * Did every issue the run worked prove there is nothing left for this group to do?
 * Pass each issue's final outcome, so an attempt that failed and was retried does not count.
 *
 * An issue that signals completion without producing a commit is telling us its
 * work was already done. When that holds for every issue that ran, replanning
 * can only produce the same answer, so the group is finished. A failure, or an
 * issue that never signalled, means the opposite — a retry may still get
 * somewhere.
 */
export function isSettledWithNothingToDo(outcomes: IssueOutcome[]): boolean {
  return (
    outcomes.length > 0 &&
    outcomes.every((o) => !o.failed && o.commits === 0 && o.completed)
  );
}

/**
 * The message two back-to-back failures share, when they come from different
 * issues, or undefined. `previous` is the failure just before `current` with
 * no success between them.
 *
 * The backstop behind classifyFailure() at queue level, as isDeadRun is at step
 * level: it needs no known wording. Different issues failing identically points
 * at the machine, the login or the quota, not at the issues, so more work would
 * fail the same way (2026-10-28: five cycles lost to a quota message no pattern
 * matched). One issue proves nothing, so it takes two, and the same issue
 * failing twice is its own problem. Each message has its own issue number
 * masked before comparing.
 */
export function sharedFailure(
  previous: IssueFailure | undefined,
  current: IssueFailure,
): string | undefined {
  if (!previous || previous.issue === current.issue) return undefined;
  const mask = ({ issue, message }: { issue: string; message: string }) =>
    message.replace(new RegExp(`\\b${issue}\\b`, "g"), "<issue>");
  return mask(previous) === mask(current) ? current.message : undefined;
}

/**
 * Issues merged by this run that a plan lists again. A merge carries the
 * issue's Done marker, so no later plan should hold it; any that come back
 * mean the markers are going unseen, and the queue would re-work finished
 * issues (#855). Compared against everything this run merged, not only the
 * latest merge.
 */
export function replannedAfterMerge(mergedThisRun: readonly string[], planned: readonly string[]): string[] {
  return planned.filter((id) => mergedThisRun.includes(id));
}
