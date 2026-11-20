// Tests for the machine-wide check limit, against real files in a temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withCheckSlot } from "./checkSlots.mts";

const tempDir = () => mkdtempSync(join(tmpdir(), "check-slots-"));

/** Pins the limit itself: five checks through two slots never overlap beyond two. */
test("no more checks run at once than there are slots", async () => {
  const dir = tempDir();
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 5 }, () =>
      withCheckSlot(
        dir,
        async () => {
          peak = Math.max(peak, ++running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
        },
        { slots: 2, pollMs: 1 },
      ),
    ),
  );
  assert.equal(peak, 2);
});

/** Pins that a check that throws gives its slot back. */
test("a failed check releases its slot", async () => {
  const dir = tempDir();
  await assert.rejects(withCheckSlot(dir, () => Promise.reject(new Error("red")), { slots: 1 }), /red/);
  assert.equal(existsSync(join(dir, "slot-0")), false);
});

/** Pins that a run killed mid-check does not hold its slot forever. */
test("a slot whose owner died is reclaimed", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "slot-0"), "999999");
  const result = await withCheckSlot(dir, async () => "ran", { slots: 1, pollMs: 1, isAlive: () => false });
  assert.equal(result, "ran");
});

/** Pins that a sibling's run-fatal abort stops a check still queueing. */
test("an abort stops the wait and the check never runs", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "slot-0"), String(process.pid));
  const controller = new AbortController();
  let waited = 0;
  let ran = false;
  await assert.rejects(
    withCheckSlot(
      dir,
      async () => {
        ran = true;
      },
      {
        slots: 1,
        pollMs: 1,
        signal: controller.signal,
        onWait: () => {
          waited++;
          controller.abort(new Error("sibling stopped"));
        },
      },
    ),
    /sibling stopped/,
  );
  assert.equal(ran, false);
  assert.equal(waited, 1);
});
