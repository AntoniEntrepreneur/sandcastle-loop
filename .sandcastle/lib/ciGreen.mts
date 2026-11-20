// Whether CI has already vouched for a tree, so the integration sandbox need
// not run the same check again. CI's `check` job runs a superset of the
// project's checkCommand (.github/workflows/ci.yml), so its success on a
// commit is a green verdict for that commit's tree.

/** The name of the CI job whose success vouches for a commit. */
export const CI_CHECK_NAME = "check";

/**
 * Whether `gh api repos/{owner}/{repo}/commits/<sha>/check-runs` output shows a
 * finished, successful `check` run. Any other state, or output that is not
 * that shape, is "no": the caller then runs the check itself.
 */
export function ciCheckPassed(checkRunsJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkRunsJson);
  } catch {
    return false;
  }
  const runs = (parsed as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(runs)) return false;
  return runs.some(
    (run) =>
      run?.name === CI_CHECK_NAME && run?.status === "completed" && run?.conclusion === "success",
  );
}

/**
 * Whether CI's verdict on `baseSha` applies to the tree under check: only when
 * that tree is exactly the base commit's tree, i.e. the branch holds nothing
 * main does not.
 */
export function ciVerdictApplies(currentTree: string | undefined, baseTree: string | undefined): boolean {
  return currentTree !== undefined && currentTree === baseTree;
}

/**
 * Whether CI already vouches for `tree` as `baseRef`'s own tree. Resolves
 * `baseRef` to a commit once and takes both the tree and the CI verdict from
 * that same commit, so a fetch that moves `baseRef` between reads cannot pair
 * one commit's tree with another's passing check.
 */
export function ciHasPassedBase(
  tree: string,
  baseRef: string,
  read: (command: string) => string | undefined,
): boolean {
  const sha = read(`git rev-parse --verify --quiet ${baseRef}^{commit}`);
  if (!sha) return false;
  const baseTree = read(`git rev-parse ${sha}^{tree}`);
  if (!ciVerdictApplies(tree, baseTree)) return false;
  const runs = read(`gh api repos/{owner}/{repo}/commits/${sha}/check-runs`);
  return runs !== undefined && ciCheckPassed(runs);
}
