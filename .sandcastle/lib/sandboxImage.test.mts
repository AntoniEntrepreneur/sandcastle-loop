// Exercise image inspection and preparation against a disposable Docker stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create isolated inputs, executable stand-ins, and a child-process caller. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sandbox-image-test-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  for (const dir of [repo, bin, temp, join(repo, ".sandcastle"), join(repo, "nested")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(repo, ".sandcastle/Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, "nested/deps.lock"), Buffer.from([0, 255, 1]));
  const state = join(root, "state.json");
  const record = join(root, "build.json");
  writeFileSync(state, JSON.stringify({}));
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.IMAGE_STATE, 'utf8'));
if (args[0] === 'image') {
  if (!state.label) process.exit(1);
  console.log(state.label);
} else if (args[0] === 'build') {
  const context = args.at(-1);
  const label = args[args.indexOf('--label') + 1].split('=')[1];
  fs.writeFileSync(process.env.IMAGE_RECORD, JSON.stringify({context, label, args,
    bytes: [...fs.readFileSync(path.join(context, 'nested/deps.lock'))],
    dockerfile: fs.readFileSync(path.join(context, 'Dockerfile'), 'utf8'),
    buildkit: process.env.DOCKER_BUILDKIT}));
  if (process.env.FAIL_BUILD) {
    console.log('dependency installation output');
    console.error('build failure details');
    process.exit(17);
  }
  fs.writeFileSync(process.env.IMAGE_STATE, JSON.stringify({label}));
} else process.exit(99);
`, { mode: 0o755 });
  writeFileSync(join(bin, "id"), `#!${process.execPath}
const fs = require('node:fs');
if (process.env.EDIT_INPUT) fs.writeFileSync(process.env.EDIT_INPUT, 'later bytes');
console.log('1000');
`, { mode: 0o755 });
  const options = { repoCwd: repo, imageName: "same-image-name", inputFiles: ["nested/deps.lock", ".sandcastle/Dockerfile"] };
  /** Run the public image seam with isolated process state. */
  function run(operation: "inspect" | "prepare", extra: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { inspectSandboxImage, prepareSandboxImage } from ${JSON.stringify(new URL("./sandboxImage.mts", import.meta.url).href)};
      try { console.log(${operation === "inspect" ? "inspectSandboxImage" : "prepareSandboxImage"}(${JSON.stringify(options)})); }
      catch (error) { console.error(String(error.stdout ?? '') + String(error.stderr ?? '')); process.exit(1); }
    `], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp, IMAGE_STATE: state, IMAGE_RECORD: record, ...extra } });
  }
  return { repo, temp, state, record, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Pin inspection as read-only and reuse an image whose inputs still match. */
test("inspection reports missing, stale and current without staging; preparation reuses a matching image", () => {
  const f = fixture();
  try {
    assert.equal(f.run("inspect").stdout.trim(), "missing");
    writeFileSync(f.state, JSON.stringify({ label: "old-label" }));
    assert.equal(f.run("inspect").stdout.trim(), "stale");
    assert.deepEqual(readdirSync(f.temp), []);
    assert.equal(existsSync(f.record), false);
    const built = f.run("prepare");
    assert.equal(built.status, 0, built.stderr);
    assert.equal(built.stdout.trim(), "rebuilt");
    assert.equal(f.run("inspect").stdout.trim(), "current");
    rmSync(f.record);
    assert.equal(f.run("prepare").stdout.trim(), "current");
    assert.equal(existsSync(f.record), false);
    assert.deepEqual(readdirSync(f.temp), []);
  } finally {
    f.cleanup();
  }
});

/** Pin #1246: an edit after staging cannot label earlier bytes as fresh. */
test("build label describes staged bytes when the source changes during preparation", () => {
  const f = fixture();
  try {
    const built = f.run("prepare", { EDIT_INPUT: join(f.repo, "nested/deps.lock") });
    assert.equal(built.status, 0, built.stderr);
    const record = JSON.parse(readFileSync(f.record, "utf8"));
    assert.deepEqual(record.bytes, [0, 255, 1]);
    // Pin the existing logical names and length-prefixed SHA-256 format.
    assert.equal(record.label, "f24624ee853542d33cae34c63f197cd3a2bc8e97208ee447100e42367f202fc2");
    assert.equal(record.dockerfile, "FROM scratch\n");
    assert.equal(record.buildkit, "1");
    assert.equal(record.args[record.args.indexOf("-t") + 1], "same-image-name");
    assert.equal(existsSync(record.context), false);
    assert.equal(f.run("inspect").stdout.trim(), "stale");
    writeFileSync(join(f.repo, "nested/deps.lock"), Buffer.from([0, 255, 1]));
    assert.equal(f.run("inspect").stdout.trim(), "current");
    writeFileSync(join(f.repo, "nested/deps.lock"), Buffer.from([0, 254, 1]));
    assert.equal(f.run("inspect").stdout.trim(), "stale");
  } finally {
    f.cleanup();
  }
});

/** Pin #1246: build diagnostics survive and cleanup happens before caller exit. */
test("failed build preserves output and removes the temporary context before exit", () => {
  const f = fixture();
  try {
    const failed = f.run("prepare", { FAIL_BUILD: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /dependency installation output/);
    assert.match(failed.stderr, /build failure details/);
    const record = JSON.parse(readFileSync(f.record, "utf8"));
    assert.equal(existsSync(record.context), false);
    assert.deepEqual(readdirSync(f.temp), []);
    assert.equal(f.run("inspect").stdout.trim(), "missing");
  } finally {
    f.cleanup();
  }
});
