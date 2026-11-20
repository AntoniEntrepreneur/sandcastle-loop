// Test per-run accounting, rendered usage and independent log retention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "./rolePlan.mts";

import { RunReport, formatUsageTable, logsToDelete, sessionUsage, streamStepUsage, type UsageRow } from "./runReport.mts";

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
    role: "gemini-3.8-flash-medium",
    inputTokens: input,
    outputTokens: output,
    thinkingTokens: thinking,
    cacheReadTokens: cacheRead,
  };
}

/** Pins that an agy row, built from the stream's result usage, shows all four token kinds (#731). */
test("a gemini-3.8-flash-medium row shows input, output, thinking and cache-read tokens", () => {
  const lines = formatUsageTable([agyRow(860, 215, 40, 300)]).split("\n");
  assert.match(lines[1]!, /#244\s+gemini-3\.8-flash-medium\s+1\s+860\s+215\s+40\s+300/);
});

/** Pins that the PR writer's token row is labelled with its model rather than its role (#805). */
test("the PR writer's token row is labelled with its model", () => {
  const row: UsageRow = {
    issue: "batch",
    role: "gemini-3.8-flash-medium",
    inputTokens: 1200,
    outputTokens: 300,
    thinkingTokens: 80,
    cacheReadTokens: 150,
  };
  const lines = formatUsageTable([row]).split("\n");
  assert.match(lines[1]!, /batch\s+gemini-3\.8-flash-medium\s+1\s+1200\s+300\s+80\s+150/);
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
  assert.match(lines[1]!, /#244\s+gemini-3\.8-flash-medium\s+1\s+500\s+100\s+10\s+0/);
  assert.match(lines[2]!, /#244\s+gemini-3\.8-flash-medium\s+2\s+600\s+150\s+20\s+50/);
  assert.match(lines[3]!, /Total\s+1100\s+250\s+30\s+50/);
});

/** Pins that an agy reviewer's resumed turn records only its difference, labelled with its model (#803). */
test("an agy reviewer's resumed turn records only its difference, labelled with its model", () => {
  const model = "gemini-3.8-flash-medium";
  // The first turn ran under 200 lines with flash-medium.
  const turn1Total = { inputTokens: 5000, outputTokens: 500, thinkingTokens: 100, cacheReadInputTokens: 1000 };
  const turn1Spend = streamStepUsage(turn1Total);

  // The resumed fix round reports cumulative totals from agy's stream.
  const turn2Total = { inputTokens: 8000, outputTokens: 800, thinkingTokens: 150, cacheReadInputTokens: 2500 };
  const turn2Spend = streamStepUsage(turn2Total, turn1Total);

  const lines = formatUsageTable([
    { issue: "#244", role: model, ...turn1Spend },
    { issue: "#244", role: model, ...turn2Spend },
  ]).split("\n");

  assert.equal(lines.length, 4);
  assert.match(lines[1]!, /#244\s+gemini-3\.8-flash-medium\s+1\s+5000\s+500\s+100\s+1000/);
  assert.match(lines[2]!, /#244\s+gemini-3\.8-flash-medium\s+2\s+3000\s+300\s+50\s+1500/);
  assert.match(lines[3]!, /Total\s+8000\s+800\s+150\s+2500/);
});

/** Pins that the merger's token row is labelled with its model (#804). */
test("the merger's token row is labelled with its model", () => {
  const row: UsageRow = {
    issue: "batch",
    role: "gemini-3.8-flash-medium",
    inputTokens: 1200,
    outputTokens: 300,
    thinkingTokens: 50,
    cacheReadTokens: 100,
  };
  const lines = formatUsageTable([row]).split("\n");
  assert.match(lines[1]!, /batch\s+gemini-3\.8-flash-medium\s+1\s+1200\s+300\s+50\s+100/);
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

/** Pins shared issue/batch attribution and cumulative retry deltas through the report. */
test("run report shares cumulative accounting between issue and batch steps", () => {
  const report = new RunReport(0);
  const agent = { kind: "agy", model: "gemini-3.8-flash-medium", label: "unused" } as const;
  /** Build cumulative stream totals with separately reported thinking. */
  const usage = (inputTokens: number, outputTokens: number, thinkingTokens: number, cacheReadInputTokens: number) => ({
    inputTokens, outputTokens, thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens: 0,
  });
  report.recordRoleUsage("#244", "reviewer", agent, [
    { sessionId: "review", usage: usage(5000, 500, 100, 1000) }, {},
  ]);
  report.recordRoleUsage("#244", "reviewer", agent, [
    { sessionId: "review", usage: usage(8000, 800, 150, 2500) },
  ]);
  report.recordRoleUsage("batch", "merger", agent, [
    { sessionId: "merge", usage: usage(1200, 300, 50, 100) },
  ]);
  report.recordRoleUsage("batch", "prWriter", agent, [
    { sessionId: "pr", usage: usage(600, 100, 20, 50) },
  ]);
  report.recordRoleUsage("batch", "prWriter", agent, [
    { sessionId: "pr", usage: usage(800, 150, 30, 70) },
    { usage: usage(10, 2, 1, 0) },
  ]);
  const lines = report.render().split("\n");
  assert.equal(lines.length, 8);
  assert.match(lines[1]!, /#244\s+gemini-3\.8-flash-medium\s+1\s+5000\s+500\s+100\s+1000/);
  assert.match(lines[2]!, /#244\s+gemini-3\.8-flash-medium\s+2\s+3000\s+300\s+50\s+1500/);
  assert.match(lines[3]!, /batch\s+gemini-3\.8-flash-medium\s+1\s+1200\s+300\s+50\s+100/);
  assert.match(lines[4]!, /batch\s+gemini-3\.8-flash-medium\s+2\s+600\s+100\s+20\s+50/);
  assert.match(lines[5]!, /batch\s+gemini-3\.8-flash-medium\s+3\s+200\s+50\s+10\s+20/);
  assert.match(lines[6]!, /batch\s+gemini-3\.8-flash-medium\s+4\s+10\s+2\s+1\s+0/);
  assert.match(lines[7]!, /Total\s+10010\s+1252\s+231\s+2670/);
});

/** Build a captured provider event with cache creation or separate reasoning usage. */
function capturedUsage(kind: AgentKind, id: string, at: string, input: number, output: number, cached: number, extra: number): string {
  if (kind === "claude") {
    return JSON.stringify({
      type: "assistant", timestamp: at,
      message: { id, usage: {
        input_tokens: input, cache_creation_input_tokens: extra,
        output_tokens: output, cache_read_input_tokens: cached,
      } },
    });
  }
  return JSON.stringify({
    type: "event_msg", timestamp: at,
    payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: Number(id) },
      last_token_usage: {
        input_tokens: input, cached_input_tokens: cached,
        output_tokens: output, reasoning_output_tokens: extra,
      },
    } },
  });
}

for (const kind of ["claude", "codex"] as const) {
  /** Pins capture cutoff, deduplication, retry rows and best-effort reads through the report. */
  test(`run report accounts for ${kind} issue and batch captures best-effort`, () => {
    const dir = mkdtempSync(join(tmpdir(), "run-report-"));
    try {
      const report = new RunReport(Date.parse("2026-11-15T20:00:00Z"));
      const agent = { kind, model: "model", label: "gpt-6.1-sol medium (codex)" };
      assert.equal(report.render(), "No agent usage was recorded this run.");
      const firstPath = join(dir, "first.jsonl");
      const retryPath = join(dir, "retry.jsonl");
      const batchPath = join(dir, "batch.jsonl");
      const first = capturedUsage(kind, "100", "2026-11-15T20:01:00Z", 100, 30, 40, kind === "claude" ? 20 : 10);
      const retry = capturedUsage(kind, "150", "2026-11-15T20:02:00Z", 50, 7, 10, kind === "claude" ? 0 : 2);
      const batch = capturedUsage(kind, "160", "2026-11-15T20:03:00Z", 10, 2, 3, kind === "claude" ? 0 : 1);
      const old = capturedUsage(kind, "99", "2026-11-15T19:59:59Z", 999, 999, 999, 0);
      writeFileSync(firstPath, [old, "not json", "{bad json", first, first].join("\n"));
      writeFileSync(retryPath, [old, first, retry].join("\n"));
      writeFileSync(batchPath, batch);
      report.recordRoleUsage("#12", "implementer", agent, [
        {}, { sessionFilePath: join(dir, "missing.jsonl") }, { sessionFilePath: dir },
        { sessionFilePath: firstPath, usage: {
          inputTokens: 99999, outputTokens: 99999, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        } },
      ]);
      report.recordRoleUsage("#12", "implementer", agent, [{ sessionFilePath: retryPath }]);
      report.recordRoleUsage("#12", "reviewer", agent, [{ sessionFilePath: retryPath }]);
      report.recordRoleUsage("batch", "merger", agent, [{ sessionFilePath: batchPath }]);
      report.recordRoleUsage("batch", "prWriter", agent, [{ sessionFilePath: batchPath }, { sessionFilePath: dir }]);
      const cells = report.render().split("\n").map((line) => line.trim().split(/\s{2,}/));
      if (kind === "claude") {
        assert.deepEqual(cells.slice(1), [
          ["#12", "implementer", "1", "120", "30", "0", "40"],
          ["#12", "implementer", "2", "50", "7", "0", "10"],
          ["#12", "reviewer", "1", "0", "0", "0", "0"],
          ["batch", "merger", "1", "10", "2", "0", "3"],
          ["batch", "prWriter", "1", "0", "0", "0", "0"],
          ["Total", "180", "39", "0", "53"],
        ]);
      } else {
        assert.deepEqual(cells.slice(1), [
          ["#12", "gpt-6.1-sol medium (codex)", "1", "60", "20", "10", "40"],
          ["#12", "gpt-6.1-sol medium (codex)", "2", "40", "5", "2", "10"],
          ["#12", "gpt-6.1-sol medium (codex)", "3", "0", "0", "0", "0"],
          ["batch", "gpt-6.1-sol medium (codex)", "1", "7", "1", "1", "3"],
          ["batch", "gpt-6.1-sol medium (codex)", "2", "0", "0", "0", "0"],
          ["Total", "107", "26", "13", "53"],
        ]);
      }
      const nextRun = new RunReport(0);
      nextRun.recordRoleUsage("batch", "merger", agent, [{ sessionFilePath: batchPath }]);
      assert.match(nextRun.render(), kind === "claude" ? /Total\s+10\s+2\s+0\s+3/ : /Total\s+7\s+1\s+1\s+3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
