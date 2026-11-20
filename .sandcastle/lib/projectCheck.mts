/** Own project verification, clean-tree reuse, and per-attempt check slots. */

import { checkFailureTail, isInstallRace } from "./groups.mts";

export interface ProjectCheckPorts {
  /** The tree id the check would test, or undefined when the worktree is dirty. */
  cleanTree(): string | undefined;
  /** Whether the check has already passed on this tree, in any sandbox or run. */
  isGreenTree(tree: string): boolean;
  /** Record that this tree passed the check. */
  recordGreenTree(tree: string): void;
  /** Run the check command in the prepared worktree. */
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Refresh installed dependencies before retrying a broken installation. */
  refreshDepsCommand?: string;
  /** Run one check attempt once the machine has room for it. */
  withCheckSlot<T>(work: () => Promise<T>): Promise<T>;
  /** Optional caller-owned evidence, consulted only for a clean uncached tree. */
  reuseTree?(tree: string): boolean;
}

export interface ProjectCheckOptions {
  /** Preserve the caller's setup and time limit verbatim. */
  command: string;
  tailChars: number;
  onCached?(): void;
  onStart?(): void;
  onRetry?(): void;
  onRefresh?(): void;
  onResult?(failure: string | undefined): void;
}

// Match diagnostic lines, never incidental mentions in test names or assertions.
const BROKEN_DEPENDENCIES = /^(?:[ \t]*code: ['"](?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)['"],?[ \t]*|npm (?:warn|WARN|error|ERR!) tar TAR_ENTRY_(?:ERROR|INVALID)(?:[ \t].*)?)\r?$/m;

/** Check the prepared worktree, returning failure output or remembering its clean tree. */
export async function checkProject(
  ports: ProjectCheckPorts,
  options: ProjectCheckOptions,
): Promise<string | undefined> {
  const tree = ports.cleanTree();
  if (tree !== undefined && ports.isGreenTree(tree)) {
    options.onCached?.();
    return undefined;
  }
  if (tree !== undefined && ports.reuseTree?.(tree)) {
    ports.recordGreenTree(tree);
    return undefined;
  }
  options.onStart?.();
  const attempt = () => ports.withCheckSlot(() => ports.exec(options.command));
  let result = await attempt();
  if (result.exitCode !== 0 && ports.refreshDepsCommand !== undefined
    && (BROKEN_DEPENDENCIES.test(result.stdout) || BROKEN_DEPENDENCIES.test(result.stderr))) {
    options.onRefresh?.();
    await ports.exec(ports.refreshDepsCommand);
    result = await attempt();
  } else if (result.exitCode !== 0 && isInstallRace(result.stdout, result.stderr)) {
    options.onRetry?.();
    result = await attempt();
  }
  const failure = checkFailureTail(result.exitCode, result.stdout, result.stderr, options.tailChars);
  if (failure === undefined && tree !== undefined) ports.recordGreenTree(tree);
  options.onResult?.(failure);
  return failure;
}
