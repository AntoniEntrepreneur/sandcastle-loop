// State that outlives one Sandcastle run: implementer session ids by issue,
// the latest quota reset time per provider — Claude's and Gemini's on clocks
// of their own (#732) — which agent implemented each issue (#731,
// so a PR spanning runs can still name the right implementer per issue), and
// the trees the check has passed, so identical code is never checked twice. One
// JSON file in the cache directory.
//
// Sibling pipelines save at the same moment, so every write re-reads the file
// and replaces it by rename. A missing or corrupt file reads as empty.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { QuotaProvider } from "./overnight.mts";

type State = {
  sessions: Record<string, string>;
  quotaResetAt?: string;
  geminiQuotaResetAt?: string;
  implementedBy: Record<string, string>;
  greenTrees: string[];
};

/** How many green trees are remembered; the oldest is forgotten first. */
export const GREEN_TREE_LIMIT = 200;

/** Where each provider's reset lives in the file; Claude's keeps the key it had before Gemini's existed. */
const RESET_KEYS = { claude: "quotaResetAt", gemini: "geminiQuotaResetAt" } as const satisfies Record<
  QuotaProvider,
  keyof State
>;

export interface RunState {
  loadSession(issue: number): string | undefined;
  saveSession(issue: number, sessionId: string): void;
  clearSession(issue: number): void;
  /** Every saved session, keyed by issue number. */
  sessions(): Record<string, string>;
  readQuotaReset(provider: QuotaProvider): Date | undefined;
  recordQuotaReset(provider: QuotaProvider, at: Date): void;
  /** Which agent implemented an issue, e.g. "gemini-3.8-flash-high (agy)" (#731). */
  recordImplementer(issue: number, label: string): void;
  /** Every recorded implementer label, keyed by issue number. */
  implementedBy(): Record<string, string>;
  /** Whether the check has passed on this tree id, in any sandbox or run. */
  isGreenTree(tree: string): boolean;
  recordGreenTree(tree: string): void;
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
      const implementedBy: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw?.implementedBy ?? {})) {
        if (typeof value === "string") implementedBy[key] = value;
      }
      const greenTrees: string[] = Array.isArray(raw?.greenTrees)
        ? raw.greenTrees.filter((tree: unknown) => typeof tree === "string")
        : [];
      const text = (value: unknown) => (typeof value === "string" ? value : undefined);
      return {
        sessions,
        quotaResetAt: text(raw?.quotaResetAt),
        geminiQuotaResetAt: text(raw?.geminiQuotaResetAt),
        implementedBy,
        greenTrees,
      };
    } catch {
      return { sessions: {}, implementedBy: {}, greenTrees: [] };
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
    readQuotaReset(provider) {
      const value = read()[RESET_KEYS[provider]];
      const date = value ? new Date(value) : undefined;
      return date && !Number.isNaN(date.getTime()) ? date : undefined;
    },
    recordQuotaReset: (provider, at) =>
      update((state) => {
        state[RESET_KEYS[provider]] = at.toISOString();
      }),
    recordImplementer: (issue, label) =>
      update((state) => {
        state.implementedBy[String(issue)] = label;
      }),
    implementedBy: () => read().implementedBy,
    isGreenTree: (tree) => read().greenTrees.includes(tree),
    recordGreenTree: (tree) =>
      update((state) => {
        const others = state.greenTrees.filter((known) => known !== tree);
        state.greenTrees = [...others, tree].slice(-GREEN_TREE_LIMIT);
      }),
  };
}
