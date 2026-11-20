/** Verify dependency recovery through the project-check seam. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProject, type ProjectCheckPorts } from "./projectCheck.mts";

/** Capture sandbox commands and remembered green trees with scripted check results. */
function fixture(failures: string[], refreshDepsCommand: string | undefined = "REFRESH", refreshExit = 0) {
  const commands: string[] = [];
  const greenTrees: string[] = [];
  let inSlot = false;
  const ports: ProjectCheckPorts = {
    cleanTree: () => "tree",
    isGreenTree: () => false,
    recordGreenTree: (tree) => { greenTrees.push(tree); },
    refreshDepsCommand,
    async exec(command) {
      commands.push(command);
      if (command === "REFRESH") {
        assert.equal(inSlot, false);
        return { exitCode: refreshExit, stdout: "", stderr: "refresh output" };
      }
      assert.equal(inSlot, true);
      const stderr = failures.shift() ?? "";
      return { exitCode: stderr ? 1 : 0, stdout: "", stderr };
    },
    async withCheckSlot(work) {
      assert.equal(inSlot, false);
      inSlot = true;
      try { return await work(); } finally { inSlot = false; }
    },
  };
  return { ports, commands, greenTrees };
}

/** A missing installed package is repaired before the check is judged (#1267). */
test("module-not-found refreshes dependencies and remembers the retried green tree", async () => {
  const { ports, commands, greenTrees } = fixture(["  code: 'ERR_MODULE_NOT_FOUND'\n"]);
  assert.equal(await checkProject(ports, { command: "CHECK", tailChars: 6000 }), undefined);
  assert.deepEqual(commands, ["CHECK", "REFRESH", "CHECK"]);
  assert.deepEqual(greenTrees, ["tree"]);
});

for (const diagnostic of [
  "  code: 'MODULE_NOT_FOUND',\n",
  '  code: "ERR_MODULE_NOT_FOUND",\r\n',
  "npm warn tar TAR_ENTRY_ERROR ENOENT: no such file or directory\n",
  "npm WARN tar TAR_ENTRY_INVALID checksum failure\n",
  "npm ERR! tar TAR_ENTRY_ERROR EIO: unpack failed\n",
]) {
  /** Recognise runtime and unpack diagnostics in either output stream. */
  test(`dependency diagnostic retries: ${diagnostic.trim()}`, async () => {
    const { ports, commands } = fixture([diagnostic]);
    const exec = ports.exec;
    ports.exec = async (command) => {
      const result = await exec(command);
      return { ...result, stdout: result.stderr, stderr: "" };
    };
    assert.equal(await checkProject(ports, { command: "CHECK", tailChars: 6000 }), undefined);
    assert.deepEqual(commands, ["CHECK", "REFRESH", "CHECK"]);
  });
}

for (const output of [
  "test prints Cannot find package 'example'",
  "assertion mentions code: 'ERR_MODULE_NOT_FOUND'",
  "test output: npm warn tar TAR_ENTRY_ERROR ENOENT",
  "  code: 'ERR_MODULE_NOT_FOUND' was expected",
  "npm warn tar TAR_ENTRY_INFO removing leading slash",
  "a real test failed",
]) {
  /** Incidental diagnostic mentions and ordinary failures stay red without refresh. */
  test(`test output does not reinstall: ${output}`, async () => {
    const { ports, commands, greenTrees } = fixture([output]);
    assert.equal(await checkProject(ports, { command: "CHECK", tailChars: 6000 }), `\n${output}`);
    assert.deepEqual(commands, ["CHECK"]);
    assert.deepEqual(greenTrees, []);
  });
}

/** Recovery is unavailable unless the project configured it. */
test("no refresh configured means no dependency retry", async () => {
  const output = "  code: 'ERR_MODULE_NOT_FOUND'";
  const { ports, commands } = fixture([output]);
  delete ports.refreshDepsCommand;
  assert.equal(await checkProject(ports, { command: "CHECK", tailChars: 6000 }), `\n${output}`);
  assert.deepEqual(commands, ["CHECK"]);
});

for (const finalOutput of ["real test failure", "  code: 'ERR_MODULE_NOT_FOUND'", "npm error code EEXIST"]) {
  /** Recovery has one retry total, and exposes its final failure normally. */
  test(`red after dependency retry is reported: ${finalOutput}`, async () => {
    const { ports, commands, greenTrees } = fixture(["  code: 'ERR_MODULE_NOT_FOUND'", finalOutput], "REFRESH", 1);
    let reported: string | undefined;
    assert.equal(await checkProject(ports, {
      command: "CHECK", tailChars: 6000, onResult: (failure) => { reported = failure; },
    }), `\n${finalOutput}`);
    assert.equal(reported, `\n${finalOutput}`);
    assert.deepEqual(commands, ["CHECK", "REFRESH", "CHECK"]);
    assert.deepEqual(greenTrees, []);
  });
}

/** The existing cache-race retry still works without a dependency refresh. */
test("cache race retries without reinstalling", async () => {
  const { ports, commands } = fixture(["npm error code EEXIST"]);
  assert.equal(await checkProject(ports, { command: "CHECK", tailChars: 6000 }), undefined);
  assert.deepEqual(commands, ["CHECK", "CHECK"]);
});
