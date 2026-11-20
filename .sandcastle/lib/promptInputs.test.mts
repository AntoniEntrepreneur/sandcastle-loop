// Unit tests for the implementer prompt inputs gathered on the host.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractAvoidTerms,
  extractPrBody,
  extractPrTitle,
  fillProjectPlaceholders,
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

/** Pins that the PR body is extracted from the last tagged block in Claude plain-text stdout. */
test("Claude plain-text stdout yields today's body", () => {
  const stdout = "I will wrap it in <pr-body></pr-body>.\n<pr-body>\n## Summary\n\nx\n</pr-body>\n<promise>COMPLETE</promise>";

  assert.equal(extractPrBody(stdout), "## Summary\n\nx");
});

/** Pins that an agy NDJSON stream unescapes multi-line bodies rather than leaving raw JSON escapes (#805). */
test("an agy NDJSON stream whose final result.response carries a multi-line <pr-body> yields the unescaped body", () => {
  const stream = [
    '{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-medium"}}',
    '{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"thinking..."}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"Here is the body:\\n\\n<pr-body>\\n## Summary\\n\\nFirst line\\nSecond line\\n</pr-body>\\n\\n<promise>COMPLETE</promise>"}}',
  ].join("\n");

  assert.equal(extractPrBody(stream), "## Summary\n\nFirst line\nSecond line");
});

/** Pins that a stream or plain output with no body yields undefined (#805). */
test("a stream with no body yields undefined", () => {
  const stream = [
    '{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-medium"}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"No body tags here.\\n<promise>COMPLETE</promise>"}}',
  ].join("\n");

  assert.equal(extractPrBody(stream), undefined);
  assert.equal(extractPrBody("<promise>COMPLETE</promise>"), undefined);
  assert.equal(extractPrBody("<pr-body>  </pr-body>"), undefined);
});

/** Pins that the PR title comes from the last tagged block, on one line, and an empty one is none. */
test("the PR title is the last <pr-title> block, collapsed onto one line", () => {
  const stdout = "I will use <pr-title></pr-title>.\n<pr-title>\nReturn the cached result\nwhen a save is unchanged\n</pr-title>\n<pr-body>x</pr-body>";

  assert.equal(extractPrTitle(stdout), "Return the cached result when a save is unchanged");
  assert.equal(extractPrTitle("<pr-body>x</pr-body>"), undefined);
  assert.equal(extractPrTitle("<pr-title>  </pr-title>"), undefined);
});

/** Pins that the PR prompt explicitly names the path to the pr skill file (#805). */
test("the PR prompt names the pr skill file's path", () => {
  const prompt = readFileSync(join(import.meta.dirname, "../pr-prompt.md"), "utf-8");
  assert.match(prompt, /\.agents\/skills\/pr\/SKILL\.md/);
});

/** Pins that the PR prompt asks for the title the orchestrator reads. */
test("the PR prompt asks for a <pr-title>", () => {
  const prompt = readFileSync(join(import.meta.dirname, "../pr-prompt.md"), "utf-8");
  assert.match(prompt, /<pr-title>/);
});

/** Pins the rule `agy` relies on: Claude Code's sandbox settings for foreground commands don't reach it. */
for (const name of ["implement-prompt.md", "review-prompt.md"]) {
  test(`${name} keeps tests in the foreground under a time limit`, () => {
    const prompt = readFileSync(join(import.meta.dirname, "..", name), "utf-8");
    assert.match(prompt, /foreground/);
    assert.match(prompt, /`timeout 480/);
  });
}

/** Pins that project notes can carry a run-time placeholder through to the SDK. */
test("project placeholders are filled and run-time ones left for the SDK", () => {
  const prompt = "Run `{{CHECK_COMMAND}}`.\n{{PROJECT_NOTES}}\nFix {{TASK_ID}}.";
  const filled = fillProjectPlaceholders(prompt, {
    CHECK_COMMAND: "make test",
    PROJECT_NOTES: "Avoid: {{AVOID_TERMS}}",
  });

  assert.equal(filled, "Run `make test`.\nAvoid: {{AVOID_TERMS}}\nFix {{TASK_ID}}.");
});
