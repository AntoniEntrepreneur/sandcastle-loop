// Audible run outcome. Imported by main.mts both for its side effects — process
// handlers that play a sound however the run ends — and for reportOutcome(),
// which lets main.mts name the ending before it exits.
//
// Four endings, three sounds, and only one of them means something is broken.
// means something is broken. A quota-exhausted run is the expected interruption
// and needs nothing from you but a re-run later; hearing that from the next
// room is the whole point, since you are not watching the terminal.
//
// macOS only (afplay + the system sound set); silent no-op everywhere else,
// and silent if SANDCASTLE_SOUND=0.

import { execFileSync } from "node:child_process";

type Outcome = "success" | "empty" | "interrupted" | "crash";

const SOUNDS: Record<Outcome, string> = {
  success: "/System/Library/Sounds/Hero.aiff",
  // A run that published nothing shares the interrupted sound: it did not
  // break, but it wants looking at, and it has no good news to announce.
  empty: "/System/Library/Sounds/Funk.aiff",
  interrupted: "/System/Library/Sounds/Funk.aiff",
  crash: "/System/Library/Sounds/Sosumi.aiff",
};

let enabled =
  process.platform === "darwin" && process.env.SANDCASTLE_SOUND !== "0";

/** Play nothing when this run ends — an overnight run finishing at 4am. */
export function muteSounds(): void {
  enabled = false;
}

let played = false;

// Synchronous on purpose: the "exit" handler is the last thing that runs, and
// anything async there is dropped before it reaches the speakers.
function play(outcome: Outcome): void {
  if (!enabled || played) return;
  played = true;
  try {
    execFileSync("afplay", [SOUNDS[outcome]], { stdio: "ignore", timeout: 5000 });
  } catch {
    // A missing sound file or no audio device must never fail the run.
  }
}

/** Name how the run ended, so the exit handler plays the right sound. */
export function reportOutcome(outcome: Outcome): void {
  play(outcome);
}

process.on("exit", (code) => {
  play(code === 0 ? "success" : "crash");
});

process.on("uncaughtException", (err) => {
  console.error(err);
  play("crash");
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error(err);
  play("crash");
  process.exit(1);
});

// Ctrl-C and friends: without an explicit handler these terminate the process
// without ever running the "exit" handler above. A hand-stopped run is an
// interruption, not a crash — same remedy as a spent quota.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    play("interrupted");
    process.exit(130);
  });
}
