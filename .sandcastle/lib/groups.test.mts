// Unit tests for the Sandcastle grouping and failure logic.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  batchBranchGlob,
  batchBranchName,
  buildPrBody,
  buildPrTitle,
  checkFailureTail,
  classifyFailure,
  mergerFailureVerdict,
  withTimeLimit,
  describeGroup,
  groupIdOf,
  isDeadRun,
  isGroupComplete,
  isRunFatal,
  isSettledWithNothingToDo,
  issueNumberOfBranch,
  liveBlockers,
  parentIssueOf,
  parseBlockedByLine,
  parseDoneTrailers,
  partitionIntoGroups,
  type Issue,
} from "./groups.mts";

const issue = (number: number, labels: string[]): Issue => ({
  number,
  title: `Issue ${number}`,
  labels,
});

test("a sandcastle:<id> label admits an issue under that group id", () => {
  assert.equal(groupIdOf(issue(245, ["ready-for-agent", "sandcastle:218"])), "218");
});

test("a bare sandcastle label admits an issue as its own solo group", () => {
  assert.equal(groupIdOf(issue(999, ["sandcastle"])), "solo-999");
});

test("an issue carrying neither label is not admitted", () => {
  assert.equal(groupIdOf(issue(300, ["ready-for-agent"])), undefined);
});

test("a group label wins over a bare sandcastle label on the same issue", () => {
  assert.equal(groupIdOf(issue(245, ["sandcastle", "sandcastle:218"])), "218");
});

// --- naming a group in a message -------------------------------------------

test("a group is named by the label that admitted it", () => {
  assert.equal(describeGroup("218"), "sandcastle:218");
  assert.equal(describeGroup("telemetry"), "sandcastle:telemetry");
});

test("a solo group is named by its issue, since its label carries no id", () => {
  assert.equal(describeGroup("solo-365"), "#365");
});

test("an empty group suffix does not admit the issue", () => {
  assert.equal(groupIdOf(issue(245, ["sandcastle:"])), undefined);
});

test("a numeric group id names the parent spec issue, a named one does not", () => {
  assert.equal(parentIssueOf("218"), 218);
  assert.equal(parentIssueOf("telemetry"), undefined);
});

test("issues partition into groups, each holding only its own issues", () => {
  const groups = partitionIntoGroups([
    issue(245, ["sandcastle:218"]),
    issue(255, ["sandcastle:244"]),
    issue(246, ["sandcastle:218"]),
    issue(400, ["ready-for-agent"]),
  ]);

  assert.deepEqual(
    groups.map((g) => [g.id, g.issues.map((i) => i.number)]),
    [
      ["218", [245, 246]],
      ["244", [255]],
    ],
  );
});

test("groups and solo issues interleave in issue order", () => {
  const groups = partitionIntoGroups([
    issue(300, ["sandcastle"]),
    issue(150, ["sandcastle:telemetry"]),
    issue(260, ["sandcastle:244"]),
    issue(120, ["sandcastle:99"]),
    issue(100, ["sandcastle"]),
  ]);

  assert.deepEqual(groups.map((g) => g.id), [
    "99",
    "solo-100",
    "telemetry",
    "244",
    "solo-300",
  ]);
});

test("a numeric group queues at its parent spec, not at its earliest member", () => {
  const groups = partitionIntoGroups([
    issue(50, ["sandcastle:244"]),
    issue(100, ["sandcastle"]),
  ]);

  assert.deepEqual(groups.map((g) => g.id), ["solo-100", "244"]);
});

test("a named group queues at its earliest member", () => {
  const groups = partitionIntoGroups([
    issue(310, ["sandcastle:telemetry"]),
    issue(305, ["sandcastle:telemetry"]),
    issue(307, ["sandcastle"]),
  ]);

  assert.deepEqual(groups.map((g) => g.id), ["telemetry", "solo-307"]);
});

test("two-digit numeric groups sort before three-digit ones, not after", () => {
  // The bug a plain string sort would introduce: "218" < "99".
  const groups = partitionIntoGroups([
    issue(1, ["sandcastle:218"]),
    issue(2, ["sandcastle:99"]),
  ]);

  assert.deepEqual(groups.map((g) => g.id), ["99", "218"]);
});

test("solo groups sort by issue number rather than by string", () => {
  const groups = partitionIntoGroups([
    issue(218, ["sandcastle"]),
    issue(99, ["sandcastle"]),
  ]);

  assert.deepEqual(groups.map((g) => g.id), ["solo-99", "solo-218"]);
});

test("a group's branch glob matches its own batch branches and no other group's", () => {
  const branch = batchBranchName("218", 1_700_000_000_000);

  assert.equal(branch, "sandcastle/batch-218-1700000000000");
  assert.equal(batchBranchGlob("218"), "sandcastle/batch-218-*");
  assert.ok(!branch.startsWith("sandcastle/batch-244-"));
});

test("an issue branch name round-trips to its issue number", () => {
  assert.equal(issueNumberOfBranch("sandcastle/issue-245"), 245);
});

test("a batch branch is not mistaken for an issue branch", () => {
  assert.equal(issueNumberOfBranch("sandcastle/batch-218-1700000000000"), undefined);
});

test("a usage-limit message is classified as fatal to the whole run", () => {
  assert.equal(classifyFailure("Claude AI usage limit reached|1700000000"), "quota");
  assert.ok(isRunFatal("quota"));
});

// --- Done marker trailers ----------------------------------------------------

test("a commit message with both trailers parses as a Done marker", () => {
  const message = [
    "Sandcastle: #410 done",
    "",
    "Sandcastle-Done: #410",
    "Sandcastle-Batch: sandcastle/batch-218-1700000000000",
  ].join("\n");
  assert.deepEqual(parseDoneTrailers(message), {
    issue: 410,
    batch: "sandcastle/batch-218-1700000000000",
  });
});

test("a commit message with only one of the two trailers is not a Done marker", () => {
  assert.equal(parseDoneTrailers("Sandcastle-Done: #410"), undefined);
  assert.equal(
    parseDoneTrailers("Sandcastle-Batch: sandcastle/batch-218-1700000000000"),
    undefined,
  );
});

test("an ordinary commit message is not a Done marker", () => {
  assert.equal(parseDoneTrailers("RALPH: implement feature"), undefined);
});

test("the session-limit message is classified as quota exhaustion, fatal to the whole run", () => {
  assert.equal(
    classifyFailure("You've hit your session limit · resets 2:40pm (UTC)"),
    "quota",
  );
  assert.ok(isRunFatal("quota"));
});

test("an expired login is classified as fatal to the whole run", () => {
  assert.equal(classifyFailure("OAuth token has expired. Please run /login"), "auth");
  assert.ok(isRunFatal("auth"));
});

test("an ordinary test failure is local to its group and does not stop the run", () => {
  assert.equal(classifyFailure("FAILED tests/test_grader.py::test_flawless"), "local");
  assert.ok(!isRunFatal("local"));
});

test("three consecutive commit-less unfinished iterations mark a run dead", () => {
  const dead = { commits: 0, completed: false };

  assert.ok(isDeadRun([dead, dead, dead]));
});

test("two dead iterations are not yet enough to trip the breaker", () => {
  const dead = { commits: 0, completed: false };

  assert.ok(!isDeadRun([dead, dead]));
});

test("a commit inside the window keeps the run alive", () => {
  const dead = { commits: 0, completed: false };

  assert.ok(!isDeadRun([dead, { commits: 1, completed: false }, dead]));
});

test("an iteration that signalled completion keeps the run alive", () => {
  const dead = { commits: 0, completed: false };

  assert.ok(!isDeadRun([dead, dead, { commits: 0, completed: true }]));
});

test("only the last N iterations count, so early exploration is forgiven", () => {
  const dead = { commits: 0, completed: false };
  const alive = { commits: 2, completed: true };

  assert.ok(!isDeadRun([dead, dead, dead, alive]));
});

test("a group is complete only when nothing is planned, blocked or stranded", () => {
  const settled = false;
  assert.ok(
    isGroupComplete({ plannedIssues: 0, blockedIssues: 0, settledWithNothingToDo: settled, strandedBranches: 0 }),
  );
  assert.ok(
    !isGroupComplete({ plannedIssues: 1, blockedIssues: 0, settledWithNothingToDo: settled, strandedBranches: 0 }),
  );
  assert.ok(
    !isGroupComplete({ plannedIssues: 0, blockedIssues: 0, settledWithNothingToDo: settled, strandedBranches: 1 }),
  );
});

test("a group whose last planned issues settled with nothing to do is complete", () => {
  // #248 of sandcastle:218: its deliverable was an issue comment, so it
  // signalled completion with no commits, and the PR stayed a draft.
  assert.ok(
    isGroupComplete({ plannedIssues: 1, blockedIssues: 0, settledWithNothingToDo: true, strandedBranches: 0 }),
  );
  assert.ok(
    !isGroupComplete({ plannedIssues: 1, blockedIssues: 0, settledWithNothingToDo: true, strandedBranches: 1 }),
  );
});

test("a group with an open but permanently blocked issue is never complete", () => {
  assert.ok(
    !isGroupComplete({ plannedIssues: 0, blockedIssues: 1, settledWithNothingToDo: false, strandedBranches: 0 }),
  );
  assert.ok(
    !isGroupComplete({ plannedIssues: 0, blockedIssues: 1, settledWithNothingToDo: true, strandedBranches: 0 }),
  );
});

test("an incomplete group's PR references the parent spec without closing it", () => {
  const body = buildPrBody({
    group: { id: "218", parentIssue: 218, issues: [] },
    mergedIssues: [{ id: "245", title: "Emit expression structure" }],
    blockedIssues: [],
    complete: false,
  });

  assert.ok(body.includes("Closes #245: Emit expression structure"));
  assert.ok(body.includes("Part of #218"));
  assert.ok(!body.includes("Closes #218"));
  assert.ok(body.includes("Draft"));
});

test("a complete group's PR closes the parent spec", () => {
  const body = buildPrBody({
    group: { id: "218", parentIssue: 218, issues: [] },
    mergedIssues: [{ id: "245", title: "Emit expression structure" }],
    blockedIssues: [],
    complete: true,
  });

  assert.ok(body.includes("Closes #218"));
  assert.ok(!body.includes("Part of #218"));
  assert.ok(!body.includes("Draft"));
});

test("a named group closes its children but has no parent spec to close", () => {
  const body = buildPrBody({
    group: { id: "telemetry", parentIssue: undefined, issues: [] },
    mergedIssues: [{ id: "300", title: "Something" }],
    blockedIssues: [],
    complete: true,
  });

  assert.ok(body.includes("Closes #300: Something"));
  assert.ok(!body.includes("Closes #undefined"));
  assert.ok(!/Part of #/.test(body));
});

test("a written-up PR keeps the marker first and the Closes lines below the writeup", () => {
  const body = buildPrBody({
    group: { id: "solo-365", parentIssue: undefined, issues: [] },
    mergedIssues: [{ id: "365", title: "Rounding 2,96 is graded wrong" }],
    blockedIssues: [],
    complete: true,
    writeup: "## Summary\n\nRounding now keeps the comma.",
  });

  assert.ok(body.startsWith("Automated work on #365, completed by Sandcastle."));
  assert.ok(body.indexOf("## Summary") < body.indexOf("Closes #365"));
});

test("a solo group's PR opens by naming its issue, not a label that cannot exist", () => {
  const body = buildPrBody({
    group: { id: "solo-365", parentIssue: undefined, issues: [] },
    mergedIssues: [{ id: "365", title: "Rounding 2,96 is graded wrong" }],
    blockedIssues: [],
    complete: true,
  });

  assert.ok(body.startsWith("Automated work on #365, completed by Sandcastle."));
  assert.ok(!body.includes("sandcastle:solo-365"));
  assert.ok(body.includes("Closes #365: Rounding 2,96 is graded wrong"));
});

test("a grouped batch's PR still opens by naming its group label", () => {
  const body = buildPrBody({
    group: { id: "268", parentIssue: 268, issues: [] },
    mergedIssues: [{ id: "290", title: "The revealed answer carries its Unit" }],
    blockedIssues: [],
    complete: false,
  });

  assert.ok(
    body.startsWith("Automated batch for `sandcastle:268`, completed by Sandcastle."),
  );
});

test("a resumed branch with no newly merged issues still explains itself", () => {
  const body = buildPrBody({
    group: { id: "218", parentIssue: 218, issues: [] },
    mergedIssues: [],
    blockedIssues: [],
    complete: false,
  });

  assert.ok(body.includes("Carried forward from an earlier interrupted run"));
});

test("a group with a blocked issue lists it and why, even though the batch is complete otherwise", () => {
  const body = buildPrBody({
    group: { id: "218", parentIssue: 218, issues: [] },
    mergedIssues: [{ id: "245", title: "Emit expression structure" }],
    blockedIssues: [{ id: "242", title: "Render the expression", blockedBy: [239] }],
    complete: false,
  });

  assert.ok(body.includes("Excluded this batch — blocked:"));
  assert.ok(body.includes("#242: Render the expression (blocked by #239)"));
});

test("the PR title names the spec a group serves", () => {
  assert.equal(
    buildPrTitle({ id: "218", parentIssue: 218, issues: [] }, 3),
    "Sandcastle: #218 — 3 issue(s)",
  );
});

test("a solo group's PR title names the issue itself", () => {
  assert.equal(
    buildPrTitle({ id: "solo-999", parentIssue: undefined, issues: [] }, 1),
    "Sandcastle: #999 — 1 issue(s)",
  );
});

// --- a cycle that had nothing to do ---------------------------------------

test("a group whose every issue reports completion without commits is finished", () => {
  assert.equal(
    isSettledWithNothingToDo([
      { failed: false, commits: 0, completed: true },
      { failed: false, commits: 0, completed: true },
    ]),
    true,
  );
});

test("a cycle that produced commits is not a cycle with nothing to do", () => {
  assert.equal(
    isSettledWithNothingToDo([{ failed: false, commits: 2, completed: true }]),
    false,
  );
});

test("an issue that never signalled completion leaves the group retryable", () => {
  assert.equal(
    isSettledWithNothingToDo([{ failed: false, commits: 0, completed: false }]),
    false,
  );
});

test("a failed issue leaves the group retryable", () => {
  assert.equal(
    isSettledWithNothingToDo([{ failed: true, commits: 0, completed: false }]),
    false,
  );
});

test("one unfinished issue is enough to keep a group going", () => {
  assert.equal(
    isSettledWithNothingToDo([
      { failed: false, commits: 0, completed: true },
      { failed: false, commits: 0, completed: false },
    ]),
    false,
  );
});

test("an empty cycle proves nothing, since planning handles that case", () => {
  assert.equal(isSettledWithNothingToDo([]), false);
});

// --- network failures ------------------------------------------------------

test("the API being unreachable is a network failure, not a local one", () => {
  assert.equal(
    classifyFailure(
      "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    ),
    "network",
  );
});

test("DNS and connection errors are recognised by their codes", () => {
  assert.equal(classifyFailure("Error: getaddrinfo EAI_AGAIN api.anthropic.com"), "network");
  assert.equal(classifyFailure("connect ECONNREFUSED 127.0.0.1:443"), "network");
});

test("a network failure ends the whole run, since the next container fares no better", () => {
  assert.equal(isRunFatal("network"), true);
});

test("a spent quota still outranks a network error in the same output", () => {
  assert.equal(
    classifyFailure("usage limit reached; also ENOTFOUND while retrying"),
    "quota",
  );
});

test("an ordinary test failure is still local", () => {
  assert.equal(classifyFailure("FAILED tests/test_session.py::test_streak"), "local");
  assert.equal(isRunFatal("local"), false);
});

// --- blocked-by fallback line ------------------------------------------------

test("a Blocked by line names one blocker", () => {
  assert.deepEqual(parseBlockedByLine("Blocked by: #239\n\nRest of the body."), [239]);
});

test("a Blocked by line names several blockers", () => {
  assert.deepEqual(parseBlockedByLine("Blocked by: #239, #240\n\nRest."), [239, 240]);
});

test("a body with no Blocked by line has no blockers", () => {
  assert.deepEqual(parseBlockedByLine("Just an ordinary issue body."), []);
});

test("an undefined body has no blockers", () => {
  assert.deepEqual(parseBlockedByLine(undefined), []);
});

test("the Blocked by line is matched anywhere in the body, case-insensitively", () => {
  assert.deepEqual(
    parseBlockedByLine("Some context first.\n\nblocked BY: #12\n\nMore text."),
    [12],
  );
});

test("a blocker whose work is merged into the batch no longer blocks", () => {
  assert.deepEqual(liveBlockers([351], [351]), []);
});

test("a blocker outside the batch keeps blocking even as siblings merge", () => {
  assert.deepEqual(liveBlockers([293, 323], [323]), [293]);
});

test("nothing merged yet leaves every blocker live", () => {
  assert.deepEqual(liveBlockers([272, 273], []), [272, 273]);
});

/** Pins that withTimeLimit wraps the whole command, && chains included, in timeout 1800. */
test("withTimeLimit wraps the whole command, && chains included, in timeout 1800", () => {
  assert.equal(withTimeLimit("a && b"), "timeout 1800 sh -c 'a && b'");
});

/** Pins that withTimeLimit escapes single quotes in the command. */
test("withTimeLimit escapes single quotes in the command", () => {
  assert.equal(withTimeLimit("echo 'hi'"), `timeout 1800 sh -c 'echo '\\''hi'\\'''`);
});

/** Pins that checkFailureTail is undefined for a green check. */
test("checkFailureTail is undefined for a green check", () => {
  assert.equal(checkFailureTail(0, "ok", "", 100), undefined);
});

/** Pins that checkFailureTail returns the end of the output for a red check. */
test("checkFailureTail returns the end of the output for a red check", () => {
  assert.equal(checkFailureTail(1, "abcdef", "ghi", 5), "f\nghi".slice(-5));
});

/** Pins that checkFailureTail counts a timeout (exit 124) as red and says it timed out. */
test("checkFailureTail counts a timeout (exit 124) as red and says it timed out", () => {
  const tail = checkFailureTail(124, "x".repeat(500), "", 100);
  assert.ok(tail !== undefined);
  assert.match(tail, /timed out after 30 minutes/);
});

/** Pins that mergerFailureVerdict rethrows quota and auth failures. */
test("mergerFailureVerdict rethrows quota and auth failures", () => {
  assert.equal(mergerFailureVerdict("You've hit your session limit"), "rethrow");
  assert.equal(mergerFailureVerdict("Invalid API key"), "rethrow");
});

/** Pins that mergerFailureVerdict judges an idle timeout by what the merger left. */
test("mergerFailureVerdict judges an idle timeout by what the merger left", () => {
  assert.equal(mergerFailureVerdict("Idle timeout: no output for 600s"), "judge-branch");
});
