// Unit tests for reading the quota reset time and the start gate (#506).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseQuotaReset, quotaGate, shouldProbeQuota } from "./groups.mts";

const NOON_UTC = new Date("2026-09-22T12:00:00Z");

/** Pins that parseQuotaReset reads 'resets 1:10pm (UTC)' as the next 13:10 UTC. */
test("parseQuotaReset reads 'resets 1:10pm (UTC)' as the next 13:10 UTC", () => {
  const at = parseQuotaReset("You've hit your session limit · resets 1:10pm (UTC)", NOON_UTC);
  assert.equal(at?.toISOString(), "2026-09-22T13:10:00.000Z");
});

/** Pins that parseQuotaReset reads the hour-only form and rolls over to tomorrow. */
test("parseQuotaReset reads the hour-only form and rolls over to tomorrow", () => {
  const at = parseQuotaReset("session limit · resets 11am (UTC)", NOON_UTC);
  assert.equal(at?.toISOString(), "2026-09-23T11:00:00.000Z");
});

/** Pins that parseQuotaReset reads 'resets 7:10pm (UTC)'. */
test("parseQuotaReset reads 'resets 7:10pm (UTC)'", () => {
  const at = parseQuotaReset("resets 7:10pm (UTC)", NOON_UTC);
  assert.equal(at?.toISOString(), "2026-09-22T19:10:00.000Z");
});

/** Pins that parseQuotaReset handles 12am and 12pm. */
test("parseQuotaReset handles 12am and 12pm", () => {
  assert.equal(
    parseQuotaReset("resets 12am (UTC)", NOON_UTC)?.toISOString(),
    "2026-09-23T00:00:00.000Z",
  );
  assert.equal(
    parseQuotaReset("resets 12:30pm (UTC)", NOON_UTC)?.toISOString(),
    "2026-09-22T12:30:00.000Z",
  );
});

/** Pins that parseQuotaReset honours a named timezone. */
test("parseQuotaReset honours a named timezone", () => {
  // Warsaw is UTC+2 in September: 3pm there is 13:00 UTC.
  const at = parseQuotaReset("resets 3pm (Europe/Warsaw)", NOON_UTC);
  assert.equal(at?.toISOString(), "2026-09-22T13:00:00.000Z");
});

/** Pins that parseQuotaReset returns undefined when there is no readable reset time. */
test("parseQuotaReset returns undefined when there is no readable reset time", () => {
  assert.equal(parseQuotaReset("usage limit reached", NOON_UTC), undefined);
  assert.equal(parseQuotaReset("resets soon (UTC)", NOON_UTC), undefined);
  assert.equal(parseQuotaReset("resets 3pm (Nowhere/Land)", NOON_UTC), undefined);
  assert.equal(parseQuotaReset("resets 13pm (UTC)", NOON_UTC), undefined);
});

/** Pins that quotaGate allows with no saved reset. */
test("quotaGate allows with no saved reset", () => {
  assert.deepEqual(quotaGate(undefined, NOON_UTC, false), { allowed: true });
});

/** Pins that quotaGate refuses before the reset, with minutes remaining rounded up. */
test("quotaGate refuses before the reset, with minutes remaining rounded up", () => {
  const reset = new Date("2026-09-22T13:10:30Z");
  assert.deepEqual(quotaGate(reset, NOON_UTC, false), {
    allowed: false,
    resetAt: reset,
    minutesLeft: 71,
  });
});

/** Pins that quotaGate allows at and after the reset. */
test("quotaGate allows at and after the reset", () => {
  assert.deepEqual(quotaGate(NOON_UTC, NOON_UTC, false), { allowed: true });
  assert.deepEqual(quotaGate(new Date("2026-09-22T11:00:00Z"), NOON_UTC, false), {
    allowed: true,
  });
});

/** Pins that quotaGate override allows an early run. */
test("quotaGate override allows an early run", () => {
  assert.deepEqual(quotaGate(new Date("2026-09-22T13:00:00Z"), NOON_UTC, true), {
    allowed: true,
  });
});

const PAST = new Date("2026-09-22T11:00:00Z");
const FUTURE = new Date("2026-09-22T13:10:00Z");

/** Pins that shouldProbeQuota does not probe while the gate is refusing. */
test("shouldProbeQuota does not probe while the gate is refusing", () => {
  const gate = quotaGate(FUTURE, NOON_UTC, false);
  assert.equal(shouldProbeQuota(gate, FUTURE, NOON_UTC, false), false);
});

/** Pins that shouldProbeQuota does not probe when a saved reset is still in the future. */
test("shouldProbeQuota does not probe when a saved reset is still in the future", () => {
  // Gate overridden, so it allows; the saved reset is still ahead.
  const gate = quotaGate(FUTURE, NOON_UTC, true);
  assert.equal(shouldProbeQuota(gate, FUTURE, NOON_UTC, false), false);
});

/** Pins that shouldProbeQuota probes with no saved reset. */
test("shouldProbeQuota probes with no saved reset", () => {
  assert.equal(shouldProbeQuota(quotaGate(undefined, NOON_UTC, false), undefined, NOON_UTC, false), true);
});

/** Pins that shouldProbeQuota probes when the saved reset has passed. */
test("shouldProbeQuota probes when the saved reset has passed", () => {
  assert.equal(shouldProbeQuota(quotaGate(PAST, NOON_UTC, false), PAST, NOON_UTC, false), true);
});

/** Pins that shouldProbeQuota never probes on a dry run. */
test("shouldProbeQuota never probes on a dry run", () => {
  assert.equal(shouldProbeQuota(quotaGate(undefined, NOON_UTC, false), undefined, NOON_UTC, true), false);
});
