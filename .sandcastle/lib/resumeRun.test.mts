// Unit tests for the options that resume an agent run's session.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resumeRunOptions } from "./resumeRun.mts";

const FIRST_RUN = {
  name: "implementer#461",
  maxIterations: 1,
  resumeSession: "older-session",
  agent: "agent",
  promptFile: "/tmp/implement-prompt.md",
  promptArgs: { TASK_ID: "461", CHECK_FAILURE: "" },
};

test("a resume sends the prompt inline, with no prompt file or prompt arguments", () => {
  const options = resumeRunOptions(FIRST_RUN, "Fix the red check.", "session-2");
  assert.equal(options.prompt, "Fix the red check.");
  assert.ok(!("promptFile" in options));
  assert.ok(!("promptArgs" in options));
});

test("a resume continues the given session, not the one the first run resumed", () => {
  const options = resumeRunOptions(FIRST_RUN, "Continue.", "session-2");
  assert.equal(options.resumeSession, "session-2");
  assert.equal(options.maxIterations, 1);
});

test("a resume keeps the first run's name and agent", () => {
  const options = resumeRunOptions(FIRST_RUN, "Continue.", "session-2");
  assert.equal(options.name, "implementer#461");
  assert.equal(options.agent, "agent");
});
