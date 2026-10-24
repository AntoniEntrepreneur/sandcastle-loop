// Run visibility helpers: the token-use table and log retention. Pure; main.mts
// does the file and console work.

/** Tokens one agent step used, attributed to an issue and a role. */
export interface UsageRow {
  issue: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
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
): Pick<UsageRow, "inputTokens" | "outputTokens"> {
  const total = { inputTokens: 0, outputTokens: 0 };
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
    total.inputTokens +=
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    total.outputTokens += usage.output_tokens ?? 0;
  }
  return total;
}

/** Logs older than this are deleted at the start of a run. */
export const LOG_RETENTION_DAYS = 30;

/** Per issue and role (rows merged), with a totals line. */
export function formatUsageTable(rows: UsageRow[]): string {
  if (rows.length === 0) return "No agent usage was recorded this run.";

  const merged = new Map<string, UsageRow>();
  for (const row of rows) {
    const key = `${row.issue}\0${row.role}`;
    const sum = merged.get(key) ?? { ...row, inputTokens: 0, outputTokens: 0 };
    sum.inputTokens += row.inputTokens;
    sum.outputTokens += row.outputTokens;
    merged.set(key, sum);
  }
  const body = [...merged.values()].map((r) => [r.issue, r.role, String(r.inputTokens), String(r.outputTokens)]);
  const sum = (pick: (r: UsageRow) => number) => String([...merged.values()].reduce((n, r) => n + pick(r), 0));
  const header = ["Issue", "Role", "Input", "Output"];
  const total = ["Total", "", sum((r) => r.inputTokens), sum((r) => r.outputTokens)];

  const all = [header, ...body, total];
  const widths = [0, 1, 2, 3].map((i) => Math.max(...all.map((l) => l[i]!.length)));
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
