// Apply one outage policy to every GitHub call the run makes, host and agents alike.

import { commandErrorText } from "./commandOutput.mts";
import { isGitHubUnreachable } from "./groups.mts";
import { RunFatalError } from "./issueLoop.mts";

// How long a lost GitHub is waited out before the run stops: long enough for a
// router restart or a Wi-Fi drop, short of burning a whole night on it.
const GITHUB_WAIT_MS = 30 * 60_000;
const POLL_MS = 60_000;

/** Run one GitHub call under the shared outage policy, returning what it returns. */
export type GitHubCall = <T>(call: () => T | Promise<T>) => Promise<T>;

/** The outage policy: retry while GitHub is away, then end the run as a network stop. */
export interface GitHubAccess {
  run: GitHubCall;
  /** Wait out the current outage, as the issue agents do; false once the budget is spent. */
  wait(): Promise<boolean>;
}

/** Share one bounded outage wait across host calls and issue agents. */
export function createGitHubAccess(ports: {
  reachable(): boolean | Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}): GitHubAccess {
  const minutes = GITHUB_WAIT_MS / 60_000;
  let waiting: Promise<boolean> | undefined;
  let exhausted = false;

  /** Poll once per minute, sharing the deadline and announcement with concurrent callers. */
  function wait(): Promise<boolean> {
    if (exhausted) return Promise.resolve(false);
    waiting ??= (async () => {
      ports.log(`GitHub is unreachable — checking again every minute, for up to ${minutes} minutes.`);
      const deadline = ports.now() + GITHUB_WAIT_MS;
      while (ports.now() < deadline) {
        await ports.sleep(Math.min(POLL_MS, deadline - ports.now()));
        if (await ports.reachable()) {
          ports.log("GitHub is reachable again.");
          return true;
        }
      }
      exhausted = true;
      ports.log(`GitHub still unreachable after ${minutes} minutes.`);
      return false;
    })().finally(() => { waiting = undefined; });
    return waiting;
  }

  /** Retry unreachable calls, preserving other failures and the network run ending. */
  async function run<T>(call: () => T | Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await call();
      } catch (error) {
        // A nested call that already spent the budget keeps its network ending.
        if (error instanceof RunFatalError) throw error;
        const detail = commandErrorText(error);
        if (!isGitHubUnreachable(detail)) {
          if (error instanceof Error && error.message === detail) throw error;
          throw new Error(detail, { cause: error });
        }
        if (!(await wait())) {
          throw new RunFatalError("network", detail, { reason: "GitHub is unreachable" });
        }
      }
    }
  }

  return { run, wait };
}
