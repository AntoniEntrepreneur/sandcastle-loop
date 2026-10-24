// Git facts about Sandcastle branches: saved vs. done, shipped vs. stale.
//
// Every git read or write the orchestrator makes about an issue or batch
// branch's *progress* goes through here, so a WIP save, a Done marker and a
// stale check are each defined once and asked about consistently. main.mts
// still owns `gh` reads and the sandbox/agent lifecycle; this module knows
// nothing about either.
//
// "Saved" and "done" are deliberately different questions. A commit means only
// that an agent's work survived an interruption — see saveWorktree. "Done"
// means the orchestrator itself decided the issue is finished and recorded
// that with a Done marker — see markDone. Only markers decide what gets
// merged, picked up or closed.

import { execFileSync } from "node:child_process";

import { parseDoneTrailers, type DoneMarker } from "./groups.mts";

/** Run a git command in `cwd` and return its trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Run a git command in `cwd`, returning its trimmed stdout or undefined if it failed. */
function gitQuiet(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Whether `branch` exists locally in `cwd`. */
function branchExists(cwd: string, branch: string): boolean {
  return gitQuiet(cwd, ["rev-parse", "--verify", "--quiet", branch]) !== undefined;
}

/** Whether `ancestor` is reachable from `ref` — i.e. already merged into it. */
function isAncestorOf(cwd: string, ancestor: string, ref: string): boolean {
  if (!branchExists(cwd, ancestor) || !branchExists(cwd, ref)) return false;
  return (
    gitQuiet(cwd, ["merge-base", "--is-ancestor", ancestor, ref]) !== undefined
  );
}

/** Count commits on `branch` that `ref` does not already contain. */
function commitsAhead(cwd: string, ref: string, branch: string): number {
  if (!branchExists(cwd, branch) || !branchExists(cwd, ref)) return 0;
  return Number(git(cwd, ["rev-list", "--count", `${ref}..${branch}`]));
}

// ---------------------------------------------------------------------------
// Saved: the orchestrator's own WIP commits
// ---------------------------------------------------------------------------

/** Why a worktree was saved — folded into the WIP commit's subject line. */
export type SaveReason = "iteration-ended" | "run-died" | "found-dirty-at-start" | "formatted";

const SAVE_REASON_TEXT: Record<SaveReason, string> = {
  "iteration-ended": "iteration ended",
  "run-died": "run died",
  "found-dirty-at-start": "found dirty at start",
  formatted: "formatting",
};

/** Subject prefix that marks a commit as an orchestrator save, not an agent's own. */
export const WIP_SUBJECT_PREFIX = "Sandcastle-WIP:";

/**
 * Commit everything in a dirty worktree with a WIP subject naming the issue
 * and why it was saved. No-op on a clean worktree. Skips commit hooks — a WIP
 * save must never be refused by a formatter, since the point is to lose
 * nothing an interrupted agent left behind.
 *
 * Returns whether a commit was made.
 */
export function saveWorktree(
  worktreeCwd: string,
  issueNumber: number,
  reason: SaveReason,
): boolean {
  const status = git(worktreeCwd, ["status", "--porcelain"]);
  if (status.length === 0) return false;

  git(worktreeCwd, ["add", "-A"]);
  git(worktreeCwd, [
    "commit",
    "--no-verify",
    "-m",
    `${WIP_SUBJECT_PREFIX} #${issueNumber} — ${SAVE_REASON_TEXT[reason]}`,
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// Done: markers the orchestrator writes once an issue is finished
// ---------------------------------------------------------------------------

/**
 * Add the Done marker to the branch checked out at `worktreeCwd`: an empty
 * commit whose message carries a `Sandcastle-Done: #<issue>` trailer and a
 * `Sandcastle-Batch: <integrationBranch>` trailer. Markers are found by
 * trailer, never by content, so the marker's own empty diff is never mistaken
 * for finished work.
 */
export function markDone(
  worktreeCwd: string,
  issueNumber: number,
  integrationBranch: string,
): void {
  const message = [
    `Sandcastle: #${issueNumber} done`,
    "",
    `Sandcastle-Done: #${issueNumber}`,
    `Sandcastle-Batch: ${integrationBranch}`,
  ].join("\n");
  git(worktreeCwd, ["commit", "--allow-empty", "--no-verify", "-m", message]);
}

/** Every Done marker reachable from `ref`, parsed from its trailers. */
function doneMarkersOn(cwd: string, ref: string): DoneMarker[] {
  if (!branchExists(cwd, ref)) return [];
  const raw = gitQuiet(cwd, ["log", ref, "--format=%B\x02"]);
  if (!raw) return [];

  return raw
    .split("\x02")
    .map(parseDoneTrailers)
    .filter((marker): marker is DoneMarker => marker !== undefined);
}

/**
 * The issue numbers whose Done marker for `integrationBranch` is reachable
 * from it. Replaces merged-branch resolution by ancestry: an issue counts
 * once the orchestrator recorded it as finished, not once its branch happens
 * to be an ancestor.
 */
export function doneIssues(cwd: string, integrationBranch: string): number[] {
  return [...new Set(
    doneMarkersOn(cwd, integrationBranch)
      .filter((marker) => marker.batch === integrationBranch)
      .map((marker) => marker.issue),
  )];
}

/** Whether `branch` carries a Done marker for `integrationBranch` naming `issueNumber`. */
function hasDoneMarkerFor(
  cwd: string,
  branch: string,
  integrationBranch: string,
  issueNumber: number,
): boolean {
  return doneMarkersOn(cwd, branch).some(
    (marker) => marker.batch === integrationBranch && marker.issue === issueNumber,
  );
}

export interface IssueBranch {
  readonly issueNumber: number;
  readonly branch: string;
}

/**
 * The group's issue branches that carry a Done marker for `integrationBranch`
 * and are not yet part of it. Replaces the "has commits" merge filter: a
 * branch with agent commits but no marker is never ready, however much work
 * it holds.
 */
export function readyToMerge(
  cwd: string,
  integrationBranch: string,
  issueBranches: IssueBranch[],
): string[] {
  return issueBranches
    .filter(({ branch }) => branchExists(cwd, branch))
    .filter(({ branch, issueNumber }) =>
      hasDoneMarkerFor(cwd, branch, integrationBranch, issueNumber),
    )
    .filter(({ branch }) => !isAncestorOf(cwd, branch, integrationBranch))
    .map(({ branch }) => branch);
}

/**
 * Issue branches holding saved work with no Done marker for `integrationBranch`.
 * Feeds the stranded-work warning and the group-complete check: a group with
 * unfinished work — saved, but never marked done — stays a draft.
 */
export function unfinishedBranches(
  cwd: string,
  integrationBranch: string,
  issueBranches: IssueBranch[],
): string[] {
  return issueBranches
    .filter(({ branch }) => branchExists(cwd, branch))
    .filter(({ branch }) => commitsAhead(cwd, integrationBranch, branch) > 0)
    .filter(
      ({ branch, issueNumber }) =>
        !hasDoneMarkerFor(cwd, branch, integrationBranch, issueNumber),
    )
    .map(({ branch }) => branch);
}

// ---------------------------------------------------------------------------
// Merged: issue branches folded into the integration branch
// ---------------------------------------------------------------------------

/**
 * Merge each branch, in order, into the branch checked out at `worktreeCwd`,
 * the way the merge prompt always asked an agent to: `--no-ff`, default
 * message, so every Done marker survives. A branch that does not merge
 * cleanly is aborted and reported rather than resolved — the worktree is left
 * clean for the next branch, and resolving is the one part worth an agent.
 *
 * A merge an interrupted agent left half-resolved is aborted first. Its
 * branch is not yet an ancestor, so it is still in `branches` and is simply
 * merged again.
 */
export function mergeEach(
  worktreeCwd: string,
  branches: readonly string[],
): { merged: string[]; conflicted: string[] } {
  if (gitQuiet(worktreeCwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]) !== undefined) {
    gitQuiet(worktreeCwd, ["merge", "--abort"]);
  }

  const merged: string[] = [];
  const conflicted: string[] = [];
  for (const branch of branches) {
    if (gitQuiet(worktreeCwd, ["merge", "--no-ff", "--no-edit", branch]) !== undefined) {
      merged.push(branch);
    } else {
      gitQuiet(worktreeCwd, ["merge", "--abort"]);
      conflicted.push(branch);
    }
  }
  return { merged, conflicted };
}

// ---------------------------------------------------------------------------
// Stale: an issue branch whose content already reached main
// ---------------------------------------------------------------------------

/**
 * Whether `branch` holds nothing `mainRef` lacks, compared by content
 * (patch identity, as `git cherry` does) rather than ancestry. A squash merge
 * never makes the original branch an ancestor of main, so this is what tells
 * a branch left pointing at now-squashed commits from one still carrying real
 * work: `git cherry` marks every commit whose patch already landed in main
 * with `-`, and a branch is stale when nothing on it is marked `+`.
 *
 * A Done marker is an empty commit, so its own (empty) patch is never a `+`
 * — the marker itself never keeps a branch from being called stale.
 */
export function isStale(cwd: string, branch: string, mainRef: string): boolean {
  if (!branchExists(cwd, branch)) return true;
  const out = gitQuiet(cwd, ["cherry", mainRef, branch]) ?? "";
  const entries = out.split("\n").filter(Boolean);
  return entries.every((entry) => entry.startsWith("-"));
}

// ---------------------------------------------------------------------------
// Shipped: a batch branch whose work has already reached main
// ---------------------------------------------------------------------------

/**
 * Whether a batch branch has already shipped: `mainRef` has it as an
 * ancestor, or a PR with that head branch has been merged. The second case
 * covers a squash merge, which never makes the branch an ancestor of main.
 * `mergedPrHeadBranches` is supplied by the caller — fetching it is a `gh`
 * read that belongs to the orchestrator, not to this module.
 */
export function isBatchBranchShipped(
  cwd: string,
  branch: string,
  mainRef: string,
  mergedPrHeadBranches: readonly string[],
): boolean {
  if (mergedPrHeadBranches.includes(branch)) return true;
  return isAncestorOf(cwd, branch, mainRef);
}

// ---------------------------------------------------------------------------
// Behind: a batch branch that main has moved on from
// ---------------------------------------------------------------------------

/**
 * Whether `mainRef` holds commits `branch` lacks, so the branch's PR is built
 * on an older main than the one it will merge into. Each group's branch is cut
 * from main and left there, so once a sibling PR merges, every other open
 * batch is behind — and likely to conflict with what just shipped.
 */
export function isBehind(cwd: string, branch: string, mainRef: string): boolean {
  if (!branchExists(cwd, branch) || !branchExists(cwd, mainRef)) return false;
  return !isAncestorOf(cwd, mainRef, branch);
}

// ---------------------------------------------------------------------------
// Remote: catching a resumed batch branch up with its pushed copy
// ---------------------------------------------------------------------------

/** How a local branch stood against its remote copy, and what was done about it. */
export type CatchUp = "no-remote" | "up-to-date" | "fast-forwarded" | "diverged";

/** The worktree that has `branch` checked out, if any. */
function worktreeHolding(cwd: string, branch: string): string | undefined {
  let path: string | undefined;
  for (const line of git(cwd, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/**
 * Fast-forward `branch` to `remoteRef` when the remote copy has moved on — e.g.
 * GitHub's "Update branch" merged main into the PR. Without this the resumed
 * branch is published from its stale tip and the push is rejected (#426).
 *
 * A branch already containing `remoteRef` is left alone, local commits and
 * all. A branch checked out in a worktree is fast-forwarded there, so the
 * worktree's files move with it. "diverged" changes nothing: both sides have
 * commits the other lacks, and choosing between them is a human's call.
 */
export function catchUpWithRemote(cwd: string, branch: string, remoteRef: string): CatchUp {
  if (!branchExists(cwd, remoteRef)) return "no-remote";
  if (isAncestorOf(cwd, remoteRef, branch)) return "up-to-date";
  if (!isAncestorOf(cwd, branch, remoteRef)) return "diverged";

  const worktree = worktreeHolding(cwd, branch);
  if (worktree) {
    git(worktree, ["merge", "--ff-only", "--quiet", remoteRef]);
  } else {
    const old = git(cwd, ["rev-parse", branch]);
    git(cwd, ["update-ref", `refs/heads/${branch}`, remoteRef, old]);
  }
  return "fast-forwarded";
}
