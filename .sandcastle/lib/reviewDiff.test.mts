// Unit tests for the reviewer's model choice and diff presentation.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  changedLines,
  chooseReviewerModel,
  diffPresentation,
  estimateTokens,
} from "./reviewDiff.mts";

/** Pins that under 200 changed lines goes to Sonnet. */
test("under 200 changed lines goes to Sonnet", () => {
  const choice = chooseReviewerModel(199);
  assert.equal(choice.model, "claude-sonnet-5");
  assert.match(choice.reason, /199/);
});

/** Pins that 200 changed lines goes to Opus. */
test("200 changed lines goes to Opus", () => {
  const choice = chooseReviewerModel(200);
  assert.equal(choice.model, "claude-opus-5");
  assert.match(choice.reason, /200/);
});

const LOCKFILES = ["package-lock.json", "frontend/package-lock.json", "uv.lock"];

/** Pins that changed lines sum added and removed. */
test("changed lines sum added and removed", () => {
  assert.equal(changedLines("10\t5\tbackend/a.py\n3\t0\tREADME.md\n", LOCKFILES), 18);
});

/** Pins that lockfile-only change counts as zero. */
test("lockfile-only change counts as zero", () => {
  const numstat = [
    "900\t800\tpackage-lock.json",
    "5000\t10\tfrontend/package-lock.json",
    "300\t200\tuv.lock",
  ].join("\n");
  assert.equal(changedLines(numstat, LOCKFILES), 0);
});

/** Pins that binary files (dashes) count as zero. */
test("binary files (dashes) count as zero", () => {
  assert.equal(changedLines("-\t-\tlogo.png\n4\t1\ta.ts", LOCKFILES), 5);
});

/** Pins that tokens are estimated at four characters each. */
test("tokens are estimated at four characters each", () => {
  assert.equal(estimateTokens("x".repeat(401)), 101);
});

/** Pins that a diff at 15k tokens is shown in full, one over is a stat. */
test("a diff at 15k tokens is shown in full, one over is a stat", () => {
  assert.equal(diffPresentation(15_000), "full");
  assert.equal(diffPresentation(15_001), "stat");
});
