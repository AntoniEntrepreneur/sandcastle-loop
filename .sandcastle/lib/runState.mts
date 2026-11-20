// State that outlives one Sandcastle run: implementer session ids by issue,
// the latest quota reset time per provider — Claude's, Gemini's and Codex's
// on clocks of their own (#732) — which agent ran each role (#731/#802, so a PR spanning
// runs can still name the right agent per issue and per batch), and the trees
// the check has passed, so identical code is never checked twice. One JSON
// file in the cache directory.
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
  codexQuotaResetAt?: string;
  /** Codex resets of the named accounts (`--codex-account`); the default sign-in keeps `codexQuotaResetAt`. */
  codexAccountQuotaResetAt?: Record<string, string>;
  implementedBy: Record<string, string>;
  reviewedBy: Record<string, string>;
  batchRoles: Record<string, string>;
  greenTrees: string[];
};

/** The roles that run once per batch rather than once per issue. */
export type BatchRole = "merger" | "pr-writer";

/** How many green trees are remembered; the oldest is forgotten first. */
export const GREEN_TREE_LIMIT = 200;

/** Where each provider's reset lives in the file; Claude's keeps the key it had before Gemini's existed. */
const RESET_KEYS = { claude: "quotaResetAt", gemini: "geminiQuotaResetAt", codex: "codexQuotaResetAt" } as const satisfies Record<
  QuotaProvider,
  keyof State
>;

export interface RunState {
  loadSession(issue: number): string | undefined;
  saveSession(issue: number, sessionId: string): void;
  clearSession(issue: number): void;
  /** Every saved session, keyed by issue number. */
  sessions(): Record<string, string>;
  /** Makes Codex reset reads and writes belong to this account; undefined is the default sign-in. */
  useCodexAccount(account: string | undefined): void;
  readQuotaReset(provider: QuotaProvider): Date | undefined;
  /** `account` records a Codex reset under that named account instead of the one in use. */
  recordQuotaReset(provider: QuotaProvider, at: Date, account?: string): void;
  /** Which agent implemented an issue, e.g. "gemini-3.8-flash-medium (agy)" (#731). */
  recordImplementer(issue: number, label: string): void;
  /** Every recorded implementer label, keyed by issue number. */
  implementedBy(): Record<string, string>;
  /** Which agent reviewed an issue, labelled as the implementer is (#802). */
  recordReviewer(issue: number, label: string): void;
  /** Every recorded reviewer label, keyed by issue number. */
  reviewedBy(): Record<string, string>;
  /** Which agent ran a role the whole batch shares: one label per role, not per issue. */
  recordBatchRole(role: BatchRole, label: string): void;
  /** The agent recorded for a batch role, undefined until that role has run. */
  batchRole(role: BatchRole): string | undefined;
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
      const reviewedBy: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw?.reviewedBy ?? {})) {
        if (typeof value === "string") reviewedBy[key] = value;
      }
      const batchRoles: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw?.batchRoles ?? {})) {
        if (typeof value === "string") batchRoles[key] = value;
      }
      const greenTrees: string[] = Array.isArray(raw?.greenTrees)
        ? raw.greenTrees.filter((tree: unknown) => typeof tree === "string")
        : [];
      const text = (value: unknown) => (typeof value === "string" ? value : undefined);
      return {
        sessions,
        quotaResetAt: text(raw?.quotaResetAt),
        geminiQuotaResetAt: text(raw?.geminiQuotaResetAt),
        codexQuotaResetAt: text(raw?.codexQuotaResetAt),
        codexAccountQuotaResetAt: Object.fromEntries(
          Object.entries(raw?.codexAccountQuotaResetAt ?? {}).filter(([, value]) => typeof value === "string"),
        ) as Record<string, string>,
        implementedBy,
        reviewedBy,
        batchRoles,
        greenTrees,
      };
    } catch {
      return { sessions: {}, implementedBy: {}, reviewedBy: {}, batchRoles: {}, greenTrees: [] };
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

  let codexAccount: string | undefined;

  return {
    useCodexAccount: (account) => {
      codexAccount = account;
    },
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
      const state = read();
      const value =
        provider === "codex" && codexAccount !== undefined
          ? state.codexAccountQuotaResetAt?.[codexAccount]
          : state[RESET_KEYS[provider]];
      const date = value ? new Date(value) : undefined;
      return date && !Number.isNaN(date.getTime()) ? date : undefined;
    },
    recordQuotaReset: (provider, at, account) =>
      update((state) => {
        const target = account ?? codexAccount;
        if (provider === "codex" && target !== undefined) {
          state.codexAccountQuotaResetAt = { ...state.codexAccountQuotaResetAt, [target]: at.toISOString() };
        } else {
          state[RESET_KEYS[provider]] = at.toISOString();
        }
      }),
    recordImplementer: (issue, label) =>
      update((state) => {
        state.implementedBy[String(issue)] = label;
      }),
    implementedBy: () => read().implementedBy,
    recordReviewer: (issue, label) =>
      update((state) => {
        state.reviewedBy[String(issue)] = label;
      }),
    reviewedBy: () => read().reviewedBy,
    recordBatchRole: (role, label) =>
      update((state) => {
        state.batchRoles[role] = label;
      }),
    batchRole: (role) => read().batchRoles[role],
    isGreenTree: (tree) => read().greenTrees.includes(tree),
    recordGreenTree: (tree) =>
      update((state) => {
        const others = state.greenTrees.filter((known) => known !== tree);
        state.greenTrees = [...others, tree].slice(-GREEN_TREE_LIMIT);
      }),
  };
}
