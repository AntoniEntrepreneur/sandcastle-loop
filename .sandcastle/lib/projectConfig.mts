// What the loop needs to know about the project it runs in. The values live in
// `.sandcastle/sandcastle.config.mts`, which belongs to the project: a pack
// update never overwrites it.

/** A download cache shared by every sandbox: `.sandcastle/cache/<name>` mounted at `sandboxPath`. */
export interface CacheMount {
  name: string;
  sandboxPath: string;
}

/** The project facts the loop reads. */
export interface ProjectConfig {
  /** Host command to start Docker when it does not answer; omit to fail immediately. */
  dockerStartCommand?: string;
  /**
   * Installs dependencies in a fresh sandbox before the agent starts, and again
   * before every check. One command, because Sandcastle runs the entries of a
   * hook list concurrently. It must leave the worktree clean: leftover changes
   * read as an interrupted agent, and Phase 0 refuses to pick the branch up.
   */
  setupCommand: string;
  /**
   * Reinstalls dependencies exactly as the lockfiles now say, without writing
   * them. Run before the merger agent starts, because a merge can change a
   * lockfile after the sandbox installed. Omit to skip.
   */
  refreshDepsCommand?: string;
  /** What "green" means for the repo, run after `setupCommand`. */
  checkCommand: string;
  /** Formatter run and committed before every check, so a format-only lint failure never costs an agent round; omit when there is none. */
  formatCommand?: string;
  /** Repo-relative files whose contents decide whether the sandbox image is current, `.sandcastle/Dockerfile` among them. */
  imageInputFiles: string[];
  /** Lockfiles that don't count toward a diff's size. */
  lockfiles: string[];
  /** Repo-relative test file paths that don't count toward the size that picks the reviewer model; omit to count everything. */
  testFiles?: RegExp[];
  /** Download caches shared between sandboxes; each must tolerate concurrent use. */
  cacheMounts: CacheMount[];
  /** Extra environment variables for every sandbox. */
  sandboxEnv: Record<string, string>;
  /** Repo-relative glossary whose `_Avoid_:` lines fill `{{AVOID_TERMS}}`; omit when there is none. */
  glossaryFile?: string;
  /**
   * Repo-relative Codex hooks file every Codex sandbox installs at user level
   * (lib/codex.mts): the sandbox never loads the repo's project `.codex/`. A
   * Codex role refuses to start without it, so its git guard always runs.
   */
  codexHooksFile?: string;
  /** Repo-relative folder of Codex `.rules` files installed the same way; omit when there are none. */
  codexRulesDir?: string;
}
