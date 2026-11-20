// Unit tests for overnight mode: the command line, the end time, and quota waiting.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QUOTA_RECHECK_MS,
  QUOTA_WAIT_MARGIN_MS,
  nextClockTime,
  parseCommandLine,
  planQuotaWait,
  quotaStopKind,
} from "./overnight.mts";
import { classifyFailure } from "./groups.mts";

/** Pins that a bare run has no group and is not overnight. */
test("parseCommandLine reads no arguments as a plain run", () => {
  assert.deepEqual(parseCommandLine([]), {
    groups: [],
    overnight: false,
    until: undefined,
    implementer: undefined,
    reviewer: undefined,
    merger: undefined,
    prWriter: undefined,
  });
});

/** Pins that --overnight defaults the end time to 05:00 and sits on either side of the group. */
test("parseCommandLine takes --overnight before or after the group, defaulting to 05:00", () => {
  const expected = {
    groups: ["244"],
    overnight: true,
    until: "05:00",
    implementer: undefined,
    reviewer: undefined,
    merger: undefined,
    prWriter: undefined,
  };
  assert.deepEqual(parseCommandLine(["244", "--overnight"]), expected);
  assert.deepEqual(parseCommandLine(["--overnight", "244"]), expected);
});

/** Pins that commas, spaces and comma-plus-space all give the same list, duplicates dropped (#836). */
test("parseCommandLine splits group ids on commas and spaces and drops duplicates", () => {
  const want = ["278", "251", "555"];
  assert.deepEqual(parseCommandLine(["278", "251", "555"]).groups, want);
  assert.deepEqual(parseCommandLine(["278,251,555"]).groups, want);
  assert.deepEqual(parseCommandLine(["278,", "251,", "555"]).groups, want);
  assert.deepEqual(parseCommandLine(["278, 251", ",555,", "251", "278"]).groups, want);
  assert.deepEqual(parseCommandLine(["solo-5", "--overnight", "9"]).groups, ["solo-5", "9"]);
});

/** Pins that `refresh` takes no group ids (#836). */
test("parseCommandLine refuses refresh together with a group id", () => {
  assert.throws(() => parseCommandLine(["refresh", "278"]), /refresh/);
  assert.throws(() => parseCommandLine(["278,refresh"]), /refresh/);
  assert.deepEqual(parseCommandLine(["refresh"]).groups, ["refresh"]);
});

/** Pins both spellings of --until. */
test("parseCommandLine reads --until HH:MM and --until=HH:MM", () => {
  assert.equal(parseCommandLine(["--overnight", "--until", "06:30"]).until, "06:30");
  assert.equal(parseCommandLine(["--overnight", "--until=7:05"]).until, "7:05");
});

/** Pins the command lines that are refused rather than guessed at. */
test("parseCommandLine refuses bad times, unknown options, two groups, and --until alone", () => {
  assert.throws(() => parseCommandLine(["--overnight", "--until", "25:00"]), /HH:MM/);
  assert.throws(() => parseCommandLine(["--overnight", "--until"]), /HH:MM/);
  assert.throws(() => parseCommandLine(["--overnight", "--until", "4am"]), /HH:MM/);
  assert.throws(
    () => parseCommandLine(["--wait"]),
    /Unknown option --wait\. Options:.*--reviewer agy.*--merger agy.*--pr-writer agy/,
  );
  assert.throws(() => parseCommandLine(["--until", "04:00"]), /--overnight/);
});

/** Pins `--implementer agy`, on either side of a group id, and that no flag means Claude. */
test("parseCommandLine reads --implementer agy, defaulting to Claude without the flag", () => {
  assert.deepEqual(parseCommandLine(["244", "--implementer", "agy"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: "agy",
    reviewer: undefined,
    merger: undefined,
    prWriter: undefined,
  });
  assert.deepEqual(parseCommandLine(["--implementer=agy", "244"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: "agy",
    reviewer: undefined,
    merger: undefined,
    prWriter: undefined,
  });
  assert.equal(parseCommandLine([]).implementer, undefined);
  assert.equal(parseCommandLine(["244"]).implementer, undefined);
});

/** Pins that an unknown implementer is refused. */
test("parseCommandLine refuses an unknown --implementer", () => {
  assert.throws(() => parseCommandLine(["--implementer", "cursor"]), /--implementer wants one of: agy, codex/);
});

/** Pins that every role flag accepts codex, on its own or beside agy on another role. */
test("parseCommandLine reads codex for every role flag", () => {
  assert.deepEqual(
    parseCommandLine(["244", "--implementer", "codex", "--reviewer=codex", "--merger", "agy", "--pr-writer=codex"]),
    {
      groups: ["244"],
      overnight: false,
      until: undefined,
      implementer: "codex",
      reviewer: "codex",
      merger: "agy",
      prWriter: "codex",
    },
  );
});

/** Pins `--reviewer agy`, on either side of a group id, and that no flag means Claude. */
test("parseCommandLine reads --reviewer agy, defaulting to Claude without the flag", () => {
  assert.deepEqual(parseCommandLine(["244", "--reviewer", "agy"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: undefined,
    reviewer: "agy",
    merger: undefined,
    prWriter: undefined,
  });
  assert.deepEqual(parseCommandLine(["--reviewer=agy", "244"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: undefined,
    reviewer: "agy",
    merger: undefined,
    prWriter: undefined,
  });
  assert.equal(parseCommandLine([]).reviewer, undefined);
  assert.equal(parseCommandLine(["244"]).reviewer, undefined);
});

/** Pins that an unknown reviewer is refused with the accepted list. */
test("parseCommandLine refuses an unknown --reviewer", () => {
  assert.throws(() => parseCommandLine(["--reviewer", "cursor"]), /--reviewer wants one of: agy, codex \(got "cursor"\)\./);
  assert.throws(() => parseCommandLine(["--reviewer=cursor"]), /--reviewer wants one of: agy, codex \(got "cursor"\)\./);
});

/** Pins that --reviewer agy combines with --implementer agy, --overnight and --until. */
test("parseCommandLine accepts --reviewer agy combined with --implementer, --overnight and --until", () => {
  assert.deepEqual(
    parseCommandLine(["244", "--implementer", "agy", "--reviewer", "agy", "--overnight", "--until", "06:30"]),
    {
      groups: ["244"],
      overnight: true,
      until: "06:30",
      implementer: "agy",
      reviewer: "agy",
      merger: undefined,
      prWriter: undefined,
    },
  );
  assert.deepEqual(
    parseCommandLine(["--reviewer=agy", "--implementer=agy", "--overnight"]),
    {
      groups: [],
      overnight: true,
      until: "05:00",
      implementer: "agy",
      reviewer: "agy",
      merger: undefined,
      prWriter: undefined,
    },
  );
});

/** Pins `--merger agy`, on either side of a group id, and that no flag means Claude (#804). */
test("parseCommandLine reads --merger agy, defaulting to Claude without the flag", () => {
  assert.deepEqual(parseCommandLine(["244", "--merger", "agy"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: undefined,
    reviewer: undefined,
    merger: "agy",
    prWriter: undefined,
  });
  assert.deepEqual(parseCommandLine(["--merger=agy", "244"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: undefined,
    reviewer: undefined,
    merger: "agy",
    prWriter: undefined,
  });
  assert.equal(parseCommandLine([]).merger, undefined);
  assert.equal(parseCommandLine(["244"]).merger, undefined);
});

/** Pins that an unknown merger is refused and names accepted values (#804). */
test("parseCommandLine refuses an unknown --merger", () => {
  assert.throws(
    () => parseCommandLine(["--merger", "cursor"]),
    /--merger wants one of: agy, codex \(got "cursor"\)\./,
  );
});

/** Pins that role flags combine with each other and with other options (#804). */
test("parseCommandLine combines --merger with other role flags and options", () => {
  assert.deepEqual(parseCommandLine(["244", "--implementer", "agy", "--merger=agy"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: "agy",
    reviewer: undefined,
    merger: "agy",
    prWriter: undefined,
  });
  assert.deepEqual(parseCommandLine(["--merger", "agy", "--overnight"]), {
    groups: [],
    overnight: true,
    until: "05:00",
    implementer: undefined,
    reviewer: undefined,
    merger: "agy",
    prWriter: undefined,
  });
});

/** Pins `--pr-writer agy`, both flag forms, default to Claude, unknown value refusal, and combinations (#805). */
test("parseCommandLine reads --pr-writer agy, both forms, refusing unknown values", () => {
  assert.deepEqual(parseCommandLine(["244", "--pr-writer", "agy"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: undefined,
    reviewer: undefined,
    merger: undefined,
    prWriter: "agy",
  });
  assert.deepEqual(parseCommandLine(["--pr-writer=agy", "244"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: undefined,
    reviewer: undefined,
    merger: undefined,
    prWriter: "agy",
  });
  assert.equal(parseCommandLine([]).prWriter, undefined);
  assert.equal(parseCommandLine(["244"]).prWriter, undefined);
  assert.throws(() => parseCommandLine(["--pr-writer", "cursor"]), /--pr-writer wants one of: agy, codex/);
});

/** Pins combining --pr-writer agy with other role flags and overnight (#805). */
test("parseCommandLine accepts --pr-writer agy combined with other role flags and overnight", () => {
  assert.deepEqual(parseCommandLine(["244", "--implementer", "agy", "--pr-writer", "agy"]), {
    groups: ["244"],
    overnight: false,
    until: undefined,
    implementer: "agy",
    reviewer: undefined,
    merger: undefined,
    prWriter: "agy",
  });
  assert.deepEqual(parseCommandLine(["--implementer=agy", "--pr-writer=agy", "--overnight"]), {
    groups: [],
    overnight: true,
    until: "05:00",
    implementer: "agy",
    reviewer: undefined,
    merger: undefined,
    prWriter: "agy",
  });
});

/** Pins that --overnight is accepted with agy, now that a Gemini quota stop is waited out (#732). */
test("parseCommandLine accepts --overnight together with --implementer agy", () => {
  assert.deepEqual(parseCommandLine(["--implementer", "agy", "--overnight"]), {
    groups: [],
    overnight: true,
    until: "05:00",
    implementer: "agy",
    reviewer: undefined,
    merger: undefined,
    prWriter: undefined,
  });
});

/** Pins that the end time is the next 04:00, whether started before or after midnight. */
test("nextClockTime picks the next occurrence of the clock time", () => {
  const evening = new Date(2026, 9, 7, 23, 0);
  assert.deepEqual(nextClockTime("04:00", evening), new Date(2026, 9, 8, 4, 0));
  const smallHours = new Date(2026, 9, 8, 1, 30);
  assert.deepEqual(nextClockTime("04:00", smallHours), new Date(2026, 9, 8, 4, 0));
  const exactly = new Date(2026, 9, 8, 4, 0);
  assert.deepEqual(nextClockTime("04:00", exactly), new Date(2026, 9, 9, 4, 0));
});

/** Pins which quota stops are worth waiting for. */
test("quotaStopKind tells session, weekly and credit stops apart", () => {
  assert.equal(quotaStopKind("You've hit your session limit · resets 1:10pm (UTC)"), "session");
  assert.equal(quotaStopKind("Claude AI usage limit reached|1700000000"), "session");
  assert.equal(quotaStopKind("You've hit your weekly limit · resets 2am (UTC)"), "weekly");
  assert.equal(quotaStopKind("Credit balance is too low"), "credit");
});

/** Pins that the 5-hour wording of a session stop is waited out, not failed per issue. */
test("classifyFailure reads a 5-hour limit as a session quota stop", () => {
  const text = "You've hit your 5-hour limit · resets 1:20am (UTC)";
  assert.equal(classifyFailure(text), "quota");
  assert.equal(quotaStopKind(text), "session");
});

/** Pins that a weekly limit ends the run instead of failing one group and starting the next. */
test("classifyFailure reads a weekly limit as a quota stop", () => {
  assert.equal(classifyFailure("You've hit your weekly limit · resets 2am (UTC)"), "quota");
});

const NOW = new Date("2026-10-07T23:00:00Z");
const END = new Date("2026-10-08T04:00:00Z");
const RESET = new Date("2026-10-08T01:10:00Z");

/** Pins that a stated reset before the end time is waited out, plus the margin. */
test("planQuotaWait waits until a stated reset plus the margin", () => {
  assert.deepEqual(
    planQuotaWait({ provider: "claude", kind: "session", resets: { claude: RESET }, now: NOW, waiting: true, endAt: END }),
    { wait: true, until: new Date(RESET.getTime() + QUOTA_WAIT_MARGIN_MS), recheck: false },
  );
});

/** Pins that a stop with no reset time waits an hour and asks for a re-check. */
test("planQuotaWait waits an hour and re-checks when no reset time is known", () => {
  assert.deepEqual(
    planQuotaWait({ provider: "claude", kind: "session", resets: {}, now: NOW, waiting: true, endAt: END }),
    { wait: true, until: new Date(NOW.getTime() + QUOTA_RECHECK_MS), recheck: true },
  );
});

/** Pins that a saved reset already past is not trusted: the quota is still spent, so it re-checks. */
test("planQuotaWait treats a reset already past as unknown", () => {
  const past = new Date(NOW.getTime() - 60_000);
  assert.deepEqual(
    planQuotaWait({ provider: "claude", kind: "session", resets: { claude: past }, now: NOW, waiting: true, endAt: END }),
    { wait: true, until: new Date(NOW.getTime() + QUOTA_RECHECK_MS), recheck: true },
  );
});

/** Pins that a reset at or after the end time is not waited for. */
test("planQuotaWait does not wait past the end time", () => {
  const late = new Date(END.getTime() - QUOTA_WAIT_MARGIN_MS);
  const plan = planQuotaWait({
    provider: "claude",
    kind: "session",
    resets: { claude: late },
    now: NOW,
    waiting: true,
    endAt: END,
  });
  assert.equal(plan.wait, false);
});

/** Pins that waiting with no end time waits however long the reset is. */
test("planQuotaWait without an end time waits for any stated reset", () => {
  const far = new Date("2026-10-08T22:00:00Z");
  assert.equal(
    planQuotaWait({
      provider: "claude",
      kind: "session",
      resets: { claude: far },
      now: NOW,
      waiting: true,
      endAt: undefined,
    }).wait,
    true,
  );
});

const GEMINI_RESET = new Date("2026-10-08T02:30:00Z");

/** Pins that a Gemini quota stop waits until Gemini's reset plus the margin (#732). */
test("planQuotaWait waits a Gemini stop until the Gemini reset", () => {
  assert.deepEqual(
    planQuotaWait({
      provider: "gemini",
      kind: "session",
      resets: { gemini: GEMINI_RESET },
      now: NOW,
      waiting: true,
      endAt: END,
    }),
    { wait: true, until: new Date(GEMINI_RESET.getTime() + QUOTA_WAIT_MARGIN_MS), recheck: false },
  );
});

/** Pins that a Gemini reset at or after the end time is not waited for. */
test("planQuotaWait does not wait a Gemini stop past the end time", () => {
  const late = new Date(END.getTime() - QUOTA_WAIT_MARGIN_MS);
  const plan = planQuotaWait({
    provider: "gemini",
    kind: "session",
    resets: { gemini: late },
    now: NOW,
    waiting: true,
    endAt: END,
  });
  assert.equal(plan.wait, false);
});

/** Pins that each provider's stop waits on its own clock, never the other's (#732). */
test("planQuotaWait keeps the Claude and Gemini clocks apart", () => {
  const both = { claude: RESET, gemini: GEMINI_RESET };
  const base = { kind: "session" as const, now: NOW, waiting: true, endAt: END };
  assert.deepEqual(planQuotaWait({ ...base, provider: "gemini", resets: both }), {
    wait: true,
    until: new Date(GEMINI_RESET.getTime() + QUOTA_WAIT_MARGIN_MS),
    recheck: false,
  });
  assert.deepEqual(planQuotaWait({ ...base, provider: "claude", resets: both }), {
    wait: true,
    until: new Date(RESET.getTime() + QUOTA_WAIT_MARGIN_MS),
    recheck: false,
  });
  // Only the other provider's reset known: an hour and a re-check, not its reset.
  assert.deepEqual(planQuotaWait({ ...base, provider: "gemini", resets: { claude: RESET } }), {
    wait: true,
    until: new Date(NOW.getTime() + QUOTA_RECHECK_MS),
    recheck: true,
  });
  assert.deepEqual(planQuotaWait({ ...base, provider: "claude", resets: { gemini: GEMINI_RESET } }), {
    wait: true,
    until: new Date(NOW.getTime() + QUOTA_RECHECK_MS),
    recheck: true,
  });
});

/** Pins the stops that are never waited for. */
test("planQuotaWait never waits for a weekly limit, a credit balance, or with waiting off", () => {
  const base = { provider: "claude" as const, resets: { claude: RESET }, now: NOW, endAt: END };
  assert.equal(planQuotaWait({ ...base, kind: "weekly", waiting: true }).wait, false);
  assert.equal(planQuotaWait({ ...base, kind: "credit", waiting: true }).wait, false);
  assert.equal(planQuotaWait({ ...base, kind: "session", waiting: false }).wait, false);
});

/** Pins `--codex-account`: the name rule, the no-Codex-role error, and that no flag means the default. */
test("parseCommandLine reads --codex-account and refuses a bad name or a run with no Codex role", () => {
  assert.deepEqual(parseCommandLine(["--implementer", "codex", "--codex-account", "b"]).codexAccounts, ["b"]);
  assert.deepEqual(parseCommandLine(["--merger=codex", "--codex-account=work-2"]).codexAccounts, ["work-2"]);
  assert.equal(parseCommandLine(["--implementer", "codex"]).codexAccounts, undefined);
  assert.deepEqual(parseCommandLine(["--implementer", "codex", "--codex-account", "a,b,a"]).codexAccounts, ["a", "b"]);
  for (const bad of ["a,B", "a,,b", "a,", ",a"]) {
    assert.throws(() => parseCommandLine(["--implementer", "codex", `--codex-account=${bad}`]), /--codex-account wants a name/);
  }
  assert.throws(() => parseCommandLine(["--codex-account", "a,b"]), /needs a role on Codex/);
  for (const bad of ["B", "a/b", "../x", "a_b", ""]) {
    assert.throws(
      () => parseCommandLine(["--implementer", "codex", "--codex-account", bad]),
      /--codex-account wants a name/,
    );
  }
  assert.throws(() => parseCommandLine(["--codex-account", "b"]), /needs a role on Codex/);
  assert.throws(() => parseCommandLine(["--implementer", "agy", "--codex-account", "b"]), /needs a role on Codex/);
});

/** Pins that a Codex quota stop is waited out overnight under the same rules as Claude's (#1205). */
test("planQuotaWait waits for Codex overnight, but not for a weekly limit or past the end time", () => {
  const stop = { provider: "codex" as const, now: NOW, resets: { codex: RESET } };
  const session = planQuotaWait({ ...stop, kind: "session", waiting: true, endAt: undefined });
  assert.deepEqual(session, { wait: true, until: new Date(RESET.getTime() + QUOTA_WAIT_MARGIN_MS), recheck: false });
  assert.equal(planQuotaWait({ ...stop, kind: "weekly", waiting: true, endAt: undefined }).wait, false);
  assert.equal(planQuotaWait({ ...stop, kind: "session", waiting: true, endAt: RESET }).wait, false);
  assert.equal(planQuotaWait({ ...stop, kind: "session", waiting: false, endAt: undefined }).wait, false);
});

const spent = (kind: "session" | "weekly" | "credit", resetAt?: Date) => ({ spent: true, kind, resetAt });
const fresh = { spent: false } as const;

/** Pins rule 1 of #1232: a stop of any kind swaps to the first other account with quota. */
test("planQuotaWait swaps a Codex stop to the first other account with quota, in list order", () => {
  const base = { provider: "codex" as const, now: NOW, resets: {}, endAt: undefined };
  const accounts = { accounts: ["antoni", "main"], current: "antoni" };
  assert.deepEqual(
    planQuotaWait({
      ...base,
      kind: "weekly",
      waiting: true,
      codex: { ...accounts, readings: { antoni: spent("weekly"), main: fresh } },
    }),
    { wait: false, swapTo: "main" },
  );
  assert.deepEqual(
    planQuotaWait({
      ...base,
      kind: "session",
      waiting: false,
      codex: { ...accounts, readings: { antoni: spent("session", RESET), main: fresh } },
    }),
    { wait: false, swapTo: "main" },
  );
  assert.deepEqual(
    planQuotaWait({
      ...base,
      kind: "credit",
      waiting: false,
      codex: {
        accounts: ["a", "b", "c"],
        current: "a",
        readings: { a: spent("credit"), b: spent("session", RESET), c: fresh },
      },
    }),
    { wait: false, swapTo: "c" },
  );
});

/** Pins rules 2-4 of #1232: with every account spent, wait for the earliest waitable reset or stop. */
test("planQuotaWait with every Codex account spent waits for the earliest waitable reset, or stops", () => {
  const early = new Date(RESET.getTime() - 60 * 60_000);
  const base = { provider: "codex" as const, now: NOW, resets: {}, kind: "session" as const };
  const accounts = { accounts: ["antoni", "main"], current: "antoni" };
  const both = { antoni: spent("session", RESET), main: spent("session", early) };
  assert.deepEqual(
    planQuotaWait({ ...base, waiting: true, endAt: undefined, codex: { ...accounts, readings: both } }),
    { wait: true, until: new Date(early.getTime() + QUOTA_WAIT_MARGIN_MS), recheck: false, account: "main" },
  );
  assert.equal(
    planQuotaWait({ ...base, waiting: true, endAt: early, codex: { ...accounts, readings: both } }).wait,
    false,
  );
  assert.equal(
    planQuotaWait({ ...base, waiting: false, endAt: undefined, codex: { ...accounts, readings: both } }).wait,
    false,
  );
  const weekly = { antoni: spent("weekly"), main: spent("credit") };
  assert.equal(
    planQuotaWait({ ...base, kind: "weekly", waiting: true, endAt: undefined, codex: { ...accounts, readings: weekly } })
      .wait,
    false,
  );
});

/** Pins that the earliest reset among accounts is waited on, and refused past UNTIL. */
test("planQuotaWait waits for main (01:40), not antoni (03:10), and stops when that is past UNTIL", () => {
  const now = new Date("2026-11-18T00:00:00Z");
  const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00Z`);
  const base = {
    provider: "codex" as const,
    kind: "session" as const,
    resets: { codex: at("03:10") },
    now,
    waiting: true,
    codex: {
      accounts: ["antoni", "main"],
      current: "antoni",
      readings: { antoni: spent("session", at("03:10")), main: spent("session", at("01:40")) },
    },
  };
  assert.deepEqual(planQuotaWait({ ...base, endAt: at("07:00") }), {
    wait: true,
    until: new Date(at("01:40").getTime() + QUOTA_WAIT_MARGIN_MS),
    recheck: false,
    account: "main",
  });
  assert.equal(planQuotaWait({ ...base, endAt: at("01:40") }).wait, false);
});

test("planQuotaWait with no reset known re-checks the account being waited on", () => {
  const plan = planQuotaWait({
    provider: "codex",
    kind: "session",
    resets: {},
    now: NOW,
    waiting: true,
    endAt: undefined,
    codex: { accounts: ["a", "b"], current: "b", readings: { a: spent("weekly"), b: spent("session") } },
  });
  assert.deepEqual(plan, { wait: true, until: new Date(NOW.getTime() + QUOTA_RECHECK_MS), recheck: true, account: "b" });
});

/** Pins that a stop whose own account now reads as having quota is not swapped away from. */
test("planQuotaWait does not swap away from a Codex account whose reading shows quota", () => {
  const plan = planQuotaWait({
    provider: "codex",
    kind: "session",
    resets: { codex: RESET },
    now: NOW,
    waiting: false,
    endAt: undefined,
    codex: { accounts: ["antoni", "main"], current: "antoni", readings: { antoni: fresh, main: fresh } },
  });
  assert.equal(plan.swapTo, undefined);
});

/** Pins rule 3 of #1232: an account with an unknown reset is re-checked hourly when that comes before another's known reset. */
test("planQuotaWait re-checks an unknown-reset Codex account hourly rather than ignoring it", () => {
  const base = {
    provider: "codex" as const,
    kind: "session" as const,
    resets: {},
    now: NOW,
    waiting: true,
    endAt: undefined,
    codex: { accounts: ["antoni", "main"], current: "antoni" },
  };
  const far = new Date(NOW.getTime() + 3 * 60 * 60_000);
  assert.deepEqual(
    planQuotaWait({ ...base, codex: { ...base.codex, readings: { antoni: spent("session"), main: spent("session", far) } } }),
    { wait: true, until: new Date(NOW.getTime() + QUOTA_RECHECK_MS), recheck: true, account: "antoni" },
  );
  const soon = new Date(NOW.getTime() + 10 * 60_000);
  assert.equal(
    planQuotaWait({ ...base, codex: { ...base.codex, readings: { antoni: spent("session"), main: spent("session", soon) } } })
      .account,
    "main",
  );
});
