// Unit tests for what an export copies and what its PR says.

import { test } from "node:test";
import assert from "node:assert/strict";

import { exportPrBody, packOwnedFiles } from "./exportPlan.mts";

/** Pins that the project's own files and other packages' patches stay out of the pack. */
test("pack-owned files are the loop and the engine patch, never the project's own", () => {
  const tracked = [
    ".sandcastle/main.mts",
    ".sandcastle/lib/groups.mts",
    ".sandcastle/sandcastle.config.mts",
    ".sandcastle/Dockerfile",
    ".sandcastle/project-notes.md",
    ".sandcastle/CODING_STANDARDS.md",
    "patches/@ai-hero+sandcastle+0.12.0.patch",
    "patches/other+1.0.0.patch",
    "backend/main.py",
  ];

  assert.deepEqual(packOwnedFiles(tracked), [
    ".sandcastle/lib/groups.mts",
    ".sandcastle/main.mts",
    "patches/@ai-hero+sandcastle+0.12.0.patch",
  ]);
});

/** Pins that a first export, with no previous commit, says so. */
test("a first export says so", () => {
  const body = exportPrBody({ sourceRepo: "o/r", sourceCommit: "abcdef1234", commits: [] });

  assert.match(body, /^First export, from o\/r@abcdef12\./);
});

/** Pins that issue refs point back at the source repo, not the pack's own issues. */
test("a later export lists the source commits it carries", () => {
  const body = exportPrBody({
    sourceRepo: "o/r",
    sourceCommit: "abcdef1234",
    previousCommit: "1234567890",
    commits: [{ sha: "c0ffee1", subject: "Sandcastle: keep a session (#706)" }],
  });

  assert.match(body, /since 12345678\./);
  assert.match(body, /- Sandcastle: keep a session \(o\/r#706\) \(o\/r@c0ffee1\)/);
});
