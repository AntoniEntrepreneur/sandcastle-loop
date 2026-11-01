// Run-state tests against a real temp directory per test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GREEN_TREE_LIMIT, openRunState } from "./runState.mts";

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
    assert.equal(state.readQuotaReset("claude"), undefined);
    state.recordQuotaReset("claude", new Date("2026-09-22T13:10:00Z"));
    assert.equal(openRunState(dir).readQuotaReset("claude")?.toISOString(), "2026-09-22T13:10:00.000Z");
  }));

/** Pins that Gemini's reset persists and loads apart from Claude's, neither overwriting the other (#732). */
test("Gemini's reset time is kept separately from Claude's", () =>
  withDir((dir) => {
    openRunState(dir).recordQuotaReset("gemini", new Date("2026-10-26T14:57:42Z"));
    assert.equal(openRunState(dir).readQuotaReset("claude"), undefined);
    openRunState(dir).recordQuotaReset("claude", new Date("2026-10-26T13:10:00Z"));
    const state = openRunState(dir);
    assert.equal(state.readQuotaReset("gemini")?.toISOString(), "2026-10-26T14:57:42.000Z");
    assert.equal(state.readQuotaReset("claude")?.toISOString(), "2026-10-26T13:10:00.000Z");
  }));

/** Pins that a run-state file written before Gemini's clock existed still reads Claude's reset. */
test("a file holding only Claude's reset reads with no Gemini reset", () =>
  withDir((dir) => {
    writeFileSync(
      join(dir, "run-state.json"),
      JSON.stringify({ sessions: {}, quotaResetAt: "2026-09-22T13:10:00.000Z", implementedBy: {} }),
    );
    const state = openRunState(dir);
    assert.equal(state.readQuotaReset("claude")?.toISOString(), "2026-09-22T13:10:00.000Z");
    assert.equal(state.readQuotaReset("gemini"), undefined);
  }));

/** Pins that a corrupt file reads as empty and can be written over. */
test("a corrupt file reads as empty and can be written over", () =>
  withDir((dir) => {
    writeFileSync(join(dir, "run-state.json"), "{not json");
    const state = openRunState(dir);
    assert.equal(state.loadSession(1), undefined);
    assert.equal(state.readQuotaReset("claude"), undefined);
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
    state.recordQuotaReset("claude", new Date("2026-09-22T13:10:00Z"));
    state.saveSession(1, "s");
    assert.ok(state.readQuotaReset("claude"));
  }));

/** Pins that an issue's implementer label is recorded and read back across handles. */
test("an implementer label is recorded and read back across handles", () =>
  withDir((dir) => {
    openRunState(dir).recordImplementer(244, "gemini-3.8-flash-high (agy)");
    const state = openRunState(dir);
    assert.deepEqual(state.implementedBy(), { "244": "gemini-3.8-flash-high (agy)" });
  }));

/** Pins that recording a later issue's implementer keeps an earlier one's. */
test("two issues' implementer labels both survive", () =>
  withDir((dir) => {
    openRunState(dir).recordImplementer(244, "gemini-3.8-flash-high (agy)");
    openRunState(dir).recordImplementer(245, "claude-sonnet-5");
    assert.deepEqual(openRunState(dir).implementedBy(), {
      "244": "gemini-3.8-flash-high (agy)",
      "245": "claude-sonnet-5",
    });
  }));

/** Pins that a green tree is remembered across handles, and an unknown one is not green. */
test("a green tree is remembered across handles", () =>
  withDir((dir) => {
    openRunState(dir).recordGreenTree("abc");
    const state = openRunState(dir);
    assert.equal(state.isGreenTree("abc"), true);
    assert.equal(state.isGreenTree("def"), false);
  }));

/** Pins that only the most recent GREEN_TREE_LIMIT trees are kept, and re-recording one refreshes it. */
test("only the most recent green trees are kept", () =>
  withDir((dir) => {
    const state = openRunState(dir);
    for (let i = 0; i < GREEN_TREE_LIMIT; i++) state.recordGreenTree(`t${i}`);
    state.recordGreenTree("t0");
    state.recordGreenTree("new");
    assert.equal(state.isGreenTree("t0"), true);
    assert.equal(state.isGreenTree("t1"), false);
    assert.equal(state.isGreenTree("new"), true);
  }));

/** Pins that a file written before green trees existed reads with none, keeping its other state. */
test("a file without green trees reads with none", () =>
  withDir((dir) => {
    writeFileSync(join(dir, "run-state.json"), JSON.stringify({ sessions: { "1": "s" }, implementedBy: {} }));
    const state = openRunState(dir);
    assert.equal(state.isGreenTree("abc"), false);
    state.recordGreenTree("abc");
    assert.equal(openRunState(dir).loadSession(1), "s");
  }));
