// Reviewer cost controls: which model reviews a branch and whether the diff is
// pasted whole. Pure functions over `git diff --numstat` text and token counts.

import {
  AGY_MEDIUM_MODEL,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_LARGE_REVIEW_MODEL,
  CODEX_MODEL,
  type AgentKind,
} from "./rolePlan.mts";

/** Changed lines at which the reviewer moves to its larger model: Sonnet to Opus, Sol to Astra. */
export const OPUS_LINE_THRESHOLD = 200;

/** Estimated tokens above which the reviewer gets a `--stat` summary. */
export const FULL_DIFF_TOKEN_LIMIT = 15_000;

/**
 * Added plus removed lines in `git diff --numstat` output, `lockfiles` and paths
 * matching `testFiles` ignored: tests are cheap to review, and counting them
 * would send a small, well-tested change to Opus.
 */
export function changedLines(numstat: string, lockfiles: string[], testFiles: readonly RegExp[] = []): number {
  let total = 0;
  for (const line of numstat.split("\n")) {
    const [added, removed, rawPath] = line.split("\t");
    if (rawPath === undefined) continue;
    const path = rawPath.trim();
    if (lockfiles.includes(path) || testFiles.some((pattern) => pattern.test(path))) continue;
    total += (Number(added) || 0) + (Number(removed) || 0);
  }
  return total;
}

/** The reviewer model for a diff of `lines` changed lines, with the reason. */
export function chooseReviewerModel(
  lines: number,
  kind: AgentKind = "claude",
): { model: string; reason: string } {
  if (kind === "agy") {
    return { model: AGY_MEDIUM_MODEL, reason: `${lines} changed lines, agy reviewer uses medium effort` };
  }
  const [small, large] =
    kind === "codex"
      ? [CODEX_MODEL.smallReview, CODEX_MODEL.largeReview]
      : [CLAUDE_DEFAULT_MODEL, CLAUDE_LARGE_REVIEW_MODEL];
  return lines < OPUS_LINE_THRESHOLD
    ? { model: small, reason: `${lines} changed lines, under ${OPUS_LINE_THRESHOLD}` }
    : { model: large, reason: `${lines} changed lines, ${OPUS_LINE_THRESHOLD} or more` };
}

/** Rough token count: four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Whether the reviewer gets the whole diff or only its `--stat`. */
export function diffPresentation(tokens: number): "full" | "stat" {
  return tokens > FULL_DIFF_TOKEN_LIMIT ? "stat" : "full";
}
