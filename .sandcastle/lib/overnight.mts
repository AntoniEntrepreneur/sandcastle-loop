// Overnight mode: command-line parsing, the end time, and whether a quota stop
// is worth waiting out. Pure, so the orchestrator only wires clocks and sleeps in.

/**
 * Split a comma list of Codex account names, each `[a-z0-9-]+`, dropping
 * duplicates but keeping order. `source` names the flag or variable in the error.
 */
export function parseCodexAccountList(value: string | undefined, source: string): string[] {
  const names = (value ?? "").split(",");
  if (names.some((name) => !/^[a-z0-9-]+$/.test(name))) {
    throw new Error(
      `${source} wants a name of lowercase letters, digits and hyphens, or a comma list of them (got ${JSON.stringify(value ?? "")}).`,
    );
  }
  return [...new Set(names)];
}

/** The end time `--overnight` uses unless `--until` names another. */
export const DEFAULT_END_TIME = "05:00";

/** Slack after a stated reset, so the first call after waking is not refused. */
export const QUOTA_WAIT_MARGIN_MS = 2 * 60_000;

/** How long to wait on a quota stop that names no reset time before re-checking. */
export const QUOTA_RECHECK_MS = 60 * 60_000;

/** Agents every role flag accepts; absent means Claude Code, unchanged. */
export const IMPLEMENTERS = ["agy", "codex"] as const;
export type Implementer = (typeof IMPLEMENTERS)[number];

export type CommandLine = {
  /** Group ids as typed, in order, duplicates dropped; empty for a bare run. May be `refresh` or `prune` alone. */
  groups: string[];
  overnight: boolean;
  /** `HH:MM`, local time; set exactly when `overnight` is. */
  until?: string;
  /** `--implementer <agy|codex>`; absent (the default) means Claude Code. */
  implementer?: Implementer;
  /** `--reviewer <agy|codex>`; absent (the default) means Claude Code. */
  reviewer?: Implementer;
  /** `--merger <agy|codex>`; absent (the default) means Claude Code. */
  merger?: Implementer;
  /** `--pr-writer <agy|codex>`; absent (the default) means Claude Code. */
  prWriter?: Implementer;
  /** `--codex-account NAME[,NAME]`: the run's named Codex accounts in order of preference, each `[a-z0-9-]+`; absent means the default sign-in. */
  codexAccounts?: string[];
};

/** Parse `[group...] [--overnight] [--until HH:MM] [--implementer agy|codex] [--reviewer agy|codex] [--merger agy|codex] [--pr-writer agy|codex]`, in any order. Throws on anything else. */
export function parseCommandLine(args: readonly string[]): CommandLine {
  const groups: string[] = [];
  let overnight = false;
  let until: string | undefined;
  let implementer: Implementer | undefined;
  let reviewer: Implementer | undefined;
  let merger: Implementer | undefined;
  let prWriter: Implementer | undefined;
  let codexAccounts: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--overnight") {
      overnight = true;
    } else if (arg === "--until" || arg.startsWith("--until=")) {
      until = arg === "--until" ? args[++i] : arg.slice("--until=".length);
      if (!until || !parseClockTime(until)) {
        throw new Error(`--until wants a time as HH:MM, e.g. --until 06:30 (got ${JSON.stringify(until ?? "")}).`);
      }
    } else if (arg === "--implementer" || arg.startsWith("--implementer=")) {
      const value = arg === "--implementer" ? args[++i] : arg.slice("--implementer=".length);
      if (!isImplementer(value)) {
        throw new Error(
          `--implementer wants one of: ${IMPLEMENTERS.join(", ")} (got ${JSON.stringify(value ?? "")}).`,
        );
      }
      implementer = value;
    } else if (arg === "--reviewer" || arg.startsWith("--reviewer=")) {
      const value = arg === "--reviewer" ? args[++i] : arg.slice("--reviewer=".length);
      if (!isImplementer(value)) {
        throw new Error(
          `--reviewer wants one of: ${IMPLEMENTERS.join(", ")} (got ${JSON.stringify(value ?? "")}).`,
        );
      }
      reviewer = value;
    } else if (arg === "--merger" || arg.startsWith("--merger=")) {
      const value = arg === "--merger" ? args[++i] : arg.slice("--merger=".length);
      if (!isImplementer(value)) {
        throw new Error(
          `--merger wants one of: ${IMPLEMENTERS.join(", ")} (got ${JSON.stringify(value ?? "")}).`,
        );
      }
      merger = value;
    } else if (arg === "--pr-writer" || arg.startsWith("--pr-writer=")) {
      const value = arg === "--pr-writer" ? args[++i] : arg.slice("--pr-writer=".length);
      if (!isImplementer(value)) {
        throw new Error(
          `--pr-writer wants one of: ${IMPLEMENTERS.join(", ")} (got ${JSON.stringify(value ?? "")}).`,
        );
      }
      prWriter = value;
    } else if (arg === "--codex-account" || arg.startsWith("--codex-account=")) {
      const value = arg === "--codex-account" ? args[++i] : arg.slice("--codex-account=".length);
      codexAccounts = parseCodexAccountList(value, "--codex-account");
    } else if (arg.startsWith("--")) {
      throw new Error(
        `Unknown option ${arg}. Options: --overnight, --until HH:MM, --implementer ${IMPLEMENTERS.join("|")}, --reviewer ${IMPLEMENTERS.join("|")}, --merger ${IMPLEMENTERS.join("|")}, --pr-writer ${IMPLEMENTERS.join("|")}, --codex-account NAME[,NAME].`,
      );
    } else {
      // `278 251`, `278,251` and `278, 251` all mean the same list.
      for (const piece of arg.split(",")) {
        const id = piece.trim();
        if (id && !groups.includes(id)) groups.push(id);
      }
    }
  }
  if (groups.includes("refresh") && groups.length > 1) {
    throw new Error("`refresh` cannot be combined with group ids.");
  }
  if (until && !overnight) throw new Error("--until only applies to an --overnight run.");
  if (codexAccounts !== undefined && ![implementer, reviewer, merger, prWriter].includes("codex")) {
    throw new Error("--codex-account needs a role on Codex, e.g. --implementer codex.");
  }
  return {
    groups,
    overnight,
    until: overnight ? (until ?? DEFAULT_END_TIME) : undefined,
    implementer,
    reviewer,
    merger,
    prWriter,
    ...(codexAccounts === undefined ? {} : { codexAccounts }),
  };
}

/** Whether `value` names an implementer `--implementer` accepts. */
function isImplementer(value: string | undefined): value is Implementer {
  return IMPLEMENTERS.some((known) => known === value);
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

/** Whose quota stopped the run. Each keeps its own reset clock, so one never wakes or blocks the other (#732). */
export type QuotaProvider = "claude" | "gemini" | "codex";

export type QuotaWaitPlan =
  | {
      wait: true;
      until: Date;
      /** Re-check the quota on waking, since no reset time was known. */
      recheck: boolean;
      /** Codex with several accounts: the account to carry on with after waking. */
      account?: string;
      swapTo?: undefined;
    }
  | { wait: false; reason: string; swapTo?: undefined }
  /** Codex: another listed account has quota, so carry on with it now. */
  | { wait: false; swapTo: string; reason?: undefined };

/** One Codex account's quota reading, as the wait planner needs it. */
export type CodexAccountReading = { spent: boolean; kind?: QuotaStopKind; resetAt?: Date };

/** Decide whether to sleep through a quota stop, and until when. */
export function planQuotaWait(stop: {
  provider: QuotaProvider;
  kind: QuotaStopKind;
  /**
   * Each provider's known reset. Only the stopped provider's counts, and one
   * already past counts as unknown: the quota is still spent, so it was wrong.
   */
  resets: Partial<Record<QuotaProvider, Date>>;
  now: Date;
  /** Waiting is switched on (`--overnight` or SANDCASTLE_WAIT_FOR_QUOTA=1). */
  waiting: boolean;
  /** The end time, when the run has one. */
  endAt: Date | undefined;
  /** A Codex stop with several accounts listed: the list, the one in use, and each one's reading. */
  codex?: { accounts: string[]; current: string; readings: Record<string, CodexAccountReading | undefined> };
}): QuotaWaitPlan {
  // Why the reading check: a stop whose own account now reads as having quota is stale
  // (it reset meanwhile), so swapping away from it would abandon a usable account.
  if (
    stop.provider === "codex" &&
    stop.codex &&
    stop.codex.accounts.length > 1 &&
    stop.codex.readings[stop.codex.current]?.spent !== false
  ) {
    const { accounts, current, readings } = stop.codex;
    const next = accounts.find((name) => name !== current && readings[name] && !readings[name]!.spent);
    if (next !== undefined) return { wait: false, swapTo: next };
    if (!stop.waiting) return { wait: false, reason: "waiting is off" };
    const waitable = accounts.filter(
      (name) => (name === current ? stop.kind : (readings[name]?.kind ?? "session")) === "session",
    );
    if (waitable.length === 0) {
      return { wait: false, reason: "a weekly limit or an empty credit balance is not waited out" };
    }
    const future = (name: string) => {
      const at = name === current ? (readings[name]?.resetAt ?? stop.resets.codex) : readings[name]?.resetAt;
      return at && at.getTime() > stop.now.getTime() ? at : undefined;
    };
    // Each account wakes at its reset plus the margin, or an hour on if that is unknown;
    // the earliest wakes the run, so an unknown reset is re-checked rather than ignored.
    const wakeAt = (name: string) => {
      const resetAt = future(name);
      return resetAt
        ? { until: new Date(resetAt.getTime() + QUOTA_WAIT_MARGIN_MS), recheck: false }
        : { until: new Date(stop.now.getTime() + QUOTA_RECHECK_MS), recheck: true };
    };
    const account = waitable.reduce((a, b) => (wakeAt(b).until.getTime() < wakeAt(a).until.getTime() ? b : a));
    const { until, recheck } = wakeAt(account);
    if (stop.endAt && until.getTime() >= stop.endAt.getTime()) {
      return { wait: false, reason: "the quota would come back after the end time" };
    }
    return { wait: true, until, recheck, account };
  }
  if (!stop.waiting) return { wait: false, reason: "waiting is off" };
  if (stop.kind === "weekly") return { wait: false, reason: "a weekly limit is not waited out" };
  if (stop.kind === "credit") return { wait: false, reason: "an empty credit balance does not reset" };
  const known = stop.resets[stop.provider];
  const resetAt = known && known.getTime() > stop.now.getTime() ? known : undefined;
  const until = resetAt
    ? new Date(resetAt.getTime() + QUOTA_WAIT_MARGIN_MS)
    : new Date(stop.now.getTime() + QUOTA_RECHECK_MS);
  if (stop.endAt && until.getTime() >= stop.endAt.getTime()) {
    return { wait: false, reason: "the quota would come back after the end time" };
  }
  return { wait: true, until, recheck: !resetAt };
}
