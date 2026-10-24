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
  assert.deepEqual(parseCommandLine([]), { group: undefined, overnight: false, until: undefined });
});

/** Pins that --overnight defaults the end time to 04:00 and sits on either side of the group. */
test("parseCommandLine takes --overnight before or after the group, defaulting to 04:00", () => {
  const expected = { group: "244", overnight: true, until: "04:00" };
  assert.deepEqual(parseCommandLine(["244", "--overnight"]), expected);
  assert.deepEqual(parseCommandLine(["--overnight", "244"]), expected);
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
  assert.throws(() => parseCommandLine(["--wait"]), /Unknown option/);
  assert.throws(() => parseCommandLine(["244", "245"]), /One group/);
  assert.throws(() => parseCommandLine(["--until", "04:00"]), /--overnight/);
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
    planQuotaWait({ kind: "session", resetAt: RESET, now: NOW, waiting: true, endAt: END }),
    { wait: true, until: new Date(RESET.getTime() + QUOTA_WAIT_MARGIN_MS), recheck: false },
  );
});

/** Pins that a stop with no reset time waits an hour and asks for a re-check. */
test("planQuotaWait waits an hour and re-checks when no reset time is known", () => {
  assert.deepEqual(
    planQuotaWait({ kind: "session", resetAt: undefined, now: NOW, waiting: true, endAt: END }),
    { wait: true, until: new Date(NOW.getTime() + QUOTA_RECHECK_MS), recheck: true },
  );
});

/** Pins that a reset at or after the end time is not waited for. */
test("planQuotaWait does not wait past the end time", () => {
  const late = new Date(END.getTime() - QUOTA_WAIT_MARGIN_MS);
  const plan = planQuotaWait({ kind: "session", resetAt: late, now: NOW, waiting: true, endAt: END });
  assert.equal(plan.wait, false);
});

/** Pins that waiting with no end time waits however long the reset is. */
test("planQuotaWait without an end time waits for any stated reset", () => {
  const far = new Date("2026-10-08T22:00:00Z");
  assert.equal(
    planQuotaWait({ kind: "session", resetAt: far, now: NOW, waiting: true, endAt: undefined }).wait,
    true,
  );
});

/** Pins the stops that are never waited for. */
test("planQuotaWait never waits for a weekly limit, a credit balance, or with waiting off", () => {
  const base = { resetAt: RESET, now: NOW, endAt: END };
  assert.equal(planQuotaWait({ ...base, kind: "weekly", waiting: true }).wait, false);
  assert.equal(planQuotaWait({ ...base, kind: "credit", waiting: true }).wait, false);
  assert.equal(planQuotaWait({ ...base, kind: "session", waiting: false }).wait, false);
});
