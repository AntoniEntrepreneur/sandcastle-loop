// Unit tests for the run's usage table and log retention.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatUsageTable, logsToDelete, sessionUsage, type UsageRow } from "./runReport.mts";

const DAY = 24 * 60 * 60 * 1000;

/** One session JSONL line for an assistant message. */
function assistantLine(id: string, at: string, input: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: {
      id,
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output },
    },
  });
}

/** Pins that session usage sums every message, counting a split message once. */
test("session usage sums every message, counting a split message once", () => {
  const jsonl = [
    assistantLine("a", "2026-10-21T04:00:00Z", 100, 10),
    assistantLine("a", "2026-10-21T04:00:00Z", 100, 10),
    JSON.stringify({ type: "user", timestamp: "2026-10-21T04:00:01Z", message: {} }),
    assistantLine("b", "2026-10-21T04:00:02Z", 200, 20),
  ].join("\n");
  assert.deepEqual(sessionUsage(jsonl, 0, new Set()), { inputTokens: 300, outputTokens: 30 });
});

/** Pins that session usage skips what an earlier run or step already spent. */
test("session usage skips what an earlier run or step already spent", () => {
  const jsonl = [
    assistantLine("old", "2026-10-20T04:00:00Z", 1000, 100),
    assistantLine("seen", "2026-10-21T04:00:00Z", 500, 50),
    assistantLine("new", "2026-10-21T04:00:01Z", 200, 20),
  ].join("\n");
  const counted = new Set(["seen"]);
  assert.deepEqual(sessionUsage(jsonl, Date.parse("2026-10-21T00:00:00Z"), counted), {
    inputTokens: 200,
    outputTokens: 20,
  });
  assert.ok(counted.has("new"));
});

/** Pins that usage table lists each row and totals the tokens. */
test("usage table lists each row and totals the tokens", () => {
  const rows: UsageRow[] = [
    { issue: "#12", role: "implementer", inputTokens: 1000, outputTokens: 200 },
    { issue: "#12", role: "reviewer", inputTokens: 500, outputTokens: 50 },
    { issue: "#13", role: "implementer", inputTokens: 2500, outputTokens: 300 },
  ];
  const lines = formatUsageTable(rows).split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[1]!, /#12\s+implementer\s+1000\s+200/);
  assert.match(lines[3]!, /#13\s+implementer\s+2500\s+300/);
  assert.match(lines[4]!, /Total\s+4000\s+550/);
});

/** Pins that usage table merges rows with the same issue and role. */
test("usage table merges rows with the same issue and role", () => {
  const out = formatUsageTable([
    { issue: "#12", role: "implementer", inputTokens: 100, outputTokens: 10 },
    { issue: "#12", role: "implementer", inputTokens: 200, outputTokens: 20 },
  ]);
  assert.match(out, /#12\s+implementer\s+300\s+30/);
  assert.equal(out.split("\n").length, 3);
});

/** Pins that usage table with no rows says nothing was used. */
test("usage table with no rows says nothing was used", () => {
  assert.equal(formatUsageTable([]), "No agent usage was recorded this run.");
});

/** Pins that logs exactly 30 days old are kept, older ones deleted. */
test("logs exactly 30 days old are kept, older ones deleted", () => {
  const now = 100 * DAY;
  const files = [
    { name: "old.log", mtimeMs: now - 30 * DAY - 1 },
    { name: "edge.log", mtimeMs: now - 30 * DAY },
    { name: "new.log", mtimeMs: now - DAY },
  ];
  assert.deepEqual(logsToDelete(files, now), ["old.log"]);
});

/** Pins that no logs means nothing to delete. */
test("no logs means nothing to delete", () => {
  assert.deepEqual(logsToDelete([], 0), []);
});
