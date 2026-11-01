// Run visibility helpers: the token-use table and log retention. Pure; main.mts
// does the file and console work.

/** Tokens one agent step used, attributed to an issue and a role. */
export interface UsageRow {
  issue: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  /** Set for `agy` rows; unset for Claude's, which counts thinking as output. */
  thinkingTokens?: number;
  /** Prompt tokens served from cache, kept out of `inputTokens` because they cost a fraction of it. */
  cacheReadTokens?: number;
}

/**
 * Tokens a captured Claude Code session JSONL spent: every assistant message
 * sent at or after `sinceMs`, each counted once. Claude Code writes one line
 * per content block, all carrying the same message id and usage, and a resumed
 * session carries earlier steps' messages, so ids already in `counted` are
 * skipped and new ones added to it. The SDK's own `usage` is only the last
 * message's, which is a context-window size, not what the step cost.
 */
export function sessionUsage(
  jsonl: string,
  sinceMs: number,
  counted: Set<string>,
): Required<Pick<UsageRow, "inputTokens" | "outputTokens" | "cacheReadTokens">> {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const id = entry.message?.id;
    const usage = entry.message?.usage;
    if (entry.type !== "assistant" || typeof id !== "string" || !usage) continue;
    if (counted.has(id) || !(Date.parse(entry.timestamp) >= sinceMs)) continue;
    counted.add(id);
    total.inputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    total.outputTokens += usage.output_tokens ?? 0;
  }
  return total;
}

/** Logs older than this are deleted at the start of a run. */
export const LOG_RETENTION_DAYS = 30;

/**
 * One row per step, numbered within its issue and role so a resumed step reads
 * on its own (#810), with a totals line. The number counts recorded rows across
 * the whole run, so a step that recorded no usage, or a later cycle, shifts it
 * from the issue loop's own step count. A Claude row leaves Thinking at zero:
 * Claude counts thinking as Output, so only an `agy` row fills all four
 * columns (#731).
 */
export function formatUsageTable(rows: UsageRow[]): string {
  if (rows.length === 0) return "No agent usage was recorded this run.";

  const counts = (r: UsageRow) => [r.inputTokens, r.outputTokens, r.thinkingTokens ?? 0, r.cacheReadTokens ?? 0];
  const steps = new Map<string, number>();
  const header = ["Issue", "Role", "Step", "Input", "Output", "Thinking", "Cache-read"];
  const body = rows.map((r) => {
    const key = `${r.issue}\0${r.role}`;
    const step = (steps.get(key) ?? 0) + 1;
    steps.set(key, step);
    return [r.issue, r.role, String(step), ...counts(r).map(String)];
  });
  const totals = rows.reduce((running, r) => running.map((n, i) => n + counts(r)[i]!), [0, 0, 0, 0]);
  const total = ["Total", "", "", ...totals.map(String)];

  const all = [header, ...body, total];
  const widths = header.map((_, i) => Math.max(...all.map((l) => l[i]!.length)));
  const fmt = (l: string[]) =>
    l
      .map((cell, i) => (i < 2 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return all.map(fmt).join("\n");
}

/** Names of the files whose modification time is more than 30 days before now. */
export function logsToDelete(files: { name: string; mtimeMs: number }[], nowMs: number): string[] {
  const cutoff = nowMs - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return files.filter((f) => f.mtimeMs < cutoff).map((f) => f.name);
}
