// State that outlives one Sandcastle run: implementer session ids by issue and
// the latest quota reset time. One JSON file in the cache directory.
//
// Sibling pipelines save at the same moment, so every write re-reads the file
// and replaces it by rename. A missing or corrupt file reads as empty.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type State = {
  sessions: Record<string, string>;
  quotaResetAt?: string;
};

export interface RunState {
  loadSession(issue: number): string | undefined;
  saveSession(issue: number, sessionId: string): void;
  clearSession(issue: number): void;
  /** Every saved session, keyed by issue number. */
  sessions(): Record<string, string>;
  readQuotaReset(): Date | undefined;
  recordQuotaReset(at: Date): void;
}

export function openRunState(dir: string): RunState {
  const file = join(dir, "run-state.json");

  const read = (): State => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8"));
      const sessions: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw?.sessions ?? {})) {
        if (typeof value === "string") sessions[key] = value;
      }
      const reset = typeof raw?.quotaResetAt === "string" ? raw.quotaResetAt : undefined;
      return { sessions, quotaResetAt: reset };
    } catch {
      return { sessions: {} };
    }
  };

  const update = (change: (state: State) => void): void => {
    const state = read();
    change(state);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, file);
  };

  return {
    loadSession: (issue) => read().sessions[String(issue)],
    saveSession: (issue, sessionId) =>
      update((state) => {
        state.sessions[String(issue)] = sessionId;
      }),
    clearSession: (issue) =>
      update((state) => {
        delete state.sessions[String(issue)];
      }),
    sessions: () => read().sessions,
    readQuotaReset() {
      const value = read().quotaResetAt;
      const date = value ? new Date(value) : undefined;
      return date && !Number.isNaN(date.getTime()) ? date : undefined;
    },
    recordQuotaReset: (at) =>
      update((state) => {
        state.quotaResetAt = at.toISOString();
      }),
  };
}
