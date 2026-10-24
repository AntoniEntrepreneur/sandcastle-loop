// Run-state tests against a real temp directory per test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openRunState } from "./runState.mts";

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "run-state-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pins that a session is saved, loaded across handles and cleared. */
test("a session is saved, loaded across handles and cleared", () =>
  withDir((dir) => {
    openRunState(dir).saveSession(12, "abc");
    const state = openRunState(dir);
    assert.equal(state.loadSession(12), "abc");
    assert.equal(state.loadSession(13), undefined);
    state.clearSession(12);
    assert.equal(openRunState(dir).loadSession(12), undefined);
  }));

/** Pins that a reset time is recorded and read back. */
test("a reset time is recorded and read back", () =>
  withDir((dir) => {
    const state = openRunState(dir);
    assert.equal(state.readQuotaReset(), undefined);
    state.recordQuotaReset(new Date("2026-09-22T13:10:00Z"));
    assert.equal(openRunState(dir).readQuotaReset()?.toISOString(), "2026-09-22T13:10:00.000Z");
  }));

/** Pins that a corrupt file reads as empty and can be written over. */
test("a corrupt file reads as empty and can be written over", () =>
  withDir((dir) => {
    writeFileSync(join(dir, "run-state.json"), "{not json");
    const state = openRunState(dir);
    assert.equal(state.loadSession(1), undefined);
    assert.equal(state.readQuotaReset(), undefined);
    state.saveSession(1, "s");
    assert.equal(state.loadSession(1), "s");
  }));

/** Pins that two quick saves for different issues both survive. */
test("two quick saves for different issues both survive", () =>
  withDir((dir) => {
    openRunState(dir).saveSession(1, "one");
    openRunState(dir).saveSession(2, "two");
    assert.deepEqual(openRunState(dir).sessions(), { "1": "one", "2": "two" });
  }));

/** Pins that saving a session keeps the recorded reset time. */
test("saving a session keeps the recorded reset time", () =>
  withDir((dir) => {
    const state = openRunState(dir);
    state.recordQuotaReset(new Date("2026-09-22T13:10:00Z"));
    state.saveSession(1, "s");
    assert.ok(state.readQuotaReset());
  }));
