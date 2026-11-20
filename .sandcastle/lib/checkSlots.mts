// A machine-wide limit on full checks running at once, across every Sandcastle
// process on this machine. Each slot is a file holding its owner's pid, so a
// crashed run's slot is reclaimed rather than held forever.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Full checks allowed at once. A check takes about 5 minutes alone, but crowded
 * ones hit the 30-minute limit: eight at once on 2026-11-02 (about 30% CPU each),
 * and five on 2026-11-17, when three runs started together on 10.6 GiB of Docker
 * and eight checks were killed. Time a check under several parallel runs, not
 * alone, before raising it.
 */
export const CHECK_SLOTS = 3;

const POLL_MS = 5_000;

/** Whether a pid is still running; a pid we may not signal is still running. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Claim a slot file, clearing it first if its owner died; true when claimed. */
function tryClaim(path: string, isAlive: (pid: number) => boolean): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let owner: string;
  try {
    owner = readFileSync(path, "utf-8");
  } catch {
    return false; // Released between the two calls; the next poll takes it.
  }
  // An empty file is a claim still being written, not a dead owner.
  if (owner === "" || isAlive(Number(owner))) return false;
  rmSync(path, { force: true });
  return false;
}

/** Run `work` once a slot is free, releasing the slot however it ends. `signal` stops the wait. */
export async function withCheckSlot<T>(
  dir: string,
  work: () => Promise<T>,
  options: {
    slots?: number;
    signal?: AbortSignal;
    /** Called once, if the first attempt finds every slot taken. */
    onWait?: () => void;
    pollMs?: number;
    isAlive?: (pid: number) => boolean;
  } = {},
): Promise<T> {
  const { slots = CHECK_SLOTS, signal, onWait, pollMs = POLL_MS, isAlive = pidIsAlive } = options;
  mkdirSync(dir, { recursive: true });
  const paths = Array.from({ length: slots }, (_, i) => join(dir, `slot-${i}`));
  let waited = false;
  for (;;) {
    signal?.throwIfAborted();
    const claimed = paths.find((path) => tryClaim(path, isAlive));
    if (claimed !== undefined) {
      try {
        return await work();
      } finally {
        rmSync(claimed, { force: true });
      }
    }
    if (!waited) onWait?.();
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
