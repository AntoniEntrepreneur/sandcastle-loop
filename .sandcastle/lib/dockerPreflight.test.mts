/** Pin startup recovery through fake Docker and clock ports. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightDocker, type DockerPreflightPorts } from "./dockerPreflight.mts";

/** Model a stopped daemon that becomes ready after its configured launch. */
function fakeDocker(readyAfter = 10_000) {
  let elapsed = 0;
  let started = false;
  const commands: string[] = [];
  const ports: DockerPreflightPorts = {
    probe: () => started && elapsed >= readyAfter,
    start: (command) => { commands.push(command); started = true; },
    now: () => elapsed,
    sleep: async (ms) => { elapsed += ms; },
  };
  return { ports, commands, elapsed: () => elapsed };
}

/** A stopped daemon recovers before any sandbox starts. */
test("starts the configured command and returns once Docker answers", async () => {
  const docker = fakeDocker();
  await preflightDocker(docker.ports, "launch-container-service");
  assert.deepEqual(docker.commands, ["launch-container-service"]);
  assert.equal(docker.elapsed(), 10_000);
});

/** A healthy daemon needs neither a launch command nor a wait. */
test("returns immediately when Docker already answers", async () => {
  const docker = fakeDocker();
  docker.ports.probe = () => true;
  await preflightDocker(docker.ports, "launch-container-service");
  assert.deepEqual(docker.commands, []);
  assert.equal(docker.elapsed(), 0);
});

/** The legacy advice remains the failure reported to the owner. */
const advice = /Docker is not responding — every sandbox would fail to start\. Open Docker Desktop, wait for it to finish starting, then re-run Sandcastle\./;

/** Recovery ends after the specified three-minute limit. */
test("Docker never answering stops after three minutes with the existing advice", async () => {
  const docker = fakeDocker(Infinity);
  await assert.rejects(preflightDocker(docker.ports, "launch-container-service"), advice);
  assert.equal(docker.elapsed(), 180_000);
  assert.deepEqual(docker.commands, ["launch-container-service"]);
});

/** An omitted command preserves the single probe and immediate failure. */
test("without a start command an unresponsive Docker fails immediately", async () => {
  const docker = fakeDocker();
  let probes = 0;
  docker.ports.probe = () => { probes++; return false; };
  await assert.rejects(preflightDocker(docker.ports), advice);
  assert.equal(probes, 1);
  assert.equal(docker.elapsed(), 0);
  assert.deepEqual(docker.commands, []);
});

/** A launcher error still allows an already starting daemon to recover. */
test("waits for readiness even when the start command fails", async () => {
  const docker = fakeDocker();
  docker.ports.start = () => { throw new Error("launcher failed"); };
  docker.ports.probe = () => docker.elapsed() >= 15_000;
  await preflightDocker(docker.ports, "launch-container-service");
  assert.equal(docker.elapsed(), 15_000);
});

/** Startup and slow probes share the same budget instead of extending it. */
test("bounds command and probe time by the remaining three-minute budget", async () => {
  let elapsed = 0;
  let firstProbe = true;
  await assert.rejects(preflightDocker({
    probe: (timeout) => {
      if (firstProbe) { firstProbe = false; return false; }
      assert.ok(timeout! > 0 && timeout! <= 5_000);
      assert.ok(timeout! <= 180_000 - elapsed);
      elapsed += timeout!;
      return false;
    },
    start: (_command, timeout) => {
      assert.equal(timeout, 180_000);
      elapsed += 172_000;
    },
    now: () => elapsed,
    sleep: async (ms) => { elapsed += ms; },
  }, "launch-container-service"), advice);
  assert.equal(elapsed, 180_000);
});

/** A daemon that finishes booting near the deadline still permits the run. */
test("accepts Docker answering near the end of the wait", async () => {
  const docker = fakeDocker(175_000);
  await preflightDocker(docker.ports, "launch-container-service");
  assert.equal(docker.elapsed(), 175_000);
});
