// Which agent and model each of the four roles runs, whose quota the run
// spends, and which sign-in files are needed. The orchestrator builds its
// agents from this plan; the plan builds none, so it is testable without the
// engine (#802).

import type { Implementer, QuotaProvider } from "./overnight.mts";
import { OPUS_LINE_THRESHOLD, chooseReviewerModel } from "./reviewDiff.mts";

/** Which agent runs a role. */
export type AgentKind = "claude" | "agy" | "codex";

/**
 * How hard a role thinks: Claude Code's `--effort`, Codex's
 * `model_reasoning_effort`, and the `-medium`/`-low` suffix of agy's model.
 */
export type RoleEffort = "low" | "medium" | "high";

/**
 * Each role's effort, whichever agent runs it: the one ladder Claude, Codex
 * and agy share, so `--implementer codex` and a Claude implementer compare
 * like for like. The reviewer's depth comes from its larger model on a large
 * diff, not from its effort.
 */
export const ROLE_EFFORT = {
  implementer: "medium",
  reviewer: "medium",
  merger: "low",
  prWriter: "low",
} as const satisfies Record<keyof RoleFlags, RoleEffort>;

/** The model every Claude role runs, the implementer included while #725 lands. */
export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";

/** The Claude reviewer's model for a diff of OPUS_LINE_THRESHOLD changed lines or more. */
export const CLAUDE_LARGE_REVIEW_MODEL = "claude-opus-5";

/**
 * The implementer model for agy. Other roles use their role-specific variants.
 */
export const AGY_MEDIUM_MODEL = "gemini-3.8-flash-medium";
export const AGY_HIGH_MODEL = "gemini-3.8-flash-high";
export const AGY_LOW_MODEL = "gemini-3.8-flash-low";

/**
 * The model the run's one Gemini probe asks. The probe spends no quota, so it
 * keeps the high variant even though no role runs it now. Every Flash variant is assumed to
 * draw on the one "Gemini Models" row `agy -p "/usage"` reports.
 */
export const AGY_PROBE_MODEL = AGY_HIGH_MODEL;

/**
 * Each Codex role's model. The implementer, whose draft everything else
 * checks, runs Codex's workhorse; the merger and the PR writer, short and
 * well-specified jobs, its cheap model. The reviewer's model hangs on its
 * diff's size, as Claude's does: Sol under OPUS_LINE_THRESHOLD changed lines,
 * Astra at or over it.
 */
export const CODEX_MODEL = {
  implementer: "gpt-6.1-sol",
  merger: "gpt-6-luna",
  prWriter: "gpt-6-luna",
  smallReview: "gpt-6.1-sol",
  largeReview: "gpt-6-astra",
} as const;

/** Marks a non-Claude agent in a label, so Gemini's and Codex's work reads apart from Claude's. */
const LABEL_SUFFIX = { agy: " (agy)", codex: " (codex)" } as const;

/**
 * How the token table and the PR body name the agent that ran a role, its
 * effort included where the agent takes effort as its own setting: e.g.
 * `claude-sonnet-5 medium`, `gpt-6.1-sol medium (codex)`. An agy model's name
 * already carries its effort.
 */
export function roleLabel(kind: AgentKind, model: string, effort?: RoleEffort): string {
  const name = effort === undefined ? model : `${model} ${effort}`;
  return kind === "claude" ? name : `${name}${LABEL_SUFFIX[kind]}`;
}

/** Whether a recorded label names an agent other than Claude: agy or Codex. */
export function isNonClaudeLabel(label: string | undefined): boolean {
  return label !== undefined && Object.values(LABEL_SUFFIX).some((suffix) => label.endsWith(suffix));
}

/** The agent a role whose model is fixed in code runs. */
export interface RoleAgent {
  readonly kind: AgentKind;
  readonly model: string;
  /** Set for a Claude or Codex role; an agy model's name carries its own. */
  readonly effort?: RoleEffort;
  readonly label: string;
}

/** The reviewer's agent, whose model is only known once its diff is. */
export interface ReviewerPlan {
  readonly kind: AgentKind;
  /** Set for a Claude or Codex reviewer; an agy model's name carries its own. */
  readonly effort?: RoleEffort;
  /** The model for a diff of `changedLines`, and the reason it was picked. */
  model(changedLines: number): { model: string; reason: string };
}

export interface RolePlan {
  readonly implementer: RoleAgent;
  readonly reviewer: ReviewerPlan;
  readonly merger: RoleAgent;
  readonly prWriter: RoleAgent;
  /** Whose quota the run spends, each gated on its own reset: Claude when any role is Claude, Gemini when any role is agy, Codex when any role is Codex. */
  readonly quotaProviders: readonly QuotaProvider[];
  /** True exactly when some role is agy: the sign-in files are mounted, so an all-Claude run never sees them. */
  readonly needsAgySignIn: boolean;
  /** The role flags that asked for agy, for the missing-sign-in error to name. */
  readonly agyFlags: readonly string[];
  /** True exactly when some role is Codex: its sign-in and sandbox home are mounted only then. */
  readonly needsCodexSignIn: boolean;
  /** The role flags that asked for Codex, for the missing-sign-in error to name. */
  readonly codexFlags: readonly string[];
}

/** The role flags of a parsed command line; absent means Claude for that role. */
export type RoleFlags = {
  readonly implementer?: Implementer;
  readonly reviewer?: Implementer;
  readonly merger?: Implementer;
  readonly prWriter?: Implementer;
};

/** Each role's flag, in the order the sign-in errors name them. */
const ROLE_FLAGS: readonly { role: keyof RoleFlags; flag: string }[] = [
  { role: "implementer", flag: "--implementer" },
  { role: "reviewer", flag: "--reviewer" },
  { role: "merger", flag: "--merger" },
  { role: "prWriter", flag: "--pr-writer" },
];

/** The role flags that asked for `agent`, e.g. `--reviewer codex`. */
function flagsFor(flags: RoleFlags, agent: Implementer): string[] {
  return ROLE_FLAGS.filter(({ role }) => flags[role] === agent).map(({ flag }) => `${flag} ${agent}`);
}

/** Which agent a role flag names. */
function kindOf(flag: Implementer | undefined): AgentKind {
  return flag ?? "claude";
}

/** The agent of a role whose model is fixed in code, from what its flag said. */
function fixedRole(
  role: Exclude<keyof RoleFlags, "reviewer">,
  flag: Implementer | undefined,
  agyModel: string,
): RoleAgent {
  const kind = kindOf(flag);
  if (kind === "agy") return { kind, model: agyModel, label: roleLabel(kind, agyModel) };
  const model = kind === "codex" ? CODEX_MODEL[role] : CLAUDE_DEFAULT_MODEL;
  const effort = ROLE_EFFORT[role];
  return { kind, model, effort, label: roleLabel(kind, model, effort) };
}

/** Build the role plan for this run from the parsed command line. */
export function rolePlan(flags: RoleFlags): RolePlan {
  const agyFlags = flagsFor(flags, "agy");
  const codexFlags = flagsFor(flags, "codex");
  const reviewerKind = kindOf(flags.reviewer);
  const usesClaude = [flags.implementer, flags.reviewer, flags.merger, flags.prWriter].some(
    (flag) => kindOf(flag) === "claude",
  );
  return {
    implementer: fixedRole("implementer", flags.implementer, AGY_MEDIUM_MODEL),
    reviewer: {
      kind: reviewerKind,
      ...(reviewerKind === "agy" ? {} : { effort: ROLE_EFFORT.reviewer }),
      model: (changedLines) => chooseReviewerModel(changedLines, reviewerKind),
    },
    merger: fixedRole("merger", flags.merger, AGY_LOW_MODEL),
    prWriter: fixedRole("prWriter", flags.prWriter, AGY_LOW_MODEL),
    quotaProviders: [
      ...(usesClaude ? (["claude"] as const) : []),
      ...(agyFlags.length > 0 ? (["gemini"] as const) : []),
      ...(codexFlags.length > 0 ? (["codex"] as const) : []),
    ],
    needsAgySignIn: agyFlags.length > 0,
    agyFlags,
    needsCodexSignIn: codexFlags.length > 0,
    codexFlags,
  };
}

/** One role's banner cell: its agent, model and, unless agy, effort. */
function describe(kind: AgentKind, model: string, effort: RoleEffort | undefined): string {
  return effort === undefined ? `${kind} ${model}` : `${kind} ${model} (${effort} effort)`;
}

/** The startup banner and dry-run plan's lines, naming each role's agent and model. */
export function formatRoleBanner(plan: RolePlan): string {
  const { kind, effort } = plan.reviewer;
  const small = plan.reviewer.model(OPUS_LINE_THRESHOLD - 1).model;
  const large = plan.reviewer.model(OPUS_LINE_THRESHOLD).model;
  const reviewer =
    small === large
      ? `${describe(kind, small, effort)} at any diff size`
      : `${describe(kind, small, effort)} (under ${OPUS_LINE_THRESHOLD} changed lines) / ${large} (${OPUS_LINE_THRESHOLD} or more)`;
  const fixed = (role: RoleAgent) => describe(role.kind, role.model, role.effort);
  return [
    "Roles:",
    `  Implementer: ${fixed(plan.implementer)}`,
    `  Reviewer:    ${reviewer}`,
    `  Merger:      ${fixed(plan.merger)}`,
    `  PR writer:   ${fixed(plan.prWriter)}`,
  ].join("\n");
}
