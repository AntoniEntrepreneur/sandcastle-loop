// Unit tests for this project's Sandcastle configuration. Project-owned, like
// the config it tests: the pack runs only `.sandcastle/lib/`'s tests, where
// no project config exists.

import { test } from "node:test";
import assert from "node:assert/strict";

import { config } from "./sandcastle.config.mts";

/** This project's macOS host opens Docker Desktop; other hosts keep manual startup. */
test("Docker startup command matches the host platform", () => {
  assert.equal(config.dockerStartCommand, process.platform === "darwin" ? "open -a Docker" : undefined);
});

/** Pins that the sandbox environment carries core.hooksPath=.githooks through git env-config variables (#1040). */
test("sandbox environment configures core.hooksPath to .githooks via git env-config", () => {
  assert.equal(config.sandboxEnv.GIT_CONFIG_COUNT, "1");
  assert.equal(config.sandboxEnv.GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.equal(config.sandboxEnv.GIT_CONFIG_VALUE_0, ".githooks");
});
