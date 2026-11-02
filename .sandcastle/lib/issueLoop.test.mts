// Fake-driven tests for the per-issue loop: no Docker, no quota.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BranchStateError,
  runFatalStop,
  runIssueLoop,
  RunFatalError,
  throwIfRunFatal,
  type IssueLoopPorts,
  type RunResult,
} from "./issueLoop.mts";

const run = (over: Partial<RunResult> = {}): RunResult => ({
  stdout: "",
  commits: [],
  completed: false,
  resumable: true,
  ...over,
});

type ExecResult = { exitCode: number; stdout: string; stderr: string };
const green: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
const red = (stdout: string, exitCode = 1): ExecResult => ({ exitCode, stdout, stderr: "" });

function fakePorts(
  script: RunResult[],
  checks: ExecResult[] = [],
  extra: {
    saved?: string;
    failResume?: boolean | Error;
    trees?: (string | undefined)[];
    emptyDiff?: boolean;
  } = {},
) {
  const treeQueue = [...(extra.trees ?? [])];
  const greenTrees = new Set<string>();
  const prompts: string[] = [];
  const execs: string[] = [];
  const checkQueue = [...checks];
  const sessions: string[] = [];
  const calls: string[] = [];
  const saves: string[] = [];
  const coldPrompts: (string | undefined)[] = [];
  const reviewerPrompts: (string | undefined)[] = [];
  const queue = [...script];
  const next = () => queue.shift() ?? run();
  const ports: IssueLoopPorts = {
    async startRun({ role, model, resumeSessionId, extraPrompt }) {
      if (resumeSessionId) {
        calls.push(`start:${role}:resuming:${resumeSessionId}`);
        if (extra.failResume) {
          throw extra.failResume instanceof Error
            ? extra.failResume
            : new Error("session file not found");
        }
        return next();
      }
      if (role === "implementer") coldPrompts.push(extraPrompt);
      else reviewerPrompts.push(extraPrompt);
      calls.push(role === "reviewer" ? `start:reviewer:${model}` : `start:${role}`);
      return next();
    },
    async resumeSession(prompt) {
      prompts.push(prompt);
      calls.push("resume");
      return next();
    },
    async exec(command) {
      execs.push(command);
      return command === "CHECK" ? (checkQueue.shift() ?? green) : green;
    },
    saveWorktree(reason) {
      saves.push(reason);
      return false;
    },
    writeDone() {
      calls.push("done");
    },
    readSession: () => extra.saved,
    writeSession(id) {
      sessions.push(`write:${id}`);
    },
    clearSession() {
      sessions.push("clear");
    },
    abortSignal: new AbortController().signal,
    cleanTree: () => treeQueue.shift(),
    isGreenTree: (tree) => greenTrees.has(tree),
    recordGreenTree(tree) {
      greenTrees.add(tree);
    },
    reviewerModel: () => ({ model: "reviewer-model", reason: "3 changed lines, under 200" }),
    hasChanges: () => !extra.emptyDiff,
  };
  return { ports, calls, saves, prompts, execs, sessions, coldPrompts, reviewerPrompts, greenTrees };
}

const options = { maxSteps: 5, continuePrompt: "continue", checkCommand: "CHECK" };

/** Pins that completion goes to the reviewer, then the Done marker. */
test("completion goes to the reviewer, then the Done marker", async () => {
  const { ports, calls } = fakePorts([
    run({ commits: [{ sha: "a" }] }),
    run({ commits: [{ sha: "b" }], completed: true }),
    run({ commits: [{ sha: "r" }], completed: true }),
  ]);
  const result = await runIssueLoop(ports, options);
  assert.deepEqual(calls, ["start:implementer", "resume", "start:reviewer:reviewer-model", "done"]);
  assert.deepEqual(result, {
    commits: [{ sha: "a" }, { sha: "b" }, { sha: "r" }],
    completed: true,
  });
});

/** Pins that three steps with no commits trip the dead-run breaker. */
test("three steps with no commits trip the dead-run breaker", async () => {
  const { ports, calls } = fakePorts([run(), run(), run(), run()]);
  const result = await runIssueLoop(ports, options);
  assert.equal(result.completed, false);
  assert.equal(result.reason, "dead-run");
  assert.equal(calls.length, 3);
  assert.ok(!calls.includes("done"));
});

/** Pins that a quota stop rethrows as run-fatal after saving. */
test("a quota stop rethrows as run-fatal after saving", async () => {
  const { ports, saves } = fakePorts([run({ stdout: "Claude AI usage limit reached|1700000000" })]);
  await assert.rejects(runIssueLoop(ports, options), RunFatalError);
  assert.ok(saves.includes("run-died"));
});

/** What the patched SDK throws when the agent exits on a usage limit after its session reached the host. */
const quotaThrow = (sessionId: string) =>
  Object.assign(new Error("claude-code exited with code 1:\nYou've hit your session limit · resets 6:40pm (UTC)"), {
    sessionId,
  });

/** Pins the cold restart after 2026-10-20's usage limit: a run that throws keeps its session. */
test("an implementer run that throws on quota saves its session for the next run", async () => {
  const { ports, sessions } = fakePorts([]);
  ports.startRun = async () => {
    throw quotaThrow("cut-off");
  };
  await assert.rejects(runIssueLoop(ports, options), /session limit/);
  assert.deepEqual(sessions, ["write:cut-off"]);
});

/** Pins that a resumed step that throws on quota saves the session it was continuing. */
test("a resumed implementer step that throws on quota saves its session", async () => {
  const { ports, sessions } = fakePorts([run({ sessionId: "s1", commits: [{ sha: "a" }] })]);
  ports.resumeSession = async () => {
    throw quotaThrow("s1-continued");
  };
  await assert.rejects(runIssueLoop(ports, options), /session limit/);
  assert.deepEqual(sessions, ["write:s1", "write:s1-continued"]);
});

/** Pins that a reviewer that throws with a session id never has it saved as the implementer's. */
test("a reviewer run that throws on quota does not save its session", async () => {
  const { ports, sessions } = fakePorts([run({ sessionId: "s1", completed: true })]);
  const start = ports.startRun.bind(ports);
  ports.startRun = async (request) => {
    if (request.role === "reviewer") throw quotaThrow("reviewer-session");
    return start(request);
  };
  await assert.rejects(runIssueLoop(ports, options), /session limit/);
  assert.ok(!sessions.includes("write:reviewer-session"));
});

/** Pins that the step limit leaves the issue unfinished. */
test("the step limit leaves the issue unfinished", async () => {
  const { ports, calls } = fakePorts(
    Array.from({ length: 5 }, (_, i) => run({ commits: [{ sha: String(i) }] })),
  );
  const result = await runIssueLoop(ports, { ...options, maxSteps: 3 });
  assert.equal(result.completed, false);
  assert.equal(result.reason, "step-limit");
  assert.equal(result.commits.length, 3);
  assert.ok(!calls.includes("done"));
});

/** Pins that a saved session is resumed on the first step. */
test("a saved session is resumed on the first step", async () => {
  const { ports, calls } = fakePorts([run({ completed: true }), run({ completed: true })], [], {
    saved: "old",
  });
  await runIssueLoop(ports, options);
  assert.equal(calls[0], "start:implementer:resuming:old");
});

/** Pins that a failed resume falls back to a cold start with a note. */
test("a failed resume falls back to a cold start with a note", async () => {
  const { ports, calls } = fakePorts([run({ completed: true }), run({ completed: true })], [], {
    saved: "old",
    failResume: true,
  });
  const logs: string[] = [];
  const result = await runIssueLoop(ports, { ...options, log: (m) => logs.push(m) });
  assert.deepEqual(calls.slice(0, 2), ["start:implementer:resuming:old", "start:implementer"]);
  assert.ok(result.completed);
  assert.ok(logs.some((m) => m.includes("old")));
});

/** Pins that the implementer session is saved each step and cleared after Done. */
test("the implementer session is saved each step and cleared after Done", async () => {
  const { ports, calls, sessions } = fakePorts([
    run({ sessionId: "s1", commits: [{ sha: "a" }] }),
    run({ sessionId: "s2", completed: true }),
    run({ sessionId: "reviewer-session", completed: true }),
  ]);
  await runIssueLoop(ports, options);
  assert.deepEqual(sessions, ["write:s1", "write:s2", "clear"]);
  assert.equal(calls.at(-1), "done");
});

/** Pins that a session id from the reviewer is never saved. */
test("a session id from the reviewer is never saved", async () => {
  const { ports, sessions } = fakePorts([
    run({ completed: true }),
    run({ sessionId: "reviewer-session", completed: true }),
  ]);
  await runIssueLoop(ports, options);
  assert.ok(!sessions.includes("write:reviewer-session"));
});

/** Pins that an abort at a step boundary saves, then starts no further step. */
test("an abort at a step boundary saves, then starts no further step", async () => {
  const controller = new AbortController();
  const { ports, calls, saves } = fakePorts([run({ commits: [{ sha: "a" }] })]);
  ports.abortSignal = controller.signal;
  const start = ports.startRun;
  ports.startRun = async (request) => {
    const result = await start(request);
    controller.abort(new RunFatalError("quota", "sibling"));
    return result;
  };
  await assert.rejects(runIssueLoop(ports, options), RunFatalError);
  assert.deepEqual(calls, ["start:implementer"]);
  assert.deepEqual(saves, ["iteration-ended", "run-died"]);
});

/** Pins that an already-aborted signal starts nothing but still saves. */
test("an already-aborted signal starts nothing but still saves", async () => {
  const controller = new AbortController();
  controller.abort(new RunFatalError("auth", "x"));
  const { ports, calls, saves } = fakePorts([]);
  ports.abortSignal = controller.signal;
  await assert.rejects(runIssueLoop(ports, options), RunFatalError);
  assert.deepEqual(calls, []);
  assert.deepEqual(saves, ["run-died"]);
});

/** Pins that the formatter runs, and its changes are committed, before every check. */
test("the formatter runs, and its changes are committed, before every check", async () => {
  const { ports, execs, saves } = fakePorts([run({ completed: true }), run()]);
  await runIssueLoop(ports, { ...options, formatCommand: "FORMAT" });
  assert.deepEqual(execs, ["FORMAT", "CHECK", "FORMAT", "CHECK"]);
  assert.ok(saves.includes("formatted"));
});

/** Pins that a project with no formatter goes straight to the check. */
test("a project with no formatter goes straight to the check", async () => {
  const { ports, execs, saves } = fakePorts([run({ completed: true }), run()]);
  await runIssueLoop(ports, options);
  assert.deepEqual(execs, ["CHECK", "CHECK"]);
  assert.ok(!saves.includes("formatted"));
});

/** Pins that a red check resumes the implementer with the output tail; green then writes Done. */
test("a red check resumes the implementer with the output tail; green then writes Done", async () => {
  const longOutput = "x".repeat(7000) + "END";
  const { ports, calls, prompts } = fakePorts(
    [run({ completed: true }), run({ completed: true }), run()],
    [red(longOutput), green, green],
  );
  const result = await runIssueLoop(ports, options);
  assert.equal(result.completed, true);
  assert.deepEqual(calls, ["start:implementer", "resume", "start:reviewer:reviewer-model", "done"]);
  assert.ok(prompts[0].endsWith("signal completion again."));
  assert.ok(prompts[0].includes("x".repeat(5990) + "END"));
  assert.ok(!prompts[0].includes("x".repeat(6000) + "END"));
});

/** Pins that each check's result is logged with the step it followed, so a log shows whether step 1 failed (#810). */
test("each check's result is logged with the step or reviewer it followed", async () => {
  const { ports } = fakePorts(
    [run({ completed: true }), run({ completed: true }), run()],
    [red("glossary term micro-skill"), green, red("lint broke"), green],
  );
  const logs: string[] = [];
  await runIssueLoop(ports, { ...options, log: (m) => logs.push(m) });
  const checks = logs.filter((m) => m.startsWith("Check after"));
  assert.equal(checks.length, 4);
  assert.match(checks[0]!, /^Check after step 1 failed:\n[\s\S]*glossary term micro-skill/);
  assert.equal(checks[1], "Check after step 2 passed.");
  assert.match(checks[2]!, /^Check after the reviewer failed:\n[\s\S]*lint broke/);
  assert.equal(checks[3], "Check after the reviewer's fix round 1 passed.");
});

/** Pins that three red rounds leave the issue unfinished with no Done marker. */
test("three red rounds leave the issue unfinished with no Done marker", async () => {
  const { ports, calls } = fakePorts(
    Array.from({ length: 6 }, () => run({ completed: true })),
    [red("a"), red("b"), red("c"), red("d")],
  );
  const result = await runIssueLoop(ports, options);
  assert.equal(result.completed, false);
  assert.equal(result.reason, "check-rounds-used-up");
  assert.deepEqual(calls, ["start:implementer", "resume", "resume", "resume"]);
});

/** Pins that a check timeout is red and says so in the tail sent to the agent. */
test("a check timeout is red and says so in the tail sent to the agent", async () => {
  const { ports, prompts } = fakePorts(
    [run({ completed: true }), run({ completed: true }), run()],
    [red("slow", 124)],
  );
  await runIssueLoop(ports, options);
  assert.match(prompts[0], /timed out/);
});

/** Pins that a red check after the reviewer resumes the reviewer. */
test("a red check after the reviewer resumes the reviewer", async () => {
  const { ports, calls, prompts } = fakePorts(
    [run({ completed: true }), run(), run()],
    [green, red("lint broke"), green],
  );
  const result = await runIssueLoop(ports, options);
  assert.equal(result.completed, true);
  assert.deepEqual(calls, ["start:implementer", "start:reviewer:reviewer-model", "resume", "done"]);
  assert.match(prompts[0], /lint broke/);
});

/** Pins that a reviewer restarted cold after a red check is handed the failure, not just the review prompt. */
test("a reviewer restarted after a red check is given the failure", async () => {
  const { ports, calls, reviewerPrompts } = fakePorts(
    [run({ completed: true }), run({ resumable: false }), run()],
    [green, red("lint broke"), green],
  );
  const result = await runIssueLoop(ports, options);
  assert.equal(result.completed, true);
  assert.deepEqual(calls, [
    "start:implementer",
    "start:reviewer:reviewer-model",
    "start:reviewer:reviewer-model",
    "done",
  ]);
  assert.equal(reviewerPrompts[0], undefined);
  assert.match(reviewerPrompts[1]!, /lint broke/);
});

/** Pins that a reviewer who changed nothing is not checked again: the tree already passed. */
test("a reviewer who changed nothing is not checked again", async () => {
  const { ports, calls, execs } = fakePorts([run({ completed: true }), run()], [], {
    trees: ["t1", "t1"],
  });
  const result = await runIssueLoop(ports, options);
  assert.equal(result.completed, true);
  assert.deepEqual(execs, ["CHECK"]);
  assert.deepEqual(calls, ["start:implementer", "start:reviewer:reviewer-model", "done"]);
});

/** Pins that a reviewer who changed the tree is checked again. */
test("a reviewer who changed the tree is checked again", async () => {
  const { ports, execs } = fakePorts([run({ completed: true }), run()], [], {
    trees: ["t1", "t2"],
  });
  await runIssueLoop(ports, options);
  assert.deepEqual(execs, ["CHECK", "CHECK"]);
});

/** Pins that a red check never marks its tree green, so the same tree is checked again. */
test("a red check never marks its tree green", async () => {
  const { ports, execs, greenTrees } = fakePorts(
    [run({ completed: true }), run({ completed: true }), run()],
    [red("broke"), green, green],
    { trees: ["t1", "t1", "t2"] },
  );
  await runIssueLoop(ports, options);
  assert.deepEqual(execs, ["CHECK", "CHECK", "CHECK"]);
  assert.deepEqual([...greenTrees], ["t1", "t2"]);
});

/** Pins that a dirty worktree, which has no tree id, is always checked and never remembered. */
test("a dirty worktree is always checked and never remembered", async () => {
  const { ports, execs, greenTrees } = fakePorts([run({ completed: true }), run()], [], {
    trees: [undefined, undefined],
  });
  await runIssueLoop(ports, options);
  assert.deepEqual(execs, ["CHECK", "CHECK"]);
  assert.equal(greenTrees.size, 0);
});

/** Pins that a reviewer that never turns the check green leaves the issue unfinished. */
test("a reviewer that never turns the check green leaves the issue unfinished", async () => {
  const { ports, calls } = fakePorts(
    [run({ completed: true }), run(), run(), run(), run()],
    [green, red("1"), red("2"), red("3"), red("4")],
  );
  const result = await runIssueLoop(ports, options);
  assert.equal(result.reason, "check-rounds-used-up");
  assert.ok(!calls.includes("done"));
});

/** Pins that the reviewer model comes from the port and its reason is logged. */
test("the reviewer model comes from the port and its reason is logged", async () => {
  const { ports, calls } = fakePorts([run({ completed: true }), run()]);
  const logs: string[] = [];
  await runIssueLoop(ports, { ...options, log: (m) => logs.push(m) });
  assert.ok(calls.includes("start:reviewer:reviewer-model"));
  assert.ok(logs.some((m) => /reviewer-model.*3 changed lines/.test(m)));
});

/** Pins the 55 reviews of "(0 changed lines)" in the runs of 2026-10-28. */
test("a branch with nothing to review skips the reviewer and is marked done", async () => {
  const { ports, calls } = fakePorts([run({ completed: true })], [], { emptyDiff: true });
  const logs: string[] = [];
  const result = await runIssueLoop(ports, { ...options, log: (m) => logs.push(m) });
  assert.deepEqual(calls, ["start:implementer", "done"]);
  assert.equal(result.completed, true);
  assert.ok(logs.some((m) => /no reviewer/i.test(m)));
});

/** Pins the review finding on #497: the pending fix was dropped on a cold start. */
test("a red check's failure tail reaches a cold-started implementer when the session is not resumable", async () => {
  const { ports, calls, coldPrompts } = fakePorts(
    [run({ completed: true, resumable: false }), run({ completed: true }), run({ completed: true })],
    [red("FAILED test_widget"), green],
  );
  await runIssueLoop(ports, options);
  assert.equal(calls[1], "start:implementer");
  assert.ok(coldPrompts[1]?.includes("FAILED test_widget"));
  assert.equal(coldPrompts[0], undefined);
});

/** Pins the resume fallback: an abort must not be logged as a cold start or spawn a second run. */
test("an abort during a saved-session resume rethrows instead of starting cold", async () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const { ports, calls } = fakePorts([run({ completed: true })], [], {
    saved: "old",
    failResume: abort,
  });
  await assert.rejects(runIssueLoop(ports, options), abort);
  assert.deepEqual(calls, ["start:implementer:resuming:old"]);
});

/** Pins that a run going when the end time passes finishes, and no further step starts. */
test("the end time lets the running step finish, then starts no further step", async () => {
  let ended = false;
  const { ports, calls, saves } = fakePorts([run({ commits: [{ sha: "a" }] }), run()]);
  const start = ports.startRun.bind(ports);
  ports.startRun = async (request) => {
    const result = await start(request);
    ended = true;
    return result;
  };
  const result = await runIssueLoop(ports, { ...options, pastEndTime: () => ended });
  assert.deepEqual(calls, ["start:implementer"]);
  assert.deepEqual(result, { commits: [{ sha: "a" }], completed: false, reason: "end-time" });
  assert.ok(saves.includes("iteration-ended"));
});

/** Pins that a finished implementer does not hand over to a reviewer after the end time. */
test("the end time holds the reviewer for the next run", async () => {
  let ended = false;
  const { ports, calls, sessions } = fakePorts([run({ completed: true, sessionId: "s1" })]);
  const start = ports.startRun.bind(ports);
  ports.startRun = async (request) => {
    const result = await start(request);
    ended = true;
    return result;
  };
  const result = await runIssueLoop(ports, { ...options, pastEndTime: () => ended });
  assert.deepEqual(calls, ["start:implementer"]);
  assert.equal(result.reason, "end-time");
  // The session survives, so the next run resumes it instead of starting cold.
  assert.ok(!sessions.includes("clear"));
});

/** Pins that a past end time at the start of the loop starts nothing. */
test("a past end time starts no agent at all", async () => {
  const { ports, calls } = fakePorts([run()]);
  const result = await runIssueLoop(ports, { ...options, pastEndTime: () => true });
  assert.deepEqual(calls, []);
  assert.equal(result.reason, "end-time");
});

// The line #570's reportError test prints on every frontend run. Read as agent
// output it matches a network pattern; inside a red check's tail it is just a test.
const TEST_OUTPUT_NAMING_A_NETWORK_ERROR = "Error doing thing: Network Error";

test("a red check's output is never read as a run-fatal failure", () => {
  const error = new BranchStateError(
    `sandcastle/batch-1 fails make test / make lint.\n\n${TEST_OUTPUT_NAMING_A_NETWORK_ERROR}`,
  );

  assert.equal(runFatalStop(error), undefined);
});

test("an SDK error naming an unreachable API is a run-fatal network stop", () => {
  const stop = runFatalStop(new Error("connect ECONNREFUSED 10.0.0.1:443"));

  assert.ok(stop instanceof RunFatalError);
  assert.equal(stop.kind, "network");
});

test("a RunFatalError is returned as-is, keeping what it read from the full output", () => {
  const original = new RunFatalError("quota", "x", { resetAt: new Date(0) });

  assert.equal(runFatalStop(original), original);
});

/** Pins that an AGY_ERROR naming a spent quota or credits balance halts the run with the Gemini message. */
test("an AGY_ERROR quota or credits line is a Gemini quota stop", () => {
  for (const text of [
    "AGY_ERROR: Your AI credits balance is too low to continue.",
    "AGY_ERROR: insufficient credits for this request",
    "AGY_ERROR: you are out of credits",
    "Implementing #244…\nAGY_ERROR: Your AI credits balance is too low to continue.\n",
  ]) {
    assert.throws(
      () => throwIfRunFatal(text),
      (error: unknown) =>
        error instanceof RunFatalError &&
        error.kind === "quota" &&
        error.provider === "gemini" &&
        error.message.includes("Gemini quota spent — re-run when it resets"),
    );
  }
});

/** Pins that any other AGY_ERROR is the group's own dead run, not run-fatal. */
test("a non-quota AGY_ERROR is not a run-fatal stop", () => {
  assert.doesNotThrow(() => throwIfRunFatal("AGY_ERROR: the model returned an invalid response"));
});

/** Pins that output quoting an AGY_ERROR, rather than carrying one, never stops the run (#729). */
test("an AGY_ERROR quoted mid-line by an agent is not a quota stop", () => {
  assert.doesNotThrow(() =>
    throwIfRunFatal('+ const LINE = "AGY_ERROR: Your AI credits balance is too low to continue.";'),
  );
});

/** Pins that a file `agy` merely read, echoed in its tool output, is not a quota stop (#728). */
test("quota phrases in agy's tool output are not a quota stop", () => {
  const stream = [
    '{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-high"}}',
    '{"event":"step_update","step_update":{"step_type":"tool","tool_info":{"output":"/usage limit reached/i,\\n/session limit/i,"}}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"Done.\\n<promise>COMPLETE</promise>"}}',
  ].join("\n");
  assert.doesNotThrow(() => throwIfRunFatal(stream));
});

/** Pins that a quota phrase in agy's own final response or error still stops the run. */
test("a quota phrase in agy's final result still stops the run", () => {
  const stream =
    '{"event":"result","result":{"status":"ERROR","response":"","error":"You\'ve hit your session limit"}}';
  assert.throws(() => throwIfRunFatal(stream), RunFatalError);
});
