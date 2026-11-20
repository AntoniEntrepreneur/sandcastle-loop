// The integration branch's pipeline: sync with base, merge finished issue
// branches, repair conflicts or check failures with the merger agent, assert
// green, and draft the batch's PR body with the PR writer agent.
//
// Everything that touches the SDK, Docker or the check runner arrives as a
// port, so the pipeline is tested with fakes and main.mts wires the real
// functions in — the same split as lib/issueLoop.mts.

import type { AgentProvider, IterationResult } from "@ai-hero/sandcastle";

import {
  cleanTree,
  doneIssues,
  isBehind,
  markPrWritten,
  mergeEach,
  readyToMerge,
  recordedPr,
  resolveCommit,
} from "./gitFacts.mts";
import { AGENT_IDLE_TIMEOUT_SECONDS, type WrittenPr } from "./groups.mts";
import {
  BranchStateError,
  mergerFailureVerdict,
  RunFatalError,
  throwIfRunFatal,
} from "./issueLoop.mts";
import { checkProject } from "./projectCheck.mts";
import { extractPrBody, extractPrTitle } from "./promptInputs.mts";
import type { RoleAgent, RolePlan } from "./rolePlan.mts";
import type { BatchRole, RunState } from "./runState.mts";

/** An issue as the merge step names it: its number, title and branch. */
export type MergeCandidate = { id: string; title: string; branch: string };

/** What one batch agent's run tells the pipeline. */
export interface BatchAgentRun {
  readonly stdout: string;
  /** Passed straight to the usage report; the pipeline reads nothing in them. */
  readonly iterations: readonly IterationResult[];
}

/** The sandbox open on the integration branch: Docker, the SDK and the shell. */
export interface IntegrationSandboxPort {
  /** Host path to the integration branch's worktree. */
  readonly worktreePath: string;
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  run(request: {
    name: BatchRole;
    maxIterations?: number;
    idleTimeoutSeconds?: number;
    agent: AgentProvider;
    promptFile: string;
    promptArgs: Record<string, string>;
  }): Promise<BatchAgentRun>;
  /** Tear the sandbox down; whatever it reports is not read. */
  close(): Promise<unknown>;
}

export interface IntegrationSandboxPorts {
  /** Open the sandbox on `branch`. Called once, on first use. */
  openSandbox(branch: string): Promise<IntegrationSandboxPort>;
  /** The SDK agent a role's plan names. */
  agentFor(role: RoleAgent): AgentProvider;
  /** Run the check once the machine has room for one; `onWait` reports a wait. */
  withCheckSlot<T>(work: () => Promise<T>, onWait: () => void): Promise<T>;
  /** Whether CI has already passed on this exact tree, which stands in for a check. */
  ciHasPassedBase(tree: string): boolean;
  /** Green trees and batch-role labels, shared with the rest of the run. */
  runState: RunState;
  /** Record a batch role's token use for the run report. */
  recordRoleUsage(role: BatchRole, agent: RoleAgent, iterations: readonly IterationResult[]): void;
}

export interface IntegrationSandboxOptions {
  /** The orchestrator's own checkout, where branch facts are read. */
  cwd: string;
  /** What this PR is built on, e.g. `origin/main`. */
  baseRef: string;
  check: {
    /** What the sandbox runs, already wrapped in its setup and time limit. */
    command: string;
    /** What a log line or the owner-facing error calls it, e.g. `make test && make lint`. */
    label: string;
    /** How much of a red check's output is kept. */
    tailChars: number;
  };
  /**
   * Reinstalls dependencies from the lockfiles as they now are. The sandbox
   * installs once, when it opens; a merge can then bring in a changed lockfile,
   * and the merger agent running `make test` itself would meet packages that
   * are missing. Run before the agent starts; a failure is logged, not fatal.
   */
  refreshDepsCommand?: string;
  /** The prompt files the merger and the PR writer are given. */
  prompts: { merge: string; pr: string };
  rolePlan: RolePlan;
  /** Called with a message for the operator log. */
  log?: (message: string) => void;
}

/** A check still red after the merger agent's turn gets exactly one more. */
const MAX_MERGER_TURNS = 2;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

/**
 * One sandbox on the group's integration branch, opened on first use and kept
 * for the rest of the group, so its install is paid once rather than per merge.
 */
export class IntegrationSandbox {
  #sandbox: IntegrationSandboxPort | undefined;
  #knownGreen = false;
  readonly #ports: IntegrationSandboxPorts;
  readonly #options: IntegrationSandboxOptions;
  readonly #log: (message: string) => void;

  readonly branch: string;

  constructor(
    branch: string,
    ports: IntegrationSandboxPorts,
    options: IntegrationSandboxOptions,
  ) {
    this.branch = branch;
    this.#ports = ports;
    this.#options = options;
    this.#log = options.log ?? (() => {});
  }

  async #open(): Promise<IntegrationSandboxPort> {
    this.#sandbox ??= await this.#ports.openSandbox(this.branch);
    return this.#sandbox;
  }

  /** Run the project's check, unless this exact tree already passed it; the tail of its output if it failed. */
  async #check(): Promise<string | undefined> {
    const { check, baseRef } = this.#options;
    const sandbox = await this.#open();
    const failure = await checkProject({
      cleanTree: () => cleanTree(sandbox.worktreePath),
      isGreenTree: (tree) => this.#ports.runState.isGreenTree(tree),
      recordGreenTree: (tree) => this.#ports.runState.recordGreenTree(tree),
      exec: (command) => sandbox.exec(command),
      refreshDepsCommand: this.#options.refreshDepsCommand,
      withCheckSlot: (work) => this.#ports.withCheckSlot(
        work,
        () => this.#log(`${this.branch} is waiting for a free check slot…`),
      ),
      reuseTree: (tree) => {
        if (!this.#ports.ciHasPassedBase(tree)) return false;
        this.#log(`${this.branch} is exactly ${baseRef}, which CI has passed — not checking it again.`);
        return true;
      },
    }, {
      command: check.command,
      tailChars: check.tailChars,
      onCached: () => this.#log(`${this.branch} already passed ${check.label} at this tree — not checking it again.`),
      onStart: () => this.#log(`Checking ${this.branch} with ${check.label}…`),
      onRefresh: () => this.#log(`${this.branch} has broken dependencies — refreshing and checking again.`),
      onRetry: () => this.#log(`${this.branch} lost an npm cache race with another sandbox — checking again.`),
    });
    this.#knownGreen = failure === undefined;
    return failure;
  }

  /** Bring the sandbox's installed dependencies level with the merged lockfiles. */
  async #refreshDeps(sandbox: IntegrationSandboxPort): Promise<void> {
    const command = this.#options.refreshDepsCommand;
    if (command === undefined) return;
    const result = await sandbox.exec(command);
    if (result.exitCode !== 0) {
      this.#log(`  refreshing dependencies failed (exit ${result.exitCode}) — the merger agent starts anyway`);
    }
  }

  /**
   * Refuse to start agents on a red integration branch. Each of them would meet
   * the same failure, take it for its own, and spend its turn on it: after #435
   * shipped a broken import, every merger rediscovered and re-fixed it on its
   * own branch until main was repaired by hand.
   */
  async assertGreen(): Promise<void> {
    if (this.#knownGreen) return;
    const failure = await this.#check();
    if (failure === undefined) return;
    throw new BranchStateError(
      `${this.branch} fails ${this.#options.check.label} before any agent has worked on it. Fix it by hand — on main, if the branch was cut from a red main — then re-run Sandcastle.\n\n${failure}`,
    );
  }

  /**
   * Merge finished issue branches into the integration branch.
   *
   * git does the merging and the sandbox runs the checks; an agent is called
   * only when one of them fails — a conflict to resolve, or branches that
   * merge cleanly but are red together because siblings built in parallel
   * broke each other. Throws when the agent leaves either problem behind, so a
   * red batch is never published.
   *
   * An issue whose merge is already on the integration branch is skipped
   * rather than merged again: its Done marker is reachable from the branch, so
   * git has already recorded the merge this step would make (#995). The
   * callers' `readyToMerge` filter usually hands over no such issue, so this
   * is the guard for a resumed run that does.
   */
  async merge(issues: MergeCandidate[]): Promise<void> {
    if (issues.length === 0) return;
    const alreadyMerged = new Set(doneIssues(this.#options.cwd, this.branch));
    const toMerge: MergeCandidate[] = [];
    for (const issue of issues) {
      if (alreadyMerged.has(Number(issue.id))) {
        this.#log(`Merger for #${issue.id} skipped — its merge is already on the integration branch.`);
        continue;
      }
      toMerge.push(issue);
    }
    if (toMerge.length === 0) return;

    await this.#mergeAndRepair(
      toMerge.map((issue) => issue.branch),
      toMerge.map((issue) => `- ${issue.id}: ${issue.title}`).join("\n"),
      () =>
        readyToMerge(
          this.#options.cwd,
          this.branch,
          toMerge.map((issue) => ({ issueNumber: Number(issue.id), branch: issue.branch })),
        ),
    );
  }

  /**
   * Merge the pushed copy of the integration branch into it when the two have
   * diverged: something pushed to `origin` that this machine lacks, while this
   * machine holds commits the push lacks. A copy that is merely ahead was
   * already fast-forwarded by the caller, so only a divergence reaches here.
   * Conflicts and red checks go to the merger agent exactly as an issue
   * merge's do. A no-op — no sandbox opened — when the pushed copy holds
   * nothing this branch lacks, or there is none. True when it merged.
   *
   * Like `syncWithBase`, it merges the commit the remote ref named when this
   * started, so a later fetch cannot move the target under the merger.
   */
  async mergeRemoteCopy(issueList: string): Promise<boolean> {
    const { cwd } = this.#options;
    const remoteRef = `origin/${this.branch}`;
    if (!isBehind(cwd, this.branch, remoteRef)) return false;
    const pinned = resolveCommit(cwd, remoteRef);
    if (pinned === undefined) return false;
    const label = `${remoteRef} (${pinned.slice(0, 8)})`;
    this.#log(`\n${this.branch} has diverged from ${remoteRef} — merging the pushed copy in…`);
    await this.#mergeAndRepair(
      [pinned],
      issueList,
      () => (isBehind(cwd, this.branch, pinned) ? [pinned] : []),
      () => label,
    );
    this.#log(`${this.branch} now includes ${label}.`);
    return true;
  }

  /**
   * Merge the base ref into the integration branch when main has moved on since
   * the branch was cut, so this PR is rebuilt on what has already shipped
   * rather than conflicting with it at merge time. Conflicts and red checks go
   * to the merger agent exactly as an issue merge's do. A no-op — no sandbox
   * opened — for a branch already level with main. True when it merged.
   *
   * The merge and the "is it caught up?" check both use the commit the base ref
   * named when this started. A fetch elsewhere can move the ref while the merger
   * runs, and checking the live ref then failed a merge that had worked; the
   * newer commits are left for the next run to merge.
   */
  async syncWithBase(issueList: string): Promise<boolean> {
    const { cwd, baseRef } = this.#options;
    if (!isBehind(cwd, this.branch, baseRef)) return false;
    const pinned = resolveCommit(cwd, baseRef);
    if (pinned === undefined) return false;
    const label = `${baseRef} (${pinned.slice(0, 8)})`;
    this.#log(`\n${this.branch} is behind ${label} — merging it in…`);
    await this.#mergeAndRepair(
      [pinned],
      issueList,
      () => (isBehind(cwd, this.branch, pinned) ? [pinned] : []),
      () => label,
    );
    this.#log(`${this.branch} is up to date with ${label}.`);
    return true;
  }

  /**
   * git merges `branches`, the sandbox checks the result, and the merger agent
   * is called only for a conflict or a red check. A check still red after that
   * turn, with nothing left unmerged, gets the merger agent once more with the
   * new output. `stillUnmergedAfter` names what the agent failed to merge;
   * anything left there, or a check still red after the second turn, throws.
   * `labelFor` names a merged ref in logs and in the merger's prompt.
   */
  async #mergeAndRepair(
    branches: string[],
    issueList: string,
    stillUnmergedAfter: () => string[],
    labelFor: (ref: string) => string = (ref) => ref,
  ): Promise<void> {
    const sandbox = await this.#open();
    const { merger } = this.#options.rolePlan;

    const { merged, conflicted, conflictFiles } = mergeEach(sandbox.worktreePath, branches);
    const conflictLine = (branch: string) =>
      `${labelFor(branch)} (in ${conflictFiles[branch]?.join(", ") || "unknown files"})`;
    for (const branch of merged) this.#log(`  merged ${labelFor(branch)}`);
    for (const branch of conflicted) this.#log(`  ${conflictLine(branch)} conflicts — handing it to the merger agent`);

    // With a conflict outstanding the agent runs the checks itself once it has
    // resolved it, so checking the half-merged batch here would be wasted.
    let failure = conflicted.length === 0 ? await this.#check() : undefined;
    if (conflicted.length === 0 && failure === undefined) return;

    this.#knownGreen = false;
    await this.#refreshDeps(sandbox);
    for (let turn = 0; turn < MAX_MERGER_TURNS; turn++) {
      const isFirstTurn = turn === 0;
      try {
        const result = await sandbox.run({
          name: "merger",
          maxIterations: 1,
          idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
          agent: this.#ports.agentFor(merger),
          promptFile: this.#options.prompts.merge,
          promptArgs: {
            CONFLICTED:
              isFirstTurn && conflicted.length > 0
                ? conflicted.map((branch) => `- ${conflictLine(branch)}`).join("\n")
                : "(none — every branch merged cleanly)",
            ISSUES: issueList,
            CHECK_OUTPUT: failure ?? "(not run yet — run them yourself once the merges are done)",
          },
        });
        this.#ports.runState.recordBatchRole("merger", merger.label);
        this.#ports.recordRoleUsage("merger", merger, result.iterations);
        throwIfRunFatal(result.stdout);
      } catch (error) {
        if (error instanceof RunFatalError) throw error;
        if (mergerFailureVerdict(error) === "rethrow") {
          throwIfRunFatal(errorText(error));
        }
        // Idle timeout or another local failure: its committed merges may be
        // finished, so the branch-state checks below decide.
        this.#log(`  the merger agent failed (${errorText(error).slice(0, 200)}) — judging it by what it left`);
      }

      const stillUnmerged = stillUnmergedAfter();
      const stillRed = await this.#check();
      if (stillUnmerged.length === 0 && stillRed === undefined) return;

      if (isFirstTurn && stillUnmerged.length === 0 && stillRed !== undefined) {
        failure = stillRed;
        this.#log(`  ${this.branch} still fails ${this.#options.check.label} — giving the merger agent one more turn`);
        continue;
      }

      throw new BranchStateError(
        [
          `The merger agent left ${this.branch} unfinished. Nothing was pushed; resolve it by hand, then re-run Sandcastle.`,
          stillUnmerged.length > 0 ? `Still unmerged: ${stillUnmerged.map(labelFor).join(", ")}` : "",
          stillRed ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  }

  /**
   * Have the PR writer draft the reviewer-facing title and body with the `pr`
   * skill.
   *
   * Only called once the group is complete: a draft is not worth a reviewer's
   * time, so it is not worth an agent's either. Undefined when the writer
   * fails or writes no body, and the PR falls back to the generated body — a
   * missing writeup is no reason to hold back a finished batch. A body with no
   * title leaves the title to the generated one.
   *
   * A PR already written for the branch's current commit is returned as it
   * stands, without starting the writer again (#995); any commit since then
   * leaves the marker behind HEAD and the writer runs.
   */
  async writePr(issueList: string): Promise<WrittenPr | undefined> {
    const { prWriter } = this.#options.rolePlan;
    const recorded = recordedPr(this.#options.cwd, this.branch);
    if (recorded !== undefined) {
      this.#log("PR writer skipped — its PR body is still current.");
      return recorded;
    }
    this.#log(`\nWriting the PR body for ${this.branch} with the pr skill…`);
    try {
      const sandbox = await this.#open();
      const result = await sandbox.run({
        name: "pr-writer",
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
        agent: this.#ports.agentFor(prWriter),
        promptFile: this.#options.prompts.pr,
        promptArgs: { ISSUES: issueList, BASE_REF: this.#options.baseRef },
      });
      this.#ports.runState.recordBatchRole("pr-writer", prWriter.label);
      this.#ports.recordRoleUsage("pr-writer", prWriter, result.iterations);
      throwIfRunFatal(result.stdout);
      const body = extractPrBody(result.stdout);
      if (body === undefined) {
        this.#log("  the PR writer output no body — keeping the generated one");
        return undefined;
      }
      const title = extractPrTitle(result.stdout);
      const pr = title ? { title, body } : { body };
      // The marker is a commit, so it must land before the branch is pushed.
      markPrWritten(sandbox.worktreePath, this.branch, pr);
      return pr;
    } catch (error) {
      if (error instanceof RunFatalError) throw error;
      throwIfRunFatal(errorText(error));
      this.#log(`  the PR writer failed (${errorText(error).slice(0, 200)}) — keeping the generated body`);
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.#sandbox?.close();
  }
}
