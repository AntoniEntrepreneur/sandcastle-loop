import assert from "node:assert/strict";
import { test } from "node:test";

import { ciCheckPassed, ciVerdictApplies } from "./ciGreen.mts";

const runs = (...items: object[]) => JSON.stringify({ check_runs: items });

test("a completed successful check run passes", () => {
  assert.equal(ciCheckPassed(runs({ name: "check", status: "completed", conclusion: "success" })), true);
});

test("one green run is enough when a commit carries two check runs", () => {
  assert.equal(
    ciCheckPassed(
      runs(
        { name: "check", status: "completed", conclusion: "failure" },
        { name: "check", status: "completed", conclusion: "success" },
      ),
    ),
    true,
  );
});

test("pending, failed, cancelled and other-named runs do not pass", () => {
  assert.equal(ciCheckPassed(runs({ name: "check", status: "in_progress", conclusion: null })), false);
  assert.equal(ciCheckPassed(runs({ name: "check", status: "completed", conclusion: "failure" })), false);
  assert.equal(ciCheckPassed(runs({ name: "check", status: "completed", conclusion: "cancelled" })), false);
  assert.equal(ciCheckPassed(runs({ name: "deploy", status: "completed", conclusion: "success" })), false);
  assert.equal(ciCheckPassed(runs()), false);
});

test("unparseable or oddly shaped output does not pass", () => {
  assert.equal(ciCheckPassed(""), false);
  assert.equal(ciCheckPassed("not json"), false);
  assert.equal(ciCheckPassed("null"), false);
  assert.equal(ciCheckPassed("{}"), false);
});

test("the verdict applies only to an identical tree", () => {
  assert.equal(ciVerdictApplies("abc", "abc"), true);
  assert.equal(ciVerdictApplies("abc", "def"), false);
  assert.equal(ciVerdictApplies(undefined, undefined), false);
  assert.equal(ciVerdictApplies("abc", undefined), false);
});
