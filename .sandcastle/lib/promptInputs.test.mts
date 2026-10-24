// Unit tests for the implementer prompt inputs gathered on the host.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractAvoidTerms,
  extractPrBody,
  parentIssueNumber,
  renderIssueContext,
} from "./promptInputs.mts";

const CONTEXT_FIXTURE = `# Title

**Curriculum**:
The full set of Chapters.
_Avoid_: content, curriculum data

**Level**:
A difficulty step.

**Chapter**:
A broad area.
_Avoid_: Track, domain, content
`;

/** Pins that extractAvoidTerms collects every _Avoid_ term, de-duplicated, in order. */
test("extractAvoidTerms collects every _Avoid_ term, de-duplicated, in order", () => {
  assert.deepEqual(extractAvoidTerms(CONTEXT_FIXTURE), [
    "content",
    "curriculum data",
    "Track",
    "domain",
  ]);
});

/** Pins that extractAvoidTerms returns nothing when there are no _Avoid_ lines. */
test("extractAvoidTerms returns nothing when there are no _Avoid_ lines", () => {
  assert.deepEqual(extractAvoidTerms("**Level**:\nA step.\n"), []);
});

/** Pins that parentIssueNumber reads the number under a Parent heading. */
test("parentIssueNumber reads the number under a Parent heading", () => {
  assert.equal(parentIssueNumber("## Parent\n\n#496\n\n## What to build\n\nx #12"), 496);
});

/** Pins that parentIssueNumber is undefined without a Parent heading. */
test("parentIssueNumber is undefined without a Parent heading", () => {
  assert.equal(parentIssueNumber("## What to build\n\nsee #12"), undefined);
});

/** Pins that renderIssueContext includes body, comments and parent spec. */
test("renderIssueContext includes body, comments and parent spec", () => {
  const text = renderIssueContext({
    issue: { number: 500, title: "T", body: "BODY", comments: ["first note", "second note"] },
    parent: { number: 496, title: "PT", body: "SPEC" },
  });
  for (const part of ["#500", "T", "BODY", "first note", "second note", "#496", "PT", "SPEC"]) {
    assert.ok(text.includes(part), part);
  }
});

/** Pins that renderIssueContext omits the parent section when there is none. */
test("renderIssueContext omits the parent section when there is none", () => {
  const text = renderIssueContext({
    issue: { number: 5, title: "T", body: "B", comments: [] },
  });
  assert.ok(!text.includes("Parent spec"));
});

test("the PR body is the last tagged block the writer output", () => {
  const stdout = "I will wrap it in <pr-body></pr-body>.\n<pr-body>\n## Summary\n\nx\n</pr-body>\n<promise>COMPLETE</promise>";

  assert.equal(extractPrBody(stdout), "## Summary\n\nx");
});

test("a writer that output no body yields none", () => {
  assert.equal(extractPrBody("<promise>COMPLETE</promise>"), undefined);
  assert.equal(extractPrBody("<pr-body>  </pr-body>"), undefined);
});
