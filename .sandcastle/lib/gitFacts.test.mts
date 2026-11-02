// Tests for the git-backed module against throwaway repositories.
//
// Each test builds its own repo in a temp directory — a main, an integration
// branch, issue branches — and asserts what the module concludes, not which
// git commands it ran.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  catchUpWithRemote,
  doneIssues,
  gitAnswered,
  isBatchBranchShipped,
  isBehind,
  isStale,
  markDone,
  mergeEach,
  prunableBranches,
  readyToMerge,
  saveWorktree,
  cleanTree,
  unfinishedBranches,
} from "./gitFacts.mts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** A throwaway repo with an initial commit on `main`, cleaned up after the test. */
function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gitfacts-test-"));
  git(dir, ["init", "--initial-branch=main", "--quiet"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "root\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "root", "--quiet"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function commitFile(cwd: string, name: string, contents: string, message: string): void {
  writeFileSync(join(cwd, name), contents);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message, "--quiet"]);
}

// --- done markers ------------------------------------------------------------

test("an issue branch with zero own commits is not done and not ready to merge", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "integration", "main"]);
    git(dir, ["branch", "sandcastle/issue-1", "integration"]);

    assert.deepEqual(doneIssues(dir, "integration"), []);
    assert.deepEqual(
      readyToMerge(dir, "integration", [{ issueNumber: 1, branch: "sandcastle/issue-1" }]),
      [],
    );
  } finally {
    cleanup();
  }
});

test("a branch with agent commits but no Done marker is unfinished, not ready to merge", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "integration", "main"]);
    git(dir, ["checkout", "-b", "sandcastle/issue-1", "integration", "--quiet"]);
    commitFile(dir, "feature.txt", "work\n", "implement feature");
    git(dir, ["checkout", "integration", "--quiet"]);

    const branches = [{ issueNumber: 1, branch: "sandcastle/issue-1" }];
    assert.deepEqual(unfinishedBranches(dir, "integration", branches), ["sandcastle/issue-1"]);
    assert.deepEqual(readyToMerge(dir, "integration", branches), []);
    assert.deepEqual(doneIssues(dir, "integration"), []);
  } finally {
    cleanup();
  }
});

/** Pins that markers are still read once the branch's whole log passes Node's 1 MiB exec buffer. */
test("Done markers are found on a branch whose full log is over 1 MiB", () => {
  const { dir, cleanup } = makeRepo();
  try {
    const message = join(dir, ".git", "LONG_MESSAGE");
    writeFileSync(message, `long history\n\n${"x".repeat(1_100_000)}\n`);
    git(dir, ["commit", "--allow-empty", "--quiet", "-F", message]);
    git(dir, ["branch", "integration", "main"]);
    git(dir, ["checkout", "integration", "--quiet"]);
    markDone(dir, 1, "integration");

    assert.deepEqual(doneIssues(dir, "integration"), [1]);
  } finally {
    cleanup();
  }
});

test("a completion with zero agent commits, once marked, is done", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "integration", "main"]);
    git(dir, ["checkout", "-b", "sandcastle/issue-1", "integration", "--quiet"]);
    markDone(dir, 1, "integration");
    git(dir, ["checkout", "integration", "--quiet"]);
    git(dir, ["merge", "sandcastle/issue-1", "--no-ff", "--no-edit", "--quiet"]);

    assert.deepEqual(doneIssues(dir, "integration"), [1]);
    assert.deepEqual(
      readyToMerge(dir, "integration", [{ issueNumber: 1, branch: "sandcastle/issue-1" }]),
      [],
      "already merged into integration, so no longer ready to merge",
    );
  } finally {
    cleanup();
  }
});

test("a Done marker naming a different integration branch doesn't count", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "integration-a", "main"]);
    git(dir, ["branch", "integration-b", "main"]);
    git(dir, ["checkout", "-b", "sandcastle/issue-1", "integration-a", "--quiet"]);
    commitFile(dir, "feature.txt", "work\n", "implement feature");
    markDone(dir, 1, "integration-a");

    assert.deepEqual(
      readyToMerge(dir, "integration-b", [{ issueNumber: 1, branch: "sandcastle/issue-1" }]),
      [],
    );
    assert.deepEqual(
      readyToMerge(dir, "integration-a", [{ issueNumber: 1, branch: "sandcastle/issue-1" }]),
      ["sandcastle/issue-1"],
    );
  } finally {
    cleanup();
  }
});

// --- saving --------------------------------------------------------------

test("saving a dirty worktree produces exactly one WIP commit", () => {
  const { dir, cleanup } = makeRepo();
  try {
    const before = git(dir, ["rev-list", "--count", "HEAD"]);
    writeFileSync(join(dir, "scratch.txt"), "mid-edit\n");

    const saved = saveWorktree(dir, 42, "run-died");

    assert.equal(saved, true);
    const after = git(dir, ["rev-list", "--count", "HEAD"]);
    assert.equal(Number(after) - Number(before), 1);
    assert.match(git(dir, ["log", "-1", "--format=%s"]), /^Sandcastle-WIP: #42 — run died$/);
  } finally {
    cleanup();
  }
});

/** Pins that a clean worktree's tree is HEAD's, the same across commits that change no file, and a dirty one has none. */
test("a clean worktree has HEAD's tree; a dirty one has none", () => {
  const { dir, cleanup } = makeRepo();
  try {
    const tree = cleanTree(dir);
    assert.equal(tree, git(dir, ["rev-parse", "HEAD^{tree}"]));
    git(dir, ["commit", "--allow-empty", "-m", "marker", "--quiet"]);
    assert.equal(cleanTree(dir), tree);
    writeFileSync(join(dir, "scratch.txt"), "mid-edit\n");
    assert.equal(cleanTree(dir), undefined);
  } finally {
    cleanup();
  }
});

test("saving a clean worktree produces no commit", () => {
  const { dir, cleanup } = makeRepo();
  try {
    const before = git(dir, ["rev-list", "--count", "HEAD"]);
    const saved = saveWorktree(dir, 42, "iteration-ended");
    assert.equal(saved, false);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), before);
  } finally {
    cleanup();
  }
});

// --- merging -----------------------------------------------------------------

/** An issue branch off `integration` carrying one file and its Done marker. */
function finishedIssueBranch(dir: string, issue: number, file: string, contents: string): string {
  const branch = `sandcastle/issue-${issue}`;
  git(dir, ["checkout", "-b", branch, "integration", "--quiet"]);
  commitFile(dir, file, contents, `implement #${issue}`);
  markDone(dir, issue, "integration");
  return branch;
}

test("clean branches merge with their Done markers and leave nothing ready", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "integration", "main"]);
    const one = finishedIssueBranch(dir, 1, "one.txt", "one\n");
    const two = finishedIssueBranch(dir, 2, "two.txt", "two\n");
    git(dir, ["checkout", "integration", "--quiet"]);

    assert.deepEqual(mergeEach(dir, [one, two]), { merged: [one, two], conflicted: [], conflictFiles: {} });
    assert.deepEqual(doneIssues(dir, "integration").sort(), [1, 2]);
    assert.deepEqual(
      readyToMerge(dir, "integration", [
        { issueNumber: 1, branch: one },
        { issueNumber: 2, branch: two },
      ]),
      [],
    );
  } finally {
    cleanup();
  }
});

test("a conflicting branch is aborted and reported, and the next branch still merges", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "integration", "main"]);
    const one = finishedIssueBranch(dir, 1, "README.md", "one\n");
    const two = finishedIssueBranch(dir, 2, "README.md", "two\n");
    const three = finishedIssueBranch(dir, 3, "three.txt", "three\n");
    git(dir, ["checkout", "integration", "--quiet"]);

    assert.deepEqual(mergeEach(dir, [one, two, three]), {
      merged: [one, three],
      conflicted: [two],
      conflictFiles: { [two]: ["README.md"] },
    });
    assert.equal(git(dir, ["status", "--porcelain"]), "");
    assert.deepEqual(doneIssues(dir, "integration").sort(), [1, 3]);
  } finally {
    cleanup();
  }
});

test("a merge an interrupted agent left half-resolved is abandoned before merging", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "integration", "main"]);
    const one = finishedIssueBranch(dir, 1, "README.md", "one\n");
    const two = finishedIssueBranch(dir, 2, "README.md", "two\n");
    git(dir, ["checkout", "integration", "--quiet"]);
    git(dir, ["merge", one, "--no-edit", "--quiet"]);
    try {
      git(dir, ["merge", two, "--no-edit", "--quiet"]);
    } catch {
      // The conflict is the point: it leaves MERGE_HEAD behind.
    }

    assert.deepEqual(mergeEach(dir, [two]), {
      merged: [],
      conflicted: [two],
      conflictFiles: { [two]: ["README.md"] },
    });
    assert.equal(git(dir, ["status", "--porcelain"]), "");
  } finally {
    cleanup();
  }
});

// --- stale -----------------------------------------------------------------

test("a branch whose commits were squash-merged into main is stale", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "sandcastle/issue-1", "main", "--quiet"]);
    commitFile(dir, "feature.txt", "work\n", "implement feature");

    git(dir, ["checkout", "main", "--quiet"]);
    git(dir, ["merge", "sandcastle/issue-1", "--squash", "--quiet"]);
    git(dir, ["commit", "-m", "squashed feature", "--quiet"]);

    assert.equal(isStale(dir, "sandcastle/issue-1", "main"), true);
  } finally {
    cleanup();
  }
});

test("a branch with a mix of squashed and new commits is not stale", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "sandcastle/issue-1", "main", "--quiet"]);
    commitFile(dir, "feature.txt", "work\n", "implement feature");

    git(dir, ["checkout", "main", "--quiet"]);
    git(dir, ["merge", "sandcastle/issue-1", "--squash", "--quiet"]);
    git(dir, ["commit", "-m", "squashed feature", "--quiet"]);

    git(dir, ["checkout", "sandcastle/issue-1", "--quiet"]);
    commitFile(dir, "more.txt", "new work\n", "new commit after the squash");

    assert.equal(isStale(dir, "sandcastle/issue-1", "main"), false);
  } finally {
    cleanup();
  }
});

// --- shipped -----------------------------------------------------------------

test("a squash-merged batch branch named in the merged-PR list is shipped", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "sandcastle/batch-1-1000", "main", "--quiet"]);
    commitFile(dir, "feature.txt", "work\n", "batch work");
    git(dir, ["checkout", "main", "--quiet"]);
    git(dir, ["merge", "sandcastle/batch-1-1000", "--squash", "--quiet"]);
    git(dir, ["commit", "-m", "squashed batch", "--quiet"]);

    assert.equal(
      isBatchBranchShipped(dir, "sandcastle/batch-1-1000", "main", ["sandcastle/batch-1-1000"]),
      true,
    );
  } finally {
    cleanup();
  }
});

test("an unmerged batch branch not in the merged-PR list is outstanding", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "sandcastle/batch-1-1000", "main", "--quiet"]);
    commitFile(dir, "feature.txt", "work\n", "batch work");

    assert.equal(isBatchBranchShipped(dir, "sandcastle/batch-1-1000", "main", []), false);
  } finally {
    cleanup();
  }
});

test("a batch branch merged by fast-forward ancestry is shipped without a PR list entry", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "sandcastle/batch-1-1000", "main", "--quiet"]);
    commitFile(dir, "feature.txt", "work\n", "batch work");
    git(dir, ["checkout", "main", "--quiet"]);
    git(dir, ["merge", "sandcastle/batch-1-1000", "--ff-only", "--quiet"]);

    assert.equal(isBatchBranchShipped(dir, "sandcastle/batch-1-1000", "main", []), true);
  } finally {
    cleanup();
  }
});

// --- catching up with the remote copy ------------------------------------------

/** Pretend `ref` was fetched as `origin/<branch>`. */
function setRemote(cwd: string, branch: string, ref: string): void {
  git(cwd, ["update-ref", `refs/remotes/origin/${branch}`, ref]);
}

test("a batch branch never pushed has no remote to catch up with", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "batch", "main"]);
    assert.equal(catchUpWithRemote(dir, "batch", "origin/batch"), "no-remote");
  } finally {
    cleanup();
  }
});

test("a batch branch behind its remote copy is fast-forwarded to it", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "batch", "main"]);
    commitFile(dir, "main.txt", "update\n", "update main");
    setRemote(dir, "batch", "main");

    assert.equal(catchUpWithRemote(dir, "batch", "origin/batch"), "fast-forwarded");
    assert.equal(git(dir, ["rev-parse", "batch"]), git(dir, ["rev-parse", "main"]));
  } finally {
    cleanup();
  }
});

test("a batch branch checked out in a worktree is fast-forwarded there, files included", () => {
  const { dir, cleanup } = makeRepo();
  const worktree = mkdtempSync(join(tmpdir(), "gitfacts-wt-"));
  try {
    commitFile(dir, "main.txt", "update\n", "update main");
    setRemote(dir, "batch", "main");
    git(dir, ["worktree", "add", "--quiet", "-b", "batch", worktree, "main~1"]);

    assert.equal(catchUpWithRemote(dir, "batch", "origin/batch"), "fast-forwarded");
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), git(dir, ["rev-parse", "main"]));
    assert.equal(git(worktree, ["status", "--porcelain"]), "");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    cleanup();
  }
});

test("a batch branch ahead of its remote copy keeps its local commits", () => {
  const { dir, cleanup } = makeRepo();
  try {
    setRemote(dir, "batch", "main");
    git(dir, ["checkout", "-b", "batch", "--quiet"]);
    commitFile(dir, "local.txt", "local\n", "local work");
    const tip = git(dir, ["rev-parse", "batch"]);

    assert.equal(catchUpWithRemote(dir, "batch", "origin/batch"), "up-to-date");
    assert.equal(git(dir, ["rev-parse", "batch"]), tip);
  } finally {
    cleanup();
  }
});

test("a batch branch diverged from its remote copy is left untouched", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "batch", "--quiet"]);
    commitFile(dir, "local.txt", "local\n", "local work");
    const tip = git(dir, ["rev-parse", "batch"]);
    git(dir, ["checkout", "main", "--quiet"]);
    commitFile(dir, "remote.txt", "remote\n", "remote work");
    setRemote(dir, "batch", "main");

    assert.equal(catchUpWithRemote(dir, "batch", "origin/batch"), "diverged");
    assert.equal(git(dir, ["rev-parse", "batch"]), tip);
  } finally {
    cleanup();
  }
});

// --- behind main -------------------------------------------------------------

test("a batch branch with its own commits on the current main is not behind it", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "batch", "--quiet"]);
    commitFile(dir, "batch.txt", "batch\n", "batch work");

    assert.equal(isBehind(dir, "batch", "main"), false);
  } finally {
    cleanup();
  }
});

test("a batch branch is behind once main gains a commit it lacks", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "batch", "main"]);
    commitFile(dir, "shipped.txt", "shipped\n", "a sibling PR merged");

    assert.equal(isBehind(dir, "batch", "main"), true);
  } finally {
    cleanup();
  }
});

test("a batch branch that has merged main in is no longer behind", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["checkout", "-b", "batch", "--quiet"]);
    commitFile(dir, "batch.txt", "batch\n", "batch work");
    git(dir, ["checkout", "main", "--quiet"]);
    commitFile(dir, "shipped.txt", "shipped\n", "a sibling PR merged");
    git(dir, ["checkout", "batch", "--quiet"]);
    git(dir, ["merge", "--no-ff", "--no-edit", "--quiet", "main"]);

    assert.equal(isBehind(dir, "batch", "main"), false);
  } finally {
    cleanup();
  }
});

// --- git answering vs. git failing --------------------------------------------

test("a git command that exits non-zero has answered", () => {
  assert.equal(gitAnswered(Object.assign(new Error("exit 1"), { status: 1 })), true);
});

/** Pins #855's root cause: an overflowed buffer once read as "no Done markers". */
test("a git command killed for overflowing its buffer has not answered", () => {
  const overflow = Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS", status: null });
  assert.equal(gitAnswered(overflow), false);
});

test("a missing git binary has not answered", () => {
  assert.equal(gitAnswered(Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" })), false);
});

// --- pruning -----------------------------------------------------------------

/** A batch branch `integration` with issue #1 finished and merged into it, main checked out. */
function batchWithOneMergedIssue(dir: string): string {
  git(dir, ["branch", "integration", "main"]);
  const one = finishedIssueBranch(dir, 1, "one.txt", "one\n");
  git(dir, ["checkout", "integration", "--quiet"]);
  mergeEach(dir, [one]);
  git(dir, ["checkout", "main", "--quiet"]);
  return one;
}

test("a shipped batch branch and the issue branches merged into it are prunable", () => {
  const { dir, cleanup } = makeRepo();
  try {
    const one = batchWithOneMergedIssue(dir);

    assert.deepEqual(
      prunableBranches(dir, {
        batchBranches: ["integration"],
        issueBranches: [one],
        mainRef: "main",
        mergedPrHeadBranches: ["integration"],
      }),
      { batches: ["integration"], issues: [one] },
    );
  } finally {
    cleanup();
  }
});

test("an unshipped batch branch and its issue branches are kept", () => {
  const { dir, cleanup } = makeRepo();
  try {
    const one = batchWithOneMergedIssue(dir);

    assert.deepEqual(
      prunableBranches(dir, {
        batchBranches: ["integration"],
        issueBranches: [one],
        mainRef: "main",
        mergedPrHeadBranches: [],
      }),
      { batches: [], issues: [] },
    );
  } finally {
    cleanup();
  }
});

test("an issue branch with commits no shipped batch holds is kept", () => {
  const { dir, cleanup } = makeRepo();
  try {
    const one = batchWithOneMergedIssue(dir);
    git(dir, ["checkout", one, "--quiet"]);
    commitFile(dir, "later.txt", "later\n", "work after the merge");
    git(dir, ["checkout", "main", "--quiet"]);

    assert.deepEqual(
      prunableBranches(dir, {
        batchBranches: ["integration"],
        issueBranches: [one],
        mainRef: "main",
        mergedPrHeadBranches: ["integration"],
      }),
      { batches: ["integration"], issues: [] },
    );
  } finally {
    cleanup();
  }
});

test("an issue branch already on main is prunable without a batch", () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ["branch", "sandcastle/issue-1", "main"]);

    assert.deepEqual(
      prunableBranches(dir, {
        batchBranches: [],
        issueBranches: ["sandcastle/issue-1"],
        mainRef: "main",
        mergedPrHeadBranches: [],
      }),
      { batches: [], issues: ["sandcastle/issue-1"] },
    );
  } finally {
    cleanup();
  }
});
