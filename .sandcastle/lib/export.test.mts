// Exercise pack export against disposable repositories with publication intercepted.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const exporter = fileURLToPath(new URL("../export.mts", import.meta.url));
const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();

/** Run Git against a disposable repository. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, args, { cwd, encoding: "utf-8" }).trim();
}

/** Write a fixture file, creating its parent directories. */
function put(root: string, path: string, bytes: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

/** Save the fixture's staged changes and return their commit. */
function commit(root: string, subject: string): string {
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", subject);
  return git(root, "rev-parse", "HEAD");
}

/** Create source and pack repositories plus command stand-ins that prevent network access. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pack-export-test-"));
  const source = join(root, "source");
  const pack = join(root, "pack");
  for (const repo of [source, pack]) {
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    git(repo, "config", "user.name", "Export Test");
    git(repo, "config", "user.email", "export@example.test");
  }
  put(source, ".sandcastle/main.mts", "export const version = 1;\n");
  put(source, ".sandcastle/lib/check.test.mjs", 'import { test } from "node:test"; test("pack check", () => {});\n');
  put(source, ".sandcastle/sandcastle.config.mts", "project setup\n");
  put(source, "patches/@ai-hero+sandcastle+0.12.0.patch", "engine patch\n");
  put(source, "patches/other+1.0.0.patch", "other patch\n");
  put(source, "package-lock.json", JSON.stringify({ packages: { "node_modules/@ai-hero/sandcastle": { version: "0.12.0" } } }));
  const previous = commit(source, "Initial loop");
  const files = [".sandcastle/lib/check.test.mjs", ".sandcastle/main.mts", "patches/@ai-hero+sandcastle+0.12.0.patch"];
  for (const path of files) put(pack, path, readFileSync(join(source, path), "utf-8"));
  put(pack, "examples/iletobedzie/sandcastle.config.mts", "project setup\n");
  put(pack, "README.md", "Pack-owned separately from export\n");
  put(pack, "manifest.json", JSON.stringify({ engineVersion: "0.12.0", sourceCommit: previous, files, projectFiles: [".sandcastle/sandcastle.config.mts"] }, null, 2) + "\n");
  commit(pack, "Previous export");
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Only transport and publication are replaced; reads, history and pack tests run for real.
  const shim = `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { appendFileSync, cpSync } = require('node:fs');
const { basename, join } = require('node:path');
const args = process.argv.slice(2);
const kind = basename(process.argv[1]);
const root = process.env.EXPORT_FIXTURE;
appendFileSync(join(root, 'commands'), JSON.stringify([kind, ...args]) + '\\n');
if (kind === 'gh') {
  if (args[1] === 'create') process.stdout.write('https://example.test/pull/1');
  process.exit(0);
}
if (kind === 'git' && args[0] === 'fetch') process.exit(0);
if (kind === 'git' && args[0] === 'push') {
  cpSync(process.cwd(), join(root, 'published'), { recursive: true });
  process.exit(0);
}
if (kind === 'git' && args[0] === 'clone') args[2] = join(root, 'pack');
try {
  const output = execFileSync(kind === 'git' ? ${JSON.stringify(realGit)} : ${JSON.stringify(process.execPath)}, args, { maxBuffer: 64 * 1024 * 1024 });
  if (kind === 'git' && args[0] === 'rev-parse' && args[1] === 'origin/main' && process.env.EXPORT_MOVE_TO) {
    execFileSync(${JSON.stringify(realGit)}, ['update-ref', 'refs/remotes/origin/main', process.env.EXPORT_MOVE_TO]);
  }
  process.stdout.write(output);
} catch (error) { process.exit(error.status || 1); }
`;
  for (const command of ["git", "gh", "node"]) writeFileSync(join(bin, command), shim, { mode: 0o755 });
  return {
    root, source, pack, previous,
    /** Run the actual exporter with a pinned starting ref and optional concurrent ref move. */
    run(pinned: string, movedTo = "") {
      git(source, "update-ref", "refs/remotes/origin/main", pinned);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "fixture-token", EXPORT_FIXTURE: root, EXPORT_MOVE_TO: movedTo };
      // A nested Node test runner otherwise suppresses the pack test execution.
      delete env.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, [exporter], {
        cwd: source, encoding: "utf-8",
        env,
      });
    },
    /** Read all intercepted command invocations. */
    commands(): string[][] {
      return readFileSync(join(root, "commands"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    },
    /** Remove both disposable repositories and publication captures. */
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

/** Pin all exported paths, bytes, examples, engine metadata and history to the resolved commit. */
test("export stays at its resolved commit when the source ref moves", () => {
  const f = fixture();
  try {
    put(f.source, ".sandcastle/main.mts", "pinned bytes\n");
    put(f.source, ".sandcastle/pinned.mts", "pinned file\n");
    put(f.source, ".sandcastle/sandcastle.config.mts", "pinned setup\n");
    put(f.source, "package-lock.json", JSON.stringify({ packages: { "node_modules/@ai-hero/sandcastle": { version: "0.12.1" } } }));
    rmSync(join(f.source, "patches/@ai-hero+sandcastle+0.12.0.patch"));
    put(f.source, "patches/@ai-hero+sandcastle+0.12.1.patch", "pinned patch\n");
    const pinned = commit(f.source, "Pinned export (#1250)");
    put(f.source, ".sandcastle/main.mts", "later bytes\n");
    put(f.source, ".sandcastle/later.mts", "later file\n");
    put(f.source, ".sandcastle/sandcastle.config.mts", "later setup\n");
    put(f.source, "package-lock.json", JSON.stringify({ packages: { "node_modules/@ai-hero/sandcastle": { version: "0.13.0" } } }));
    const later = commit(f.source, "Later work excluded");
    const result = f.run(pinned, later);
    assert.equal(result.status, 0, result.stderr);
    const artifact = join(f.root, "published");
    const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf-8"));
    assert.equal(manifest.sourceCommit, pinned);
    assert.equal(manifest.engineVersion, "0.12.1");
    assert.ok(manifest.files.includes(".sandcastle/pinned.mts"));
    assert.ok(!manifest.files.includes(".sandcastle/later.mts"));
    assert.equal(readFileSync(join(artifact, ".sandcastle/main.mts"), "utf-8"), "pinned bytes\n");
    assert.equal(readFileSync(join(artifact, "examples/iletobedzie/sandcastle.config.mts"), "utf-8"), "pinned setup\n");
    assert.equal(readFileSync(join(artifact, "patches/@ai-hero+sandcastle+0.12.1.patch"), "utf-8"), "pinned patch\n");
    assert.ok(!existsSync(join(artifact, ".sandcastle/sandcastle.config.mts")));
    assert.ok(!existsSync(join(artifact, "patches/other+1.0.0.patch")));
    assert.ok(!existsSync(join(artifact, "patches/@ai-hero+sandcastle+0.12.0.patch")));
    assert.equal(readFileSync(join(artifact, "README.md"), "utf-8"), "Pack-owned separately from export\n");
    const commands = f.commands();
    const publication = commands.find((args) => args[0] === "gh" && args[2] === "create")!;
    const body = publication[publication.indexOf("--body") + 1]!;
    assert.match(body, /Pinned export \(OptimisedMath\/iletobedzie#1250\)/);
    assert.ok(!body.includes("Later work excluded"));
    assert.ok(commands.findIndex((args) => args[0] === "node" && args[1] === "--test") < commands.findIndex((args) => args[1] === "push"));
  } finally { f.cleanup(); }
});

/** Include a deletion-only source commit in the summary and remove its exported file. */
test("a deletion-only export removes the artifact and reports its source commit", () => {
  const f = fixture();
  try {
    rmSync(join(f.source, ".sandcastle/main.mts"));
    const deleted = commit(f.source, "Remove obsolete runner (#1250)");
    const result = f.run(deleted);
    assert.equal(result.status, 0, result.stderr);
    const artifact = join(f.root, "published");
    assert.ok(!existsSync(join(artifact, ".sandcastle/main.mts")));
    const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf-8"));
    assert.ok(!manifest.files.includes(".sandcastle/main.mts"));
    const publication = f.commands().find((args) => args[0] === "gh" && args[2] === "create")!;
    assert.match(publication[publication.indexOf("--body") + 1]!, /Remove obsolete runner \(OptimisedMath\/iletobedzie#1250\)/);
  } finally { f.cleanup(); }
});

/** Report changes to both removed and newly introduced pack paths while excluding project-only changes. */
test("export history covers previous and new pack paths", () => {
  const f = fixture();
  try {
    rmSync(join(f.source, ".sandcastle/main.mts"));
    commit(f.source, "Remove old runner");
    put(f.source, ".sandcastle/replacement.mts", "replacement\n");
    commit(f.source, "Introduce new runner");
    put(f.source, ".sandcastle/sandcastle.config.mts", "new project setup\n");
    const pinned = commit(f.source, "Project setup only");
    const result = f.run(pinned);
    assert.equal(result.status, 0, result.stderr);
    const publication = f.commands().find((args) => args[0] === "gh" && args[2] === "create")!;
    const body = publication[publication.indexOf("--body") + 1]!;
    assert.match(body, /Remove old runner/);
    assert.match(body, /Introduce new runner/);
    assert.ok(!body.includes("Project setup only"));
    assert.equal(readFileSync(join(f.root, "published/.sandcastle/replacement.mts"), "utf-8"), "replacement\n");
  } finally { f.cleanup(); }
});

/** Ignore a source stamp change when all exported bytes and ownership remain identical. */
test("an unrelated source commit produces no publication", () => {
  const f = fixture();
  try {
    put(f.source, "unrelated.txt", "source-only change\n");
    const pinned = commit(f.source, "Unrelated change");
    const result = f.run(pinned);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing to export/);
    assert.ok(!existsSync(join(f.root, "published")));
    assert.ok(!f.commands().some((args) => args[0] === "gh" || args[1] === "push" || args[0] === "node"));
    assert.equal(JSON.parse(readFileSync(join(f.pack, "manifest.json"), "utf-8")).sourceCommit, f.previous);
  } finally { f.cleanup(); }
});

/** Stop publication when the exported pack's own test gate fails. */
test("failing exported tests prevent publication", () => {
  const f = fixture();
  try {
    put(f.source, ".sandcastle/lib/check.test.mjs", 'import { test } from "node:test"; test("pack check", () => { throw new Error("pack rejected"); });\n');
    const pinned = commit(f.source, "Break pack check");
    const result = f.run(pinned);
    assert.notEqual(result.status, 0);
    const commands = f.commands();
    assert.ok(commands.some((args) => args[0] === "node" && args[1] === "--test" && args[2] === ".sandcastle/lib/"));
    assert.ok(!commands.some((args) => args[0] === "gh" || args[1] === "push"));
    assert.ok(!existsSync(join(f.root, "published")));
  } finally { f.cleanup(); }
});
