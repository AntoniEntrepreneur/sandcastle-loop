// Reviewer cost controls: which model reviews a branch and whether the diff is
// pasted whole. Pure functions over `git diff --numstat` text and token counts.

/** Lockfiles that don't count toward a diff's size. */
export const LOCKFILES = ["package-lock.json", "frontend/package-lock.json", "uv.lock"];

/** Changed lines at which the reviewer moves from Sonnet to Opus. */
export const OPUS_LINE_THRESHOLD = 200;

/** Estimated tokens above which the reviewer gets a `--stat` summary. */
export const FULL_DIFF_TOKEN_LIMIT = 15_000;

/** Added plus removed lines in `git diff --numstat` output, lockfiles ignored. */
export function changedLines(numstat: string): number {
  let total = 0;
  for (const line of numstat.split("\n")) {
    const [added, removed, path] = line.split("\t");
    if (path === undefined || LOCKFILES.includes(path.trim())) continue;
    total += (Number(added) || 0) + (Number(removed) || 0);
  }
  return total;
}

/** The reviewer model for a diff of `lines` changed lines, with the reason. */
export function chooseReviewerModel(lines: number): { model: string; reason: string } {
  return lines < OPUS_LINE_THRESHOLD
    ? { model: "claude-sonnet-5", reason: `${lines} changed lines, under ${OPUS_LINE_THRESHOLD}` }
    : { model: "claude-opus-5", reason: `${lines} changed lines, ${OPUS_LINE_THRESHOLD} or more` };
}

/** Rough token count: four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Whether the reviewer gets the whole diff or only its `--stat`. */
export function diffPresentation(tokens: number): "full" | "stat" {
  return tokens > FULL_DIFF_TOKEN_LIMIT ? "stat" : "full";
}
