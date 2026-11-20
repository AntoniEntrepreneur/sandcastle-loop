// Fake-driven tests for the group queue: no Docker, no git, no quota. The
// tests settle each issue's work and each merge in a chosen order and assert
// only on what the queue starts, merges, returns or throws.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BranchStateError, RunFatalError } from "./issueLoop.mts";
import { runGroupQueue, type GroupQueuePorts, type QueueIssue } from "./groupQueue.mts";

/** A queue issue with a predictable title and branch. */
const issue = (id: string): QueueIssue => ({ id, title: `Issue ${id}`, branch: `sandcastle/issue-${id}` });

/** A promise with its settle functions exposed, so a test decides when work or a merge ends. */
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
/** Create a pending promise the test settles later. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every promise that can progress do so. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What a worked issue reports: its commits and whether it signalled completion. */
type Work = { commits: { sha: string }[]; completed: boolean };

/**
 * A group whose issues block each other as `blockedBy` says. Work and merges
 * stay pending until the test settles them; an issue that finishes completed
 * with commits carries a Done marker until it is merged.
 */
function harness(options: {
  blockedBy?: Record<string, string[]>;
  ids: string[];
  /** A plan that keeps listing merged issues, as when Done markers go unseen. */
  stubbornPlan?: boolean;
  assertGreen?: () => Promise<void>;
  /** Whether GitHub answers again after an outage; it does unless a test says not. */
  gitHubReturns?: boolean;
}) {
  const blockedBy = options.blockedBy ?? {};
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const works = new Map<string, Deferred<Work>>();
  const merges: { batch: string[]; done: Deferred<void> }[] = [];
  const marked = new Set<string>();
  const logs: string[] = [];
  let endTime = false;
  let greenAsserts = 0;

  const ports: GroupQueuePorts = {
    /** Plan from the blockers' merged state; a stubborn plan keeps listing merged issues. */
    async plan(mergedThisRun) {
      const merged = new Set(mergedThisRun);
      const unblocked = (id: string) => (blockedBy[id] ?? []).every((blocker) => merged.has(blocker));
      const remaining = options.ids.filter((id) => options.stubbornPlan || !merged.has(id));
      return {
        planned: remaining.filter(unblocked).map(issue),
        blocked: remaining
          .filter((id) => !unblocked(id))
          .map((id) => ({ ...issue(id), blockedBy: (blockedBy[id] ?? []).map(Number) })),
      };
    },
    /** Count the assertion, then run the test's own behaviour. */
    async assertGreen() {
      greenAsserts++;
      await options.assertGreen?.();
    },
    /** Record the start and hold the work pending until the test settles it. */
    workIssue(queued, signal) {
      started.push(queued.id);
      signals.set(queued.id, signal);
      const work = deferred<Work>();
      works.set(queued.id, work);
      return work.promise;
    },
    /** Record the batch and hold the merge pending; a finished merge clears the Done markers. */
    async merge(batch) {
      const done = deferred<void>();
      merges.push({ batch: batch.map((i) => i.id), done });
      await done.promise;
      for (const merged of batch) marked.delete(merged.id);
    },
    /** Issues whose Done marker is written and not yet merged. */
    readyToMerge: () => [...marked],
    /** The end time the test has set. */
    pastEndTime: () => endTime,
    /** A shared-failure stop without the quota probe. */
    sharedFailureStop: (message) => new RunFatalError("shared", message),
    /** GitHub answers again at once, unless the test said it never does. */
    waitForGitHub: async () => options.gitHubReturns ?? true,
    /** Collect the log lines. */
    log: (message) => logs.push(message),
  };

  return {
    started,
    signals,
    merges,
    logs,
    greenAsserts: () => greenAsserts,
    /** Move the clock past the end time. */
    passEndTime: () => {
      endTime = true;
    },
    /** Start the queue. */
    run: () => runGroupQueue(ports, { integrationBranch: "sandcastle/batch-859-1" }),
    /** The issue finishes its work; by default its Done marker is written. */
    finish(id: string, work: Partial<Work> & { marker?: boolean } = {}) {
      const { marker = true, ...rest } = work;
      if (marker) marked.add(id);
      works.get(id)!.resolve({ commits: [{ sha: `sha-${id}` }], completed: true, ...rest });
    },
    /** The issue's work rejects with `error`. */
    fail(id: string, error: unknown) {
      works.get(id)!.reject(error);
    },
  };
}

/** Track whether a promise has settled, without awaiting it. */
function watch<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/** A merge starts what it unblocked without waiting for unrelated running issues. */
test("an issue the merge unblocks starts before a slower sibling finishes", async () => {
  const h = harness({ ids: ["838", "839", "840"], blockedBy: { "839": ["838"] } });
  const queue = h.run();
  await flush();
  assert.deepEqual(h.started, ["838", "840"]);

  h.finish("838");
  await flush();
  assert.deepEqual(h.merges.map((m) => m.batch), [["838"]]);
  assert.deepEqual(h.started, ["838", "840"], "839 waits for its blocker's merge");

  h.merges[0]!.done.resolve();
  await flush();
  assert.deepEqual(h.started, ["838", "840", "839"], "839 starts while 840 still runs");

  h.finish("839");
  h.finish("840");
  await flush();
  h.merges[1]!.done.resolve();
  await queue;
});

/** A finished issue with a Done marker is merged immediately. */
test("a lone finished issue merges at once", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  h.finish("1");
  await flush();
  assert.deepEqual(h.merges.map((m) => m.batch), [["1"]]);
  h.merges[0]!.done.resolve();
  await queue;
});

/** Merges are serialised and issues finishing meanwhile share the next batch. */
test("issues finishing during a merge merge together in the next one", async () => {
  const h = harness({ ids: ["1", "2", "3"] });
  const queue = h.run();
  await flush();

  h.finish("1");
  await flush();
  h.finish("2");
  h.finish("3");
  await flush();
  assert.equal(h.merges.length, 1, "merges are serialised");

  h.merges[0]!.done.resolve();
  await flush();
  assert.deepEqual(h.merges.map((m) => m.batch), [["1"], ["2", "3"]]);
  h.merges[1]!.done.resolve();
  await queue;
});

/** Only the first start asserts green; merges keep the branch green themselves. */
test("the integration branch is asserted green once, before any issue starts", async () => {
  const h = harness({ ids: ["1", "2", "3"], blockedBy: { "3": ["1"] } });
  const queue = h.run();
  await flush();
  assert.equal(h.greenAsserts(), 1);
  assert.deepEqual(h.started, ["1", "2"]);
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  await flush();
  assert.deepEqual(h.started, ["1", "2", "3"]);
  assert.equal(h.greenAsserts(), 1, "a merge's own check keeps the branch green");
  h.finish("2");
  h.finish("3");
  await flush();
  h.merges[1]!.done.resolve();
  await queue;
});

/** A red branch at the start rejects the run before any issue starts. */
test("a red integration branch starts nothing", async () => {
  const h = harness({
    ids: ["1"],
    assertGreen: async () => {
      throw new BranchStateError("red");
    },
  });
  await assert.rejects(h.run(), BranchStateError);
  assert.deepEqual(h.started, []);
});

/** A red merge halts new work, lets running issues settle, then throws. */
test("a merge that leaves the branch red stops new starts, awaits runners and rethrows", async () => {
  const h = harness({ ids: ["1", "2", "3", "4"], blockedBy: { "3": ["1"] } });
  const queue = h.run();
  const state = watch(queue);
  queue.catch(() => undefined);
  await flush();

  h.finish("1");
  await flush();
  h.merges[0]!.done.reject(new BranchStateError("check is red"));
  await flush();
  assert.deepEqual(h.started, ["1", "2", "4"], "3 is not started on a red branch");
  assert.equal(state.settled, false, "running issues are awaited");

  h.finish("2");
  await flush();
  assert.equal(h.merges.length, 1, "no further merge once red");
  assert.equal(state.settled, false);

  h.finish("4");
  await assert.rejects(queue, /check is red/);
});

/** A quota failure aborts siblings through the signal and is rethrown after they settle. */
test("a quota failure aborts running siblings, awaits them and rethrows it", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  const state = watch(queue);
  queue.catch(() => undefined);
  await flush();

  h.fail("1", new RunFatalError("quota", "You've hit your session limit"));
  await flush();
  assert.equal(h.signals.get("2")!.aborted, true);
  assert.equal(state.settled, false, "the sibling is awaited");

  h.fail("2", new Error("aborted"));
  await assert.rejects(queue, (error: unknown) => error instanceof RunFatalError && error.kind === "quota");
  assert.equal(h.merges.length, 0);
});

/** A run-fatal error from a merge aborts running issues like one from an issue. */
test("a quota stop in a merge aborts running issues and is rethrown once they settle", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  queue.catch(() => undefined);
  await flush();
  h.finish("1");
  await flush();
  h.merges[0]!.done.reject(new RunFatalError("quota", "limit"));
  await flush();
  assert.equal(h.signals.get("2")!.aborted, true);
  h.fail("2", new Error("aborted"));
  await assert.rejects(queue, RunFatalError);
});

/** Two issues failing with the same message back to back stop the run. */
test("two different issues failing alike back to back raise the shared stop, abort siblings and await them", async () => {
  const h = harness({ ids: ["1", "2", "3"] });
  const queue = h.run();
  const state = watch(queue);
  queue.catch(() => undefined);
  await flush();

  h.fail("1", new Error("Implementer for #1 hit a wall"));
  await flush();
  assert.equal(h.signals.get("3")!.aborted, false, "one failure proves nothing");
  h.fail("2", new Error("Implementer for #2 hit a wall"));
  await flush();
  assert.equal(h.signals.get("3")!.aborted, true);
  assert.equal(state.settled, false, "the sibling is awaited");

  assert.equal(h.signals.get("1")!.aborted, true, "so is the retry of the first failure");
  h.fail("1", new Error("aborted"));
  h.fail("3", new Error("aborted"));
  await assert.rejects(queue, (error: unknown) => error instanceof RunFatalError && error.kind === "shared");
  assert.deepEqual(h.started, ["1", "2", "3", "1"], "the stop is not retried or counted as an attempt");
});

/** A success clears the failure streak the shared-failure stop reads. */
test("a success between two alike failures resets the streak", async () => {
  const h = harness({ ids: ["1", "2", "3"] });
  const queue = h.run();
  await flush();
  h.fail("1", new Error("wall"));
  await flush();
  h.finish("3");
  await flush();
  h.merges[0]!.done.resolve();
  await flush();
  h.fail("2", new Error("wall"));
  await flush();
  assert.equal(h.signals.get("2")!.aborted, false);
  h.finish("1");
  h.finish("2");
  await flush();
  h.merges[1]!.done.resolve();
  await flush();
  if (h.merges[2]) h.merges[2].done.resolve();
  await queue;
});

/** One issue repeating a failure proves nothing about the machine. */
test("the same issue failing twice with the same message is not a shared failure", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  h.fail("1", new Error("wall"));
  await flush();
  h.fail("1", new Error("wall"));
  await flush();
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  const result = await queue;
  assert.deepEqual(result.outOfAttempts, []);
});

/** A solo issue failing every attempt is reported out of attempts, not as a shared failure. */
test("a solo group whose issue fails repeatedly runs out of attempts without a shared stop", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  for (let i = 0; i < 3; i++) {
    h.fail("1", new Error("wall"));
    await flush();
  }
  const result = await queue;
  assert.deepEqual(result.outOfAttempts.map((i) => i.id), ["1"]);
});

/** MAX_ATTEMPTS caps starts per issue and the spent issue is reported apart from plannable. */
test("an issue failing three times is not started a fourth time and is reported out of attempts", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  await flush();
  h.fail("1", new Error("tests never went green"));
  await flush();
  h.fail("1", new Error("tests never went green"));
  await flush();
  h.fail("1", new Error("tests never went green"));
  h.finish("2");
  await flush();
  h.merges[0]!.done.resolve();
  const result = await queue;
  assert.deepEqual(h.started, ["1", "2", "1", "1"]);
  assert.deepEqual(h.merges.map((m) => m.batch), [["2"]]);
  assert.deepEqual(result.outOfAttempts.map((i) => i.id), ["1"]);
  assert.deepEqual(result.plannable, [], "out of attempts is reported there, not as plannable");
});

/** A start lost to GitHub being unreachable is retried without counting, so an outage cannot spend every attempt (#999's run). */
test("an issue that loses GitHub is retried after the wait without spending an attempt", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  const offline = "Command failed: gh issue view 1\nerror connecting to api.github.com";
  for (let i = 0; i < 3; i++) {
    h.fail("1", new Error(offline));
    await flush();
  }
  h.fail("1", new Error("wall"));
  await flush();
  h.fail("1", new Error("wall"));
  await flush();
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  const result = await queue;
  assert.equal(h.started.length, 6, "three outages, then two counted failures, then a success");
  assert.deepEqual(result.outOfAttempts, []);
  assert.ok(h.logs.some((m) => m.includes("not counted as an attempt")));
  assert.ok(h.logs.some((m) => m.includes("(attempt 2/3)")));
});

/** Two issues losing GitHub together is an outage, not the shared-failure stop. */
test("two issues losing GitHub back to back wait rather than raise the shared stop", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  await flush();
  h.fail("1", new Error("fatal: unable to access: Could not resolve host: github.com"));
  h.fail("2", new Error("fatal: unable to access: Could not resolve host: github.com"));
  await flush();
  assert.deepEqual(h.started, ["1", "2", "1", "2"]);
  h.finish("1");
  h.finish("2");
  await flush();
  h.merges[0]!.done.resolve();
  await queue;
});

/** GitHub that never comes back stops the run as a network failure, with the work saved. */
test("GitHub that stays unreachable stops the run as a network failure", async () => {
  const h = harness({ ids: ["1"], gitHubReturns: false });
  const queue = h.run();
  await flush();
  h.fail("1", new Error("error connecting to api.github.com"));
  await assert.rejects(queue, (error: unknown) => error instanceof RunFatalError && error.kind === "network");
  assert.deepEqual(h.started, ["1"]);
});

/** An issue the end time stopped is logged as stopped, not finished, so the log agrees with the unfinished-branch warning (#835's run). */
test("an issue that returns without its Done marker is logged as stopped, not finished", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  h.finish("1", { completed: false, marker: false });
  await queue;
  assert.ok(h.logs.some((m) => m.startsWith("#1 stopped before its Done marker")));
  assert.ok(!h.logs.some((m) => m.startsWith("#1 finished")));
});

/** A retry that succeeds leaves no trace of the earlier failure in the result. */
test("an issue failing once then succeeding on retry merges as normal", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  h.fail("1", new Error("flaky"));
  await flush();
  assert.deepEqual(h.started, ["1", "1"]);
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  const result = await queue;
  assert.deepEqual(h.merges.map((m) => m.batch), [["1"]]);
  assert.deepEqual(result.outOfAttempts, []);
  assert.deepEqual(result.plannable, []);
});

/** Each retry asserts green first, since agents never start on a red branch. */
test("the integration branch is asserted green before each retry", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  assert.equal(h.greenAsserts(), 1);
  h.fail("1", new Error("flaky"));
  await flush();
  assert.equal(h.greenAsserts(), 2);
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  await queue;
});

/** A branch that went red before a retry stops the group without restarting the issue. */
test("a red integration branch before a retry stops the group", async () => {
  let asserts = 0;
  const h = harness({
    ids: ["1"],
    assertGreen: async () => {
      if (++asserts > 1) throw new BranchStateError("red");
    },
  });
  const queue = h.run();
  queue.catch(() => undefined);
  await flush();
  h.fail("1", new Error("flaky"));
  await assert.rejects(queue, BranchStateError);
  assert.deepEqual(h.started, ["1"]);
});

/** Run-fatal failures end the run and are neither counted nor logged as running out of attempts. */
test("a quota failure is not an attempt and is not retried", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  queue.catch(() => undefined);
  await flush();
  h.fail("1", new RunFatalError("quota", "You've hit your session limit"));
  await assert.rejects(queue, (error: unknown) => error instanceof RunFatalError && error.kind === "quota");
  assert.deepEqual(h.started, ["1"]);
  assert.doesNotMatch(h.logs.join("\n"), /out of attempts/i);
});

/** Past the end time a failed issue stays plannable and is not retried. */
test("no retry starts once the end time has passed", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  h.passEndTime();
  h.fail("1", new Error("flaky"));
  const result = await queue;
  assert.deepEqual(h.started, ["1"]);
  assert.equal(result.stoppedAtEndTime, true);
  assert.deepEqual(result.outOfAttempts, []);
  assert.deepEqual(result.plannable.map((i) => i.id), ["1"]);
});

/** The log numbers each failed attempt and names the issue that ran out. */
test("each failure line carries its attempt number and running out of attempts is logged", async () => {
  const h = harness({ ids: ["1"] });
  const queue = h.run();
  await flush();
  for (let attempt = 0; attempt < 3; attempt++) {
    h.fail("1", new Error("boom"));
    await flush();
  }
  await queue;
  const log = h.logs.join("\n");
  assert.match(log, /#1 failed \(attempt 1\/3\): boom/);
  assert.match(log, /#1 failed \(attempt 2\/3\): boom/);
  assert.match(log, /#1 failed \(attempt 3\/3\): boom/);
  assert.match(log, /#1 ran out of attempts/);
});

/** A merged issue the plan lists again means its Done marker is unseen, so the group stops. */
test("a merged issue planned again stops the group", async () => {
  const h = harness({ ids: ["1", "2"], stubbornPlan: true });
  const queue = h.run();
  queue.catch(() => undefined);
  await flush();
  h.finish("1");
  h.finish("2");
  await flush();
  h.merges[0]!.done.resolve();
  await assert.rejects(queue, (error: unknown) => error instanceof BranchStateError && /#1/.test(error.message));
  assert.deepEqual(h.started, ["1", "2"], "nothing is re-worked");
});

/** The merged-but-replanned check covers issues merged by earlier merges, not just the latest. */
test("an issue merged by an earlier merge of the run planned again stops the group", async () => {
  const h = harness({ ids: ["1", "2", "3"], stubbornPlan: true, blockedBy: { "2": ["1"], "3": ["2"] } });
  const queue = h.run();
  queue.catch(() => undefined);
  await flush();
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  // The stubborn plan lists #1 again right after the first merge.
  await assert.rejects(queue, (error: unknown) => error instanceof BranchStateError && /#1/.test(error.message));
});

/** Issues that complete without commits settle the group with nothing to do. */
test("every issue completing with no commits settles the group with nothing to do", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  await flush();
  h.finish("1", { commits: [], marker: false });
  h.finish("2", { commits: [], marker: false });
  const result = await queue;
  assert.equal(result.settledWithNothingToDo, true);
  assert.equal(h.merges.length, 0);
});

/** One issue producing commits stops the group counting as settled. */
test("an issue that merged work is not nothing to do", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  await flush();
  h.finish("1");
  h.finish("2", { commits: [], marker: false });
  await flush();
  h.merges[0]!.done.resolve();
  const result = await queue;
  assert.equal(result.settledWithNothingToDo, false);
});

/** The end time stops starts but never a merge of finished work. */
test("once the end time passes nothing new starts, but finished work still merges", async () => {
  const h = harness({ ids: ["1", "2"], blockedBy: { "2": ["1"] } });
  const queue = h.run();
  await flush();
  h.passEndTime();
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  const result = await queue;
  assert.deepEqual(h.merges.map((m) => m.batch), [["1"]]);
  assert.deepEqual(h.started, ["1"]);
  assert.equal(result.stoppedAtEndTime, true);
});

/** A run begun past its end time starts nothing and reports it. */
test("an end time already passed starts nothing", async () => {
  const h = harness({ ids: ["1"] });
  h.passEndTime();
  const result = await h.run();
  assert.deepEqual(h.started, []);
  assert.equal(result.stoppedAtEndTime, true);
});

/** A fully blocked group returns immediately with its blocked issues. */
test("nothing plannable from the start returns at once, reporting what is blocked", async () => {
  const h = harness({ ids: ["2"], blockedBy: { "2": ["99"] } });
  const result = await h.run();
  assert.deepEqual(h.started, []);
  assert.equal(h.greenAsserts(), 0);
  assert.equal(h.merges.length, 0);
  assert.deepEqual(result.blocked.map((b) => b.id), ["2"]);
  assert.deepEqual(result.plannable, []);
  assert.equal(result.stoppedAtEndTime, false);
  assert.equal(result.settledWithNothingToDo, false);
});

/** The log narrates starts, finishes, failures, merges and unblocking, without cycle wording. */
test("the log names starts, finishes, failures, merges and what a merge unblocked", async () => {
  const h = harness({ ids: ["1", "2", "3"], blockedBy: { "3": ["1"] } });
  const queue = h.run();
  await flush();
  h.fail("2", new Error("boom"));
  h.finish("1");
  await flush();
  h.merges[0]!.done.resolve();
  await flush();
  h.fail("2", new Error("boom"));
  await flush();
  h.fail("2", new Error("boom"));
  h.finish("3");
  await flush();
  h.merges[1]!.done.resolve();
  await queue;
  const log = h.logs.join("\n");
  assert.match(log, /#1 starting/);
  assert.match(log, /#1 finished/);
  assert.match(log, /#2 failed \(attempt 1\/3\): boom/);
  assert.match(log, /merging #1/i);
  assert.match(log, /#3 unblocked/);
  assert.doesNotMatch(log, /cycle/i);
});

/** A retry waits for the merge in progress before asserting green (a merge moves the branch). */
test("a retry asserts green only after the merge in progress has finished", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  await flush();
  h.finish("1");
  await flush();
  h.fail("2", new Error("flaky"));
  await flush();
  assert.equal(h.greenAsserts(), 1, "no assertion while the merge runs");
  assert.deepEqual(h.started, ["1", "2"], "the retry has not started");

  h.merges[0]!.done.resolve();
  await flush();
  assert.equal(h.greenAsserts(), 2);
  assert.deepEqual(h.started, ["1", "2", "2"]);
  h.finish("2");
  await flush();
  h.merges[1]!.done.resolve();
  await queue;
});

/** Retries from several failed issues assert green one at a time, never overlapping. */
test("simultaneous retries assert green one after another", async () => {
  let active = 0;
  let overlapped = false;
  const h = harness({
    ids: ["1", "2", "3"],
    assertGreen: async () => {
      active++;
      if (active > 1) overlapped = true;
      await flush();
      active--;
    },
  });
  const queue = h.run();
  await flush();
  await flush();
  h.fail("1", new Error("one failed"));
  h.fail("2", new Error("a different failure"));
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(overlapped, false);
  assert.deepEqual(h.started, ["1", "2", "3", "1", "2"]);
  for (const id of ["1", "2", "3"]) h.finish(id);
  await flush();
  h.merges[0]!.done.resolve();
  await flush();
  if (h.merges[1]) h.merges[1].done.resolve();
  await queue;
});

/** An issue whose first attempt failed but whose retry completed empty still settles the group. */
test("a failed attempt later redeemed by an empty completion settles the group with nothing to do", async () => {
  const h = harness({ ids: ["1", "2"] });
  const queue = h.run();
  await flush();
  h.fail("1", new Error("flaky"));
  await flush();
  h.finish("1", { commits: [], marker: false });
  h.finish("2", { commits: [], marker: false });
  const result = await queue;
  assert.equal(result.settledWithNothingToDo, true);
});
