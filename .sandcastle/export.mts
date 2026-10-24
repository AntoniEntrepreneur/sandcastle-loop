// Export the loop to its pack repo as a PR.
//
// This repo is the loop's real home; the pack (AntoniEntrepreneur/sandcastle-loop)
// is the published snapshot other projects install from with the
// `setup-sandcastle` skill. An export copies the pack-owned files as they are
// on origin/main — never the working tree — plus the project-owned files as
// examples, runs the loop's tests in the pack, and opens or refreshes one PR
// from the pack's `export` branch. Nothing changed means no PR.
//
// Usage (GH_TOKEN must be able to push to the pack):
//   make sandcastle-export
//   GH_TOKEN=... npx tsx .sandcastle/export.mts

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  PROJECT_OWNED_FILES,
  exportPrBody,
  packOwnedFiles,
  type PackManifest,
} from "./lib/exportPlan.mts";

const PACK_REPO = "AntoniEntrepreneur/sandcastle-loop";
const SOURCE_REPO = "OptimisedMath/iletobedzie";
const EXAMPLES_DIR = "examples/iletobedzie";
const EXPORT_BRANCH = "export";
const SOURCE_REF = "origin/main";

const token = process.env.GH_TOKEN;
if (!token) {
  console.error("GH_TOKEN is not set; it needs push access to " + PACK_REPO + ".");
  process.exit(1);
}

/** Run a command and return its trimmed stdout; throws with its output on failure. */
function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** A file's bytes as `SOURCE_REF` has it. */
function sourceFile(path: string): Buffer {
  return execFileSync("git", ["show", `${SOURCE_REF}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
}

run("git", ["fetch", "--quiet", "origin", "main"]);
const sourceCommit = run("git", ["rev-parse", SOURCE_REF]);
const tracked = run("git", ["ls-tree", "-r", "--name-only", SOURCE_REF, "--", ".sandcastle", "patches"]).split("\n");
const files = packOwnedFiles(tracked);
const projectFiles = PROJECT_OWNED_FILES.filter((path) => tracked.includes(path));
const lock = JSON.parse(sourceFile("package-lock.json").toString("utf-8"));
const engineVersion: string = lock.packages["node_modules/@ai-hero/sandcastle"].version;

const clone = mkdtempSync(join(tmpdir(), "sandcastle-loop-"));
try {
  // The token rides in the remote URL of a clone deleted below.
  run("git", ["clone", "--quiet", `https://x-access-token:${token}@github.com/${PACK_REPO}.git`, clone]);
  const manifestPath = join(clone, "manifest.json");
  const previous: PackManifest | undefined = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf-8"))
    : undefined;

  // Drop what the last export put there, so a file deleted here is deleted in the pack.
  for (const path of previous?.files ?? []) rmSync(join(clone, path), { force: true });
  rmSync(join(clone, EXAMPLES_DIR), { recursive: true, force: true });

  for (const path of files) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), sourceFile(path));
  }
  mkdirSync(join(clone, EXAMPLES_DIR), { recursive: true });
  for (const path of projectFiles) writeFileSync(join(clone, EXAMPLES_DIR, basename(path)), sourceFile(path));

  const manifest: PackManifest = { engineVersion, sourceCommit, files, projectFiles };
  // Compare without the commit, or every export would differ by its own stamp.
  const contentChanged =
    run("git", ["status", "--porcelain", "--", ".", ":!manifest.json"], clone) !== "" ||
    JSON.stringify({ ...previous, sourceCommit: "" }) !== JSON.stringify({ ...manifest, sourceCommit: "" });
  if (contentChanged) publish(clone, manifestPath, manifest, previous);
  else console.log(`Nothing to export: the pack already matches ${sourceCommit.slice(0, 8)}.`);
} finally {
  rmSync(clone, { recursive: true, force: true });
}

/** Test the pack's new contents, then push them to the export branch and open or refresh its PR. */
function publish(clone: string, manifestPath: string, manifest: PackManifest, previous?: PackManifest): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log("Running the loop's tests in the pack…");
  run("node", ["--test", ".sandcastle/lib/"], clone);

  const commits = previous
    ? run("git", ["log", "--format=%h%x09%s", `${previous.sourceCommit}..${sourceCommit}`, "--", ...files])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ...subject] = line.split("\t");
          return { sha: sha!, subject: subject.join("\t") };
        })
    : [];
  const title = `Export from ${SOURCE_REPO.split("/")[1]} ${sourceCommit.slice(0, 8)}`;
  const body = exportPrBody({
    sourceRepo: SOURCE_REPO,
    sourceCommit,
    previousCommit: previous?.sourceCommit,
    commits,
  });

  run("git", ["checkout", "--quiet", "-B", EXPORT_BRANCH], clone);
  run("git", ["add", "--all"], clone);
  run(
    "git",
    ["-c", "user.name=sandcastle-export", "-c", "user.email=sandcastle-export@users.noreply.github.com", "commit", "--quiet", "-m", title],
    clone,
  );
  // The export branch is the pack's inbox, rebuilt from main each time.
  run("git", ["push", "--quiet", "--force", "origin", EXPORT_BRANCH], clone);

  const open = run("gh", ["pr", "list", "--repo", PACK_REPO, "--head", EXPORT_BRANCH, "--state", "open", "--json", "number", "--jq", ".[0].number"]);
  if (open) {
    run("gh", ["pr", "edit", open, "--repo", PACK_REPO, "--title", title, "--body", body]);
    console.log(`Refreshed https://github.com/${PACK_REPO}/pull/${open}`);
  } else {
    const url = run("gh", ["pr", "create", "--repo", PACK_REPO, "--head", EXPORT_BRANCH, "--base", "main", "--title", title, "--body", body]);
    console.log(`Opened ${url}`);
  }
}
