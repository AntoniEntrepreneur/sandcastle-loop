// What an export copies from this repo into the pack repo
// (AntoniEntrepreneur/sandcastle-loop), and what its PR says. Pure; export.mts
// reads git and writes the pack's clone.

/** Files the project owns: an update never overwrites them, so they travel only as examples. */
export const PROJECT_OWNED_FILES = [
  ".sandcastle/sandcastle.config.mts",
  ".sandcastle/project-notes.md",
  ".sandcastle/Dockerfile",
  ".sandcastle/CODING_STANDARDS.md",
];

/** The pack's record of what it holds, written to its root as `manifest.json`. */
export interface PackManifest {
  /** The exact `@ai-hero/sandcastle` version the loop and its patch were built against. */
  engineVersion: string;
  /** Commit of the source repo this export was taken from. */
  sourceCommit: string;
  /** Pack-owned paths, as they sit in a project. */
  files: string[];
  /** Project-owned paths, shipped under `examples/<project>/` as starting points. */
  projectFiles: string[];
}

/**
 * The tracked paths an export copies as pack-owned: everything under
 * `.sandcastle/` the project doesn't own, and the engine patch.
 */
export function packOwnedFiles(tracked: string[]): string[] {
  return tracked
    .filter(
      (path) =>
        (path.startsWith(".sandcastle/") && !PROJECT_OWNED_FILES.includes(path)) ||
        /^patches\/@ai-hero\+sandcastle\+[^/]+\.patch$/.test(path),
    )
    .sort();
}

/** The PR body for an export: where it came from and the commits it carries. */
export function exportPrBody(input: {
  sourceRepo: string;
  sourceCommit: string;
  previousCommit?: string;
  commits: { sha: string; subject: string }[];
}): string {
  const { sourceRepo, sourceCommit, previousCommit, commits } = input;
  const from = `${sourceRepo}@${sourceCommit.slice(0, 8)}`;
  const footer = "Merge with a squash; a merge to main is tagged with the next version.";
  if (previousCommit === undefined) return `First export, from ${from}.\n\n${footer}`;
  const intro = `Export from ${from}, since ${previousCommit.slice(0, 8)}.`;
  const list =
    commits.length === 0
      ? "No source commit touched the exported files; only the examples or manifest changed."
      : commits
          // A bare `#706` would link to the pack's own #706.
          .map(({ sha, subject }) => `- ${subject.replace(/#(\d+)/g, `${sourceRepo}#$1`)} (${sourceRepo}@${sha})`)
          .join("\n");
  return `${intro}\n\n## Source commits\n\n${list}\n\n${footer}`;
}
