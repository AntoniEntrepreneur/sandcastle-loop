// Overnight mode: command-line parsing, the end time, and whether a quota stop
// is worth waiting out. Pure, so the orchestrator only wires clocks and sleeps in.

/** The end time `--overnight` uses unless `--until` names another. */
export const DEFAULT_END_TIME = "04:00";

/** Slack after a stated reset, so the first call after waking is not refused. */
export const QUOTA_WAIT_MARGIN_MS = 2 * 60_000;

/** How long to wait on a quota stop that names no reset time before re-checking. */
export const QUOTA_RECHECK_MS = 60 * 60_000;

export type CommandLine = {
  /** A group id, or `refresh`. */
  group?: string;
  overnight: boolean;
  /** `HH:MM`, local time; set exactly when `overnight` is. */
  until?: string;
};

/** Parse `[group] [--overnight] [--until HH:MM]`, in any order. Throws on anything else. */
export function parseCommandLine(args: readonly string[]): CommandLine {
  let group: string | undefined;
  let overnight = false;
  let until: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--overnight") {
      overnight = true;
    } else if (arg === "--until" || arg.startsWith("--until=")) {
      until = arg === "--until" ? args[++i] : arg.slice("--until=".length);
      if (!until || !parseClockTime(until)) {
        throw new Error(`--until wants a time as HH:MM, e.g. --until 06:30 (got ${JSON.stringify(until ?? "")}).`);
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}. Options: --overnight, --until HH:MM.`);
    } else if (group === undefined) {
      group = arg;
    } else {
      throw new Error(`One group at a time — got both ${JSON.stringify(group)} and ${JSON.stringify(arg)}.`);
    }
  }
  if (until && !overnight) throw new Error("--until only applies to an --overnight run.");
  return { group, overnight, until: overnight ? (until ?? DEFAULT_END_TIME) : undefined };
}

/** Read `HH:MM` (24-hour) as hours and minutes, or undefined. */
function parseClockTime(text: string): { hour: number; minute: number } | undefined {
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

/** The next instant after `now` at which the local clock reads `clock` (`HH:MM`). */
export function nextClockTime(clock: string, now: Date): Date {
  const parsed = parseClockTime(clock);
  if (!parsed) throw new Error(`Not a HH:MM time: ${clock}`);
  const at = new Date(now);
  at.setHours(parsed.hour, parsed.minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Which kind of quota stop a message names. A weekly limit and an empty credit
 * balance are not worth waiting for: the first can be days away, the second
 * never lifts by itself.
 */
export type QuotaStopKind = "session" | "weekly" | "credit";

/** Classify the text of a quota stop. */
export function quotaStopKind(text: string): QuotaStopKind {
  if (/credit balance is too low|insufficient credits/i.test(text)) return "credit";
  if (/weekly limit/i.test(text)) return "weekly";
  return "session";
}

export type QuotaWaitPlan =
  | { wait: true; until: Date; /** Re-check the quota on waking, since no reset time was known. */ recheck: boolean }
  | { wait: false; reason: string };

/** Decide whether to sleep through a quota stop, and until when. */
export function planQuotaWait(stop: {
  kind: QuotaStopKind;
  resetAt: Date | undefined;
  now: Date;
  /** Waiting is switched on (`--overnight` or SANDCASTLE_WAIT_FOR_QUOTA=1). */
  waiting: boolean;
  /** The end time, when the run has one. */
  endAt: Date | undefined;
}): QuotaWaitPlan {
  if (!stop.waiting) return { wait: false, reason: "waiting is off" };
  if (stop.kind === "weekly") return { wait: false, reason: "a weekly limit is not waited out" };
  if (stop.kind === "credit") return { wait: false, reason: "an empty credit balance does not reset" };
  const until = stop.resetAt
    ? new Date(stop.resetAt.getTime() + QUOTA_WAIT_MARGIN_MS)
    : new Date(stop.now.getTime() + QUOTA_RECHECK_MS);
  if (stop.endAt && until.getTime() >= stop.endAt.getTime()) {
    return { wait: false, reason: "the quota would come back after the end time" };
  }
  return { wait: true, until, recheck: !stop.resetAt };
}
