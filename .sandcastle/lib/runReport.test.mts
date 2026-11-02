// Unit tests for the run's usage table and log retention.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatUsageTable, logsToDelete, sessionUsage, type UsageRow } from "./runReport.mts";

const DAY = 24 * 60 * 60 * 1000;

/** One session JSONL line for an assistant message. */
function assistantLine(id: string, at: string, input: number, output: number, cacheRead = 0): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: {
      id,
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output },
    },
  });
}

/** Pins that cache reads, billed at a tenth of input, are no longer folded into Input. */
test("session usage counts cache reads apart from input", () => {
  const jsonl = assistantLine("a", "2026-10-21T04:00:00Z", 100, 10, 9000);
  assert.deepEqual(sessionUsage(jsonl, 0, new Set()), { inputTokens: 100, outputTokens: 10, cacheReadTokens: 9000 });
});

/** Pins that session usage sums every message, counting a split message once. */
test("session usage sums every message, counting a split message once", () => {
  const jsonl = [
    assistantLine("a", "2026-10-21T04:00:00Z", 100, 10),
    assistantLine("a", "2026-10-21T04:00:00Z", 100, 10),
    JSON.stringify({ type: "user", timestamp: "2026-10-21T04:00:01Z", message: {} }),
    assistantLine("b", "2026-10-21T04:00:02Z", 200, 20),
  ].join("\n");
  assert.deepEqual(sessionUsage(jsonl, 0, new Set()), { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0 });
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
    cacheReadTokens: 0,
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
  assert.match(lines[0]!, /^Issue\s+Role\s+Step\s+Input/);
  assert.match(lines[1]!, /#12\s+implementer\s+1\s+1000\s+200/);
  assert.match(lines[3]!, /#13\s+implementer\s+1\s+2500\s+300/);
  assert.match(lines[4]!, /Total\s+4000\s+550/);
});

/** Pins that each step of an issue's role gets its own numbered row, so a resumed step reads on its own (#810). */
test("usage table prints one numbered row per step", () => {
  const lines = formatUsageTable([
    { issue: "#12", role: "implementer", inputTokens: 100, outputTokens: 10 },
    { issue: "#12", role: "reviewer", inputTokens: 50, outputTokens: 5 },
    { issue: "#12", role: "implementer", inputTokens: 200, outputTokens: 20 },
  ]).split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[1]!, /#12\s+implementer\s+1\s+100\s+10/);
  assert.match(lines[2]!, /#12\s+reviewer\s+1\s+50\s+5/);
  assert.match(lines[3]!, /#12\s+implementer\s+2\s+200\s+20/);
  assert.match(lines[4]!, /Total\s+350\s+35/);
});

/** Pins that usage table with no rows says nothing was used. */
test("usage table with no rows says nothing was used", () => {
  assert.equal(formatUsageTable([]), "No agent usage was recorded this run.");
});

/** One `agy` implementer row for issue #244, as the stream's `result` usage reports it. */
function agyRow(input: number, output: number, thinking: number, cacheRead: number): UsageRow {
  return {
    issue: "#244",
    role: "gemini-3.8-flash-high",
    inputTokens: input,
    outputTokens: output,
    thinkingTokens: thinking,
    cacheReadTokens: cacheRead,
  };
}

/** Pins that an agy row, built from the stream's result usage, shows all four token kinds (#731). */
test("a gemini-3.8-flash-high row shows input, output, thinking and cache-read tokens", () => {
  const lines = formatUsageTable([agyRow(860, 215, 40, 300)]).split("\n");
  assert.match(lines[1]!, /#244\s+gemini-3\.8-flash-high\s+1\s+860\s+215\s+40\s+300/);
});

/** Pins that a retried agy run's two attempts each get their own row, totalled once (#731, #810). */
test("a retried agy run shows each attempt's usage on its own row", () => {
  const lines = formatUsageTable([
    // The first attempt died on a red check, having spent this much.
    agyRow(500, 100, 10, 0),
    // The fix round resumes the conversation and records only its own spend.
    agyRow(600, 150, 20, 50),
  ]).split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[1]!, /#244\s+gemini-3\.8-flash-high\s+1\s+500\s+100\s+10\s+0/);
  assert.match(lines[2]!, /#244\s+gemini-3\.8-flash-high\s+2\s+600\s+150\s+20\s+50/);
  assert.match(lines[3]!, /Total\s+1100\s+250\s+30\s+50/);
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
