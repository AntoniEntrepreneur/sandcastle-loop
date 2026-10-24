// Parallel Planner with Review — grouped, resumable orchestration loop
//
// A run works one **group** at a time, in sequence. A group is the set of open
// issues sharing a `sandcastle:<id>` label; an issue carrying the bare
// `sandcastle` label is a group of one. Each group gets its own integration
// branch and its own PR, so two unrelated specs never share a review.
//
// Per group:
//   Phase 0 (Sync + Pick up):   Merge origin/main into a resumed integration
//                               branch that main has moved on from, so the PR
//                               is rebuilt on what already shipped. Then merge
//                               `sandcastle/issue-<N>` branches belonging to
//                               THIS group that a prior run left finished.
//   Phase 1 (Plan):             Each remaining issue is checked against
//                               GitHub's own record of what blocks it — native
//                               issue dependencies, or a `Blocked by:` line in
//                               the body as a fallback. A blocker whose work is
//                               already on the integration branch counts as
//                               resolved, so a group that blocks itself drains
//                               over successive cycles rather than waiting for
//                               its own PR to merge. Anything still blocked is
//                               skipped, not attempted; there is no inferred
//                               dependency graph and no fallback candidate
//                               forced through when everything is blocked.
//   Phase 2 (Execute + Review): Per issue, a sandbox is created. The implementer
//                               is driven one iteration at a time so a dead run
//                               can be cut short; the reviewer follows if it
//                               committed. Issues run concurrently.
//   Phase 3 (Merge):            git merges the completed branches and the
//                               integration sandbox runs make test / make
//                               lint. An agent is called only for a conflict
//                               or a red result. Agents never start on a red
//                               integration branch.
//   Phase 4 (PR):               Push and open (or refresh) a DRAFT PR. It is
//                               marked ready for review only once the group has
//                               nothing planned, nothing blocked, and nothing
//                               stranded — and only then does an agent rewrite
//                               its body with the `pr` skill.
//
// A run is built to be killed. Quota exhaustion mid-run is the expected case,
// not an exception: whatever merged is pushed as a draft PR, and the next run
// resumes the same integration branch and grows the same PR.
//
// Usage:
//   npm run sandcastle              # every group and solo issue, in issue order
//   npm run sandcastle -- 244       # one group only
//   npm run sandcastle -- solo-365  # one solo issue only
//   npm run sandcastle -- refresh   # only merge main into every open batch PR
//   npm run sandcastle -- --overnight               # leave it running; see below
//   npm run sandcastle -- 244 --overnight --until 06:30
//   SANDCASTLE_DRY_RUN=1 npm run sandcastle
//   SANDCASTLE_WAIT_FOR_QUOTA=1 npm run sandcastle  # sleep through quota stops, no end time
//   SANDCASTLE_IGNORE_QUOTA_GATE=1 npm run sandcastle  # start before the recorded reset
//   SANDCASTLE_SOUND=0 npm run sandcastle           # no sound when the run ends
//   node --test .sandcastle/lib/    # unit tests for the logic below
//
// --overnight sleeps through quota stops (and a spent quota at startup) until
// the reset, but never past the end time — 04:00 local unless --until says
// otherwise. After the end time, agent runs already going finish and are merged
// and pushed; nothing new starts. A weekly limit or an empty credit balance
// still ends the run. It also keeps the Mac awake (lid open, on power) and
// mutes the end-of-run sound.
//
// The argument is always a group id, so what you can run by hand is decided by
// the admission label. An issue carrying the bare `sandcastle` label is the
// group `solo-<its number>`, which is how you name it above. An issue inside a
// `sandcastle:<id>` group has no handle of its own: the whole group is the
// smallest thing a run will take, and the siblings you did not want cost a
// sandbox each to report they have nothing to do.

import * as sandcastle from "@ai-hero/sandcastle";
import { defaultImageName, docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFile, execFileSync, execSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  catchUpWithRemote,
  doneIssues,
  isBatchBranchShipped,
  isBehind,
  isStale,
  markDone,
  mergeEach,
  readyToMerge,
  saveWorktree,
  unfinishedBranches,
  type IssueBranch,
} from "./lib/gitFacts.mts";
import {
  changedLines,
  chooseReviewerModel,
  diffPresentation,
  estimateTokens,
} from "./lib/reviewDiff.mts";
import {
  runIssueLoop,
  RunFatalError,
  throwIfRunFatal,
  BranchStateError,
  runFatalStop,
  type IssueLoopPorts,
  type RunResult,
} from "./lib/issueLoop.mts";
import { openRunState } from "./lib/runState.mts";
import { resumeRunOptions } from "./lib/resumeRun.mts";
import {
  extractAvoidTerms,
  extractPrBody,
  parentIssueNumber,
  renderIssueContext,
  type IssueText,
} from "./lib/promptInputs.mts";
import { IMAGE_HASH_LABEL, IMAGE_INPUT_FILES, computeImageHash } from "./lib/imageHash.mts";
import { formatUsageTable, logsToDelete, sessionUsage, type UsageRow } from "./lib/runReport.mts";
import { muteSounds, reportOutcome } from "./notify.mts";
import {
  nextClockTime,
  parseCommandLine,
  planQuotaWait,
  QUOTA_WAIT_MARGIN_MS,
  type CommandLine,
} from "./lib/overnight.mts";
import {
  batchBranchGlob,
  batchBranchName,
  buildPrBody,
  buildPrTitle,
  checkFailureTail,
  mergerFailureVerdict,
  withTimeLimit,
  DEAD_ITERATION_THRESHOLD,
  describeGroup,
  isGroupComplete,
  type FailureKind,
  isSettledWithNothingToDo,
  issueBranchName,
  issueNumberOfBranch,
  liveBlockers,
  parseBlockedByLine,
  partitionIntoGroups,
  quotaGate,
  shouldProbeQuota,
  type Group,
  type Issue,
} from "./lib/groups.mts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Plan→execute→merge cycles per group. The loop exists to pick up issues that
// a merge unblocks, so it needs to cover the depth of a dependency chain, not
// the size of the backlog — plus slack, because a cycle that produces no
// commits still spends one. The deepest chain on the board when this was last
// checked was four (#272,#273 → #277 → #278 → #279 under `sandcastle:262`), so
// four exactly would drain that group only if nothing went wrong on the way.
// Still deliberately small: with a finite quota, the constant that matters is
// the one that stops a wedged group eating the night. Cycles are not spent
// speculatively — the loop breaks as soon as nothing is plannable.
const MAX_ITERATIONS = 6;

// Upper bound on implementer iterations per issue. Driven one at a time from
// here rather than handed to maxIterations, so the circuit breaker below can
// stop a dead run instead of burning the remainder on container starts.
const MAX_IMPLEMENTER_ITERATIONS = 100;

// Hooks run inside the sandbox before the agent starts. The agent's feedback
// loop is `make test` / `make lint`, so all three toolchains it reaches for —
// root node, frontend node, and the Python env uv manages — must be present, or
// the loop fails in a way the agent will read as a broken repo.
// Every sandbox installs from cold, and the 60s default is a budget for a
// top-up rather than an install. A hook that times out throws the whole group
// away *after* the agents have done their expensive work. Slow is recoverable;
// dead is not — and this one budget now covers the whole chain below, which
// runs in sequence rather than three installs racing each other.
const HOOK_TIMEOUT_MS = 20 * 60 * 1000;

// One command, not four. Sandcastle runs the entries of a hook list
// concurrently, so a reset listed after the installs does not follow them: it
// finished first, npm rewrote frontend/package-lock.json behind it, and every
// sandbox handed its agent a worktree that was already dirty.
//
// That dirt is indistinguishable from an interrupted agent, so Phase 0 refuses
// to pick the branch up — permanently, since every run redoes the same
// install. Finished commits then never reach a PR, and `gh pr merge` cannot
// clean up the worktree afterwards. Setup must leave no trace; this all runs
// before the agent starts, so a lockfile change the agent genuinely intends is
// unaffected.
//
// The image ships the dependency trees outside the worktree (see Dockerfile);
// the first two steps link them in, so the installs below only top up whatever
// an agent changed. UV_PROJECT_ENVIRONMENT in the image points `uv sync` at the
// prebuilt venv.
const SETUP_COMMAND = [
  "rm -rf node_modules frontend/node_modules",
  "ln -s /home/agent/deps/node_modules node_modules",
  "ln -s /home/agent/deps/frontend-node_modules frontend/node_modules",
  "npm install",
  "npm install --prefix frontend",
  "uv sync",
  "git checkout -- package-lock.json frontend/package-lock.json",
].join(" && ");

const hooks = {
  sandbox: {
    onSandboxReady: [{ command: SETUP_COMMAND, timeoutMs: HOOK_TIMEOUT_MS }],
  },
};

// What "the integration branch is green" means. The setup is repeated first
// because a merge can change a lockfile, and on a warm sandbox it is a top-up.
const CHECK_COMMAND = `${SETUP_COMMAND} && make test && make lint`;

// How much of a failed check's output is kept, for a log line or a prompt. The
// end is where pytest, vitest and eslint print what failed.
const CHECK_OUTPUT_TAIL_CHARS = 6000;

// Nothing is copied from the host. node_modules was, to make the hooks above a
// top-up rather than a cold install, but the host is Darwin arm64 and the
// sandbox is Linux aarch64: the tree carries platform-specific binaries like
// @rollup/rollup-darwin-arm64 that are wrong inside the container. npm has to
// reconcile them, and that reconciliation rewrote the lockfiles on a good day
// and died with ENOTEMPTY on a bad one.
//
// What is shared instead is the download caches, which hold tarballs and
// Linux wheels rather than an installed tree, so every sandbox's install
// still runs cold against its own platform but stops re-downloading. Both
// caches are safe to share between concurrent sandboxes: npm's is
// content-addressed and uv locks its own. uv cannot hardlink across the bind
// mounts, so it is told to copy rather than warn about falling back to it.
const CACHE_DIR = ".sandcastle/cache";
const runState = openRunState(CACHE_DIR);

function sandboxProvider() {
  const npmCache = join(CACHE_DIR, "npm");
  const uvCache = join(CACHE_DIR, "uv");
  mkdirSync(npmCache, { recursive: true });
  mkdirSync(uvCache, { recursive: true });
  return docker({
    mounts: [
      { hostPath: npmCache, sandboxPath: "/home/agent/.npm" },
      { hostPath: uvCache, sandboxPath: "/home/agent/.cache/uv" },
    ],
    // The backend suite outlasts Claude Code's 2-minute Bash default, which
    // moved it to the background: agents then polled it with `sleep` loops,
    // and some went silent long enough for the 600s idle timeout to kill them.
    // Commands now stay in the foreground, with 8 minutes to finish — under
    // that idle timeout.
    env: {
      UV_LINK_MODE: "copy",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      BASH_DEFAULT_TIMEOUT_MS: String(8 * 60 * 1000),
    },
  });
}

// The host repo, bound once — every gitFacts call reads and writes this repo's
// local branches (issue and integration branches are never worktree-specific:
// git refs are shared across a repo's worktrees), so there is nothing to gain
// by re-reading REPO_CWD at each call site.
const REPO_CWD = process.cwd();

const BASE_BRANCH = "main";

// Every git comparison against the base uses the remote's copy, fetched per
// group. The run never checks anything out on the host, so it cannot `git pull`
// the local branch, and a stale local main would make shipped work look new.
const BASE_REF = `origin/${BASE_BRANCH}`;

const DRY_RUN = process.env.SANDCASTLE_DRY_RUN === "1";

let commandLine: CommandLine;
try {
  commandLine = parseCommandLine(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// Quota gate (#506): a run started before the saved reset refuses unless
// IGNORE is set; waiting makes the gate and a quota stop sleep until the reset.
const IGNORE_QUOTA_GATE = process.env.SANDCASTLE_IGNORE_QUOTA_GATE === "1";
const OVERNIGHT = commandLine.overnight;
const WAIT_FOR_QUOTA = OVERNIGHT || process.env.SANDCASTLE_WAIT_FOR_QUOTA === "1";

/** When an overnight run stops starting agents; undefined for any other run. */
const END_AT = commandLine.until ? nextClockTime(commandLine.until, new Date()) : undefined;

/** True once the end time has passed. */
function pastEndTime(): boolean {
  return END_AT !== undefined && Date.now() >= END_AT.getTime();
}

/**
 * Hold off idle sleep for as long as this process lives. A sleeping Mac freezes
 * Docker, so an unattended run would just stop. `-w` ends caffeinate with us.
 */
function keepAwake(): void {
  if (process.platform !== "darwin") return;
  const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  child.on("error", () => {
    console.warn("\nWarning: could not start caffeinate — the Mac may sleep and pause the run.");
  });
  child.unref();
}

if (OVERNIGHT) {
  muteSounds();
  if (!DRY_RUN) keepAwake();
}

/** A reset time as the developer's local clock reads it. */
function localTime(at: Date): string {
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Fetch an issue and its comments on the host, as JSON. */
function fetchIssueText(number: number): IssueText & { comments: string[] } {
  const raw = JSON.parse(
    sh(`gh issue view ${Number(number)} --json number,title,body,comments`),
  ) as IssueText & { comments: { body: string }[] };
  return { ...raw, comments: raw.comments.map((c) => c.body) };
}

/** The issue, its comments and its parent spec, rendered for the implementer prompt. */
function issueContextFor(number: number): string {
  const issue = fetchIssueText(number);
  const parentNumber = parentIssueNumber(issue.body);
  return renderIssueContext({
    issue,
    parent: parentNumber === undefined ? undefined : fetchIssueText(parentNumber),
  });
}

/**
 * The prompt files as they were when this run started.
 *
 * This script is loaded once, but the SDK reads a prompt file from disk at
 * every run() call. A prompt edited mid-run therefore met code that predated
 * it: a new {{PLACEHOLDER}} with no promptArg failed every agent for the rest
 * of the run. Copying them here keeps code and prompts from the same moment.
 */
const PROMPTS_DIR = mkdtempSync(join(tmpdir(), "sandcastle-prompts-"));
const PROMPTS = (() => {
  const dir = PROMPTS_DIR;
  const snapshot = (name: string) => {
    const copy = join(dir, name);
    copyFileSync(join(".sandcastle", name), copy);
    return copy;
  };
  return {
    implement: snapshot("implement-prompt.md"),
    review: snapshot("review-prompt.md"),
    merge: snapshot("merge-prompt.md"),
    pr: snapshot("pr-prompt.md"),
  };
})();

const REQUESTED_GROUP = commandLine.group;

// ---------------------------------------------------------------------------
// Run visibility: saved console log, log pruning, token-use table
// ---------------------------------------------------------------------------

const LOGS_DIR = join(".sandcastle", "logs");
mkdirSync(LOGS_DIR, { recursive: true });

// Delete logs older than 30 days before this run adds its own.
try {
  const files = readdirSync(LOGS_DIR).flatMap((name) => {
    try {
      const stat = statSync(join(LOGS_DIR, name));
      return stat.isFile() ? [{ name, mtimeMs: stat.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
  for (const name of logsToDelete(files, Date.now())) rmSync(join(LOGS_DIR, name), { force: true });
} catch {
  // Pruning is housekeeping; never let it stop a run.
}

// Copy everything the orchestrator prints into a timestamped log of its own.
const RUN_LOG = join(LOGS_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    try {
      appendFileSync(RUN_LOG, typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array));
    } catch {
      // A log that cannot be written must not break the run.
    }
    return write(chunk, ...rest);
  }) as typeof stream.write;
}

/** Tokens used by every agent step this run, for the table printed at exit. */
const usageRows: UsageRow[] = [];
const RUN_STARTED_MS = Date.now();
/** Assistant message ids already in usageRows; a resumed session repeats them. */
const countedMessages = new Set<string>();

/** Record the token use of one finished agent step from its captured session. */
function recordUsage(issue: string, role: string, iterations: readonly { sessionFilePath?: string }[]): void {
  for (const { sessionFilePath } of iterations) {
    if (!sessionFilePath) continue;
    let jsonl: string;
    try {
      jsonl = readFileSync(sessionFilePath, "utf-8");
    } catch {
      continue;
    }
    usageRows.push({ issue, role, ...sessionUsage(jsonl, RUN_STARTED_MS, countedMessages) });
  }
}

// One exit handler covers every way a run ends — success, empty, failed,
// interrupted: print the usage table, then remove the prompt snapshot.
process.on("exit", () => {
  try {
    console.log(`\nToken use this run:\n${formatUsageTable(usageRows)}`);
  } catch {
    // Reporting must not mask what actually went wrong.
  }
  try {
    rmSync(PROMPTS_DIR, { recursive: true, force: true });
  } catch {
    // The temp folder is litter, not state.
  }
});

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/** Run a command and return its trimmed stdout. */
function sh(command: string): string {
  return execSync(command, { encoding: "utf-8" }).trim();
}

/** Run a command, returning its stdout or undefined if it failed. */
function shQuiet(command: string): string | undefined {
  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

/** Run `gh` with these args, returning its trimmed stdout or undefined if it failed. */
async function ghQuiet(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", args, { encoding: "utf-8" });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Split git's newline-delimited branch output into names. */
function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Reject a group id that could not safely reach a shell or a branch name.
 *
 * Group ids come from label names, which a human writes; they are interpolated
 * into `gh` queries and git refs, so anything outside this set is refused
 * rather than escaped.
 */
function assertSafeGroupId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `Unsafe Sandcastle group id ${JSON.stringify(id)}. Group ids may contain letters, digits, dot, dash and underscore only.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

/** Fetch every open issue with its labels and body, in one call. */
function fetchOpenIssues(): Issue[] {
  const json = sh(
    `gh issue list --state open --limit 200 --json number,title,body,labels`,
  );
  const raw = JSON.parse(json) as {
    number: number;
    title: string;
    body: string;
    labels: { name: string }[];
  }[];
  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((label) => label.name),
  }));
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Open issue numbers currently blocking this issue — the deterministic
 * replacement for a planner inferring dependencies from issue text.
 *
 * Native GitHub issue dependencies (docs/agents/issue-tracker.md:42) are the
 * primary signal, checked against every open issue in the repo, not just
 * Sandcastle-labelled ones: a dependency is real regardless of whether its
 * blocker happens to carry a Sandcastle label. A `Blocked by: #<n>` line at
 * the top of the body is the documented fallback, used only when the native
 * check finds nothing — and only for blockers that are themselves still open,
 * since a stale `Blocked by:` line naming a closed issue is not a live block.
 *
 * GET on `dependencies/blocked_by` (the docs only show POST, for adding an
 * edge) returns a JSON array of the blocking issues, each with a `state` and
 * `number` — confirmed against a real edge: `gh api
 * repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by --paginate --jq
 * '[.[] | select(.state=="open") | .number]'` returned `[345]` for an issue
 * with a single open native blocker, #345.
 *
 * Async so a group's issues are asked about at once: it is one round trip to
 * GitHub per issue, every cycle, and in sequence those added up.
 */
async function fetchBlockers(issue: Issue): Promise<number[]> {
  const native = await ghQuiet([
    "api",
    `repos/{owner}/{repo}/issues/${issue.number}/dependencies/blocked_by`,
    "--paginate",
    "--jq",
    '[.[] | select(.state=="open") | .number]',
  ]);
  if (native !== undefined) {
    const numbers = JSON.parse(native.length > 0 ? native : "[]") as number[];
    if (numbers.length > 0) return numbers;
  }

  const candidates = parseBlockedByLine(issue.body);
  const open = await Promise.all(candidates.map(isIssueOpen));
  return candidates.filter((_, i) => open[i]);
}

/** Whether an issue is still open, for validating a `Blocked by:` fallback line. */
async function isIssueOpen(issueNumber: number): Promise<boolean> {
  const state = await ghQuiet(["issue", "view", String(issueNumber), "--json", "state", "--jq", ".state"]);
  return state === "OPEN";
}

// ---------------------------------------------------------------------------
// Branch bookkeeping, scoped to one group
// ---------------------------------------------------------------------------

/** List local branches matching a glob. */
function branchesMatching(glob: string): string[] {
  return lines(
    sh(`git branch --list "${glob}" --sort=-committerdate --format="%(refname:short)"`),
  );
}

/** Count commits on `branch` that `ref` does not already contain. */
function commitsAhead(ref: string, branch: string): number {
  return Number(sh(`git rev-list --count ${ref}..${branch}`));
}

/** The group's issues, described as {issueNumber, branch} pairs for gitFacts. */
function groupIssueBranchDescriptors(group: Group): IssueBranch[] {
  return group.issues.map((issue) => ({
    issueNumber: issue.number,
    branch: issueBranchName(issue.number),
  }));
}

/**
 * Merged PR head branches matching `glob`, for deciding whether a batch
 * branch shipped by squash merge rather than by ancestry. `gh` has no glob
 * search over head branch names, so every merged PR is fetched once and
 * filtered here.
 */
function fetchMergedPrHeadBranches(glob: string): string[] {
  const json = shQuiet(
    `gh pr list --state merged --limit 200 --json headRefName --jq '[.[].headRefName]'`,
  );
  if (json === undefined) return [];

  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`Unexpected 'gh pr list' output, expected a string array: ${json}`);
  }

  const pattern = new RegExp(
    `^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );
  return parsed.filter((branch) => pattern.test(branch));
}

/** Head branches of every open Sandcastle PR into BASE_BRANCH, for `refresh`. */
function openBatchPrBranches(): string[] {
  const json = sh(
    `gh pr list --state open --base ${BASE_BRANCH} --limit 100 --json headRefName --jq '[.[].headRefName]'`,
  );
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`Unexpected 'gh pr list' output, expected a string array: ${json}`);
  }
  return parsed.filter((branch) => branch.startsWith("sandcastle/batch-"));
}

/**
 * Resolve the integration branch for a group, resuming one if it exists.
 *
 * A run is resumable: a `sandcastle/batch-<id>-*` branch left by an earlier run
 * is continued so its work — and its PR — carry forward. A fresh branch is cut
 * from BASE_BRANCH only when this group has none outstanding. A branch counts
 * as shipped — and is never resumed — once BASE_REF has it as an ancestor, or
 * once a PR with that head branch has merged. The second case is what a squash
 * merge needs: it never makes the branch an ancestor of BASE_REF.
 *
 * A resumed branch is first caught up with its pushed copy, which may have
 * moved on without this machine — see catchUpWithRemote.
 */
function resolveIntegrationBranch(group: Group): string {
  execSync(`git fetch origin ${BASE_BRANCH}`, { stdio: "inherit" });
  const glob = batchBranchGlob(group.id);
  const mergedPrHeads = fetchMergedPrHeadBranches(glob);
  const outstanding = branchesMatching(glob).find(
    (branch) => !isBatchBranchShipped(REPO_CWD, branch, BASE_REF, mergedPrHeads),
  );

  // Neither branch is checked out on the host. Agents work on it in their own
  // worktree — see IntegrationSandbox — and git refuses a worktree for a
  // branch that is already checked out somewhere else.
  if (outstanding) {
    console.log(`\nResuming integration branch: ${outstanding}`);
    catchUpIntegrationBranch(outstanding);
    return outstanding;
  }

  const fresh = batchBranchName(group.id, Date.now());
  sh(`git branch ${fresh} ${BASE_REF}`);
  console.log(`\nCut integration branch: ${fresh}`);
  return fresh;
}

/**
 * Bring a resumed integration branch level with `origin`. A branch that never
 * reached `origin` has nothing to fetch, so a failed fetch is not an error.
 * Throws on divergence, which fails only this group: publishing would be
 * rejected anyway, and which side to keep is a human's call.
 */
function catchUpIntegrationBranch(branch: string): void {
  shQuiet(`git fetch --quiet origin ${branch}`);
  const outcome = catchUpWithRemote(REPO_CWD, branch, `origin/${branch}`);
  if (outcome === "fast-forwarded") {
    console.log(`Fast-forwarded ${branch} to origin/${branch}.`);
  }
  if (outcome === "diverged") {
    throw new Error(
      `${branch} and origin/${branch} have diverged: each has commits the other lacks. Merge or reset one onto the other by hand, then re-run Sandcastle.`,
    );
  }
}

/**
 * Which of the group's issues does the integration branch already cover?
 *
 * Driven by Done markers reachable from the integration branch, not by
 * ancestry or commit counts: an issue is merged once the orchestrator marked
 * it done, whether or not its branch produced a diff.
 */
function resolveMergedIssues(
  group: Group,
  integrationBranch: string,
): { id: string; title: string; branch: string }[] {
  const titles = new Map(group.issues.map((i) => [i.number, i.title]));

  return doneIssues(REPO_CWD, integrationBranch)
    .filter((number) => titles.has(number))
    .map((number) => ({
      id: String(number),
      title: titles.get(number) ?? `Issue #${number}`,
      branch: issueBranchName(number),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** Host path of the worktree Sandcastle keeps for a branch. */
function worktreePathOf(branch: string): string {
  return `.sandcastle/worktrees/${branch.replace(/\//g, "-")}`;
}

/** Whether a branch's worktree has uncommitted changes mid-edit. */
function worktreeIsDirty(branch: string): boolean {
  const status = shQuiet(`git -C ${worktreePathOf(branch)} status --porcelain`);
  // No worktree checked out for this branch means nothing is mid-edit.
  return status !== undefined && status.length > 0;
}

/**
 * Commit whatever a killed process left mid-edit in the group's issue
 * worktrees, before Phase 0 even looks at them. Nothing else runs between a
 * Ctrl-C and the next invocation of Sandcastle, so this is the only point
 * that ever sees that dirt.
 */
function saveDirtyWorktreesAtGroupStart(group: Group): void {
  for (const issue of group.issues) {
    const branch = issueBranchName(issue.number);
    const worktree = worktreePathOf(branch);
    if (!existsSync(worktree)) continue;
    if (!worktreeIsDirty(branch)) continue;

    if (saveWorktree(worktree, issue.number, "found-dirty-at-start")) {
      console.log(
        `Saved #${issue.number}: ${branch} was left dirty by an interrupted run.`,
      );
    }
  }
}

/**
 * Recreate an issue branch left pointing at content already on BASE_REF —
 * e.g. commits later squash-merged (#253, #258, #355, #356). Safe because a
 * stale branch holds nothing BASE_REF lacks.
 *
 * A dirty worktree is saved first rather than recreated out from under it:
 * the save gives the branch content of its own, so it is no longer stale —
 * it is kept, and called out by name here rather than left to the generic
 * "no Done marker yet" warning `warnAboutUnfinishedBranches` would otherwise
 * give it.
 */
function recreateStaleBranches(
  planned: { id: string; branch: string }[],
  integrationBranch: string,
): void {
  for (const { id, branch } of planned) {
    if (branchesMatching(branch).length === 0) continue;
    if (!isStale(REPO_CWD, branch, BASE_REF)) continue;

    if (worktreeIsDirty(branch)) {
      const worktree = worktreePathOf(branch);
      if (saveWorktree(worktree, Number(id), "found-dirty-at-start")) {
        console.warn(
          `#${id}: ${branch} was stale AND mid-edit — saved its loose changes instead of recreating it. Kept, not deleted; it will look unfinished until this issue's implementer or reviewer finishes.`,
        );
      }
      continue;
    }

    // Git refuses `branch -f` on a branch checked out in a worktree, so a
    // clean worktree left by an interrupted run is moved from inside instead.
    const worktree = worktreePathOf(branch);
    if (existsSync(worktree)) {
      sh(`git -C ${worktree} reset --hard ${integrationBranch}`);
    } else {
      sh(`git branch -f ${branch} ${integrationBranch}`);
    }
    // A session saved against the old branch would resume into work that no longer exists.
    runState.clearSession(Number(id));
    console.log(
      `#${id}: ${branch} was stale (its commits already reached ${BASE_BRANCH}, likely via a squash merge) — recreated from ${integrationBranch}.`,
    );
  }
}

/**
 * Report the group's work that is saved but not yet marked done.
 *
 * A branch lands here either because an implementer is still mid-issue, or
 * because it was interrupted before signalling completion — the save points
 * in gitFacts mean neither case loses work, so there is nothing to do by
 * hand. This just makes the omission loud at PR time.
 */
function warnAboutUnfinishedBranches(
  group: Group,
  integrationBranch: string,
): void {
  const unfinished = unfinishedBranches(
    REPO_CWD,
    integrationBranch,
    groupIssueBranchDescriptors(group),
  );
  if (unfinished.length === 0) return;

  console.warn(
    `\n⚠️  ${describeGroup(group.id)}: ${unfinished.length} branch(es) hold saved work with no Done marker yet:\n`,
  );

  for (const branch of unfinished) {
    const ahead = commitsAhead(integrationBranch, branch);
    const dirty = worktreeIsDirty(branch);
    console.warn(
      `  ${branch} — ${ahead} commit(s), ${dirty ? "currently mid-edit" : "idle, waiting for its implementer or reviewer to finish"}`,
    );
  }
  console.warn(`\n  Nothing to do by hand — re-run Sandcastle and it will be continued.\n`);
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Turn an unknown thrown value into text the failure classifier can read. */
function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

// ---------------------------------------------------------------------------
// The integration sandbox: checks and merges
// ---------------------------------------------------------------------------

/** An issue as the merge step names it: its number, title and branch. */
type MergeCandidate = { id: string; title: string; branch: string };

/**
 * One sandbox on the group's integration branch, opened on first use and kept
 * for the rest of the group, so its install is paid once rather than per merge.
 *
 * It is always opened on the named integration branch. The bind-mount default
 * is the "head" strategy, which mounts the developer's own checkout: every
 * setup hook then ran against it, which replaced the Mac's
 * frontend/node_modules with Linux binaries, rewrote the lockfile, and let the
 * merger `git stash` the developer's working tree. A named branch gets a
 * worktree under .sandcastle/worktrees/ instead, exactly as an issue sandbox
 * always has.
 */
class IntegrationSandbox {
  #sandbox: sandcastle.Sandbox | undefined;
  #knownGreen = false;

  constructor(readonly branch: string) {}

  async #open(): Promise<sandcastle.Sandbox> {
    this.#sandbox ??= await sandcastle.createSandbox({
      branch: this.branch,
      sandbox: sandboxProvider(),
      hooks,
    });
    return this.#sandbox;
  }

  /** Run `make test` and `make lint`; the tail of their output if they failed. */
  async #check(): Promise<string | undefined> {
    const sandbox = await this.#open();
    console.log(`Checking ${this.branch} with make test and make lint…`);
    const result = await sandbox.exec(withTimeLimit(CHECK_COMMAND));
    this.#knownGreen = result.exitCode === 0;
    return checkFailureTail(result.exitCode, result.stdout, result.stderr, CHECK_OUTPUT_TAIL_CHARS);
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
      `${this.branch} fails make test / make lint before any agent has worked on it this cycle. Fix it by hand — on main, if the branch was cut from a red main — then re-run Sandcastle.\n\n${failure}`,
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
   */
  async merge(issues: MergeCandidate[]): Promise<void> {
    if (issues.length === 0) return;
    await this.#mergeAndRepair(
      issues.map((issue) => issue.branch),
      issues.map((issue) => `- ${issue.id}: ${issue.title}`).join("\n"),
      () =>
        readyToMerge(
          REPO_CWD,
          this.branch,
          issues.map((issue) => ({ issueNumber: Number(issue.id), branch: issue.branch })),
        ),
    );
  }

  /**
   * Merge BASE_REF into the integration branch when main has moved on since
   * the branch was cut, so this PR is rebuilt on what has already shipped
   * rather than conflicting with it at merge time. Conflicts and red checks go
   * to the merger agent exactly as an issue merge's do. A no-op — no sandbox
   * opened — for a branch already level with main. True when it merged.
   */
  async syncWithBase(issueList: string): Promise<boolean> {
    if (!isBehind(REPO_CWD, this.branch, BASE_REF)) return false;
    console.log(`\n${this.branch} is behind ${BASE_REF} — merging it in…`);
    await this.#mergeAndRepair([BASE_REF], issueList, () =>
      isBehind(REPO_CWD, this.branch, BASE_REF) ? [BASE_REF] : [],
    );
    console.log(`${this.branch} is up to date with ${BASE_REF}.`);
    return true;
  }

  /**
   * git merges `branches`, the sandbox checks the result, and the merger agent
   * is called only for a conflict or a red check. `stillUnmergedAfter` names what
   * the agent failed to merge; anything left there, or a red check, throws.
   */
  async #mergeAndRepair(
    branches: string[],
    issueList: string,
    stillUnmergedAfter: () => string[],
  ): Promise<void> {
    const sandbox = await this.#open();

    const { merged, conflicted } = mergeEach(sandbox.worktreePath, branches);
    for (const branch of merged) console.log(`  merged ${branch}`);
    for (const branch of conflicted) console.log(`  ${branch} conflicts — handing it to the merger agent`);

    // With a conflict outstanding the agent runs the checks itself once it has
    // resolved it, so checking the half-merged batch here would be wasted.
    const failure = conflicted.length === 0 ? await this.#check() : undefined;
    if (conflicted.length === 0 && failure === undefined) return;

    this.#knownGreen = false;
    try {
      const result = await sandbox.run({
        name: "merger",
        maxIterations: 1,
        agent: sandcastle.claudeCode("claude-sonnet-5"),
        promptFile: PROMPTS.merge,
        promptArgs: {
          CONFLICTED:
            conflicted.length > 0
              ? conflicted.map((branch) => `- ${branch}`).join("\n")
              : "(none — every branch merged cleanly)",
          ISSUES: issueList,
          CHECK_OUTPUT: failure ?? "(not run yet — run them yourself once the merges are done)",
        },
      });
      recordUsage("batch", "merger", result.iterations);
      throwIfRunFatal(result.stdout);
    } catch (error) {
      if (error instanceof RunFatalError) throw error;
      if (mergerFailureVerdict(errorText(error)) === "rethrow") {
        throwIfRunFatal(errorText(error));
      }
      // Idle timeout or another local failure: its committed merges may be
      // finished, so the branch-state checks below decide.
      console.log(`  the merger agent failed (${errorText(error).slice(0, 200)}) — judging it by what it left`);
    }

    const stillUnmerged = stillUnmergedAfter();
    const stillRed = await this.#check();
    if (stillUnmerged.length === 0 && stillRed === undefined) return;

    throw new BranchStateError(
      [
        `The merger agent left ${this.branch} unfinished. Nothing was pushed; resolve it by hand, then re-run Sandcastle.`,
        stillUnmerged.length > 0 ? `Still unmerged: ${stillUnmerged.join(", ")}` : "",
        stillRed ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  /**
   * Have the PR writer draft the reviewer-facing body with the `pr` skill.
   *
   * Only called once the group is complete: a draft is not worth a reviewer's
   * time, so it is not worth an agent's either. Undefined when the writer
   * fails or writes nothing, and the PR falls back to the generated body — a
   * missing writeup is no reason to hold back a finished batch.
   */
  async writePrBody(issueList: string): Promise<string | undefined> {
    console.log(`\nWriting the PR body for ${this.branch} with the pr skill…`);
    try {
      const sandbox = await this.#open();
      const result = await sandbox.run({
        name: "pr-writer",
        maxIterations: 1,
        agent: sandcastle.claudeCode("claude-sonnet-5"),
        promptFile: PROMPTS.pr,
        promptArgs: { ISSUES: issueList, BASE_REF },
      });
      recordUsage("batch", "pr-writer", result.iterations);
      const body = extractPrBody(result.stdout);
      if (body === undefined) console.log("  the PR writer output no body — keeping the generated one");
      return body;
    } catch (error) {
      console.log(`  the PR writer failed (${errorText(error).slice(0, 200)}) — keeping the generated body`);
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.#sandbox?.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 0: pick up finished work from a prior run
// ---------------------------------------------------------------------------

/**
 * Merge this group's branches that a prior run finished but never merged —
 * "finished" meaning carrying a Done marker for this integration branch, not
 * merely carrying commits. A branch with agent commits but no marker is left
 * alone: it is unfinished, not ready, however far it got.
 */
async function pickUpPriorWork(
  group: Group,
  integration: IntegrationSandbox,
): Promise<void> {
  const ready = new Set(
    readyToMerge(REPO_CWD, integration.branch, groupIssueBranchDescriptors(group)),
  );
  const pickedUp = group.issues
    .map((issue) => ({
      id: String(issue.number),
      title: issue.title,
      branch: issueBranchName(issue.number),
    }))
    .filter(({ branch }) => ready.has(branch));

  if (pickedUp.length === 0) return;

  console.log(`\nPicking up ${pickedUp.length} branch(es) from a prior run:`);
  for (const { id, title, branch } of pickedUp) {
    console.log(`  ${id}: ${title} → ${branch}`);
  }

  await integration.merge(pickedUp);
  console.log("\nPrior-run branches merged into integration branch.");
}

// ---------------------------------------------------------------------------
// Phase 1: plan
// ---------------------------------------------------------------------------

/**
 * Split the group's remaining issues into what can run now and what is
 * blocked, by checking each one deterministically rather than inferring a
 * dependency graph. Applies the same way to a solo group's single issue as to
 * a multi-issue group — a blocked solo issue simply comes back with nothing
 * planned and itself in `blocked`.
 *
 * `alreadyMerged` does double duty: it drops the issues this batch has already
 * done, and it satisfies blockers pointing at them, so a group whose own
 * members block each other drains over successive cycles instead of stalling on
 * issues GitHub will only close when the batch PR merges.
 */
async function planGroup(
  group: Group,
  alreadyMerged: number[],
): Promise<{
  planned: { id: string; title: string; branch: string }[];
  blocked: { id: string; title: string; blockedBy: number[] }[];
}> {
  const remaining = group.issues.filter(
    (issue) => !alreadyMerged.includes(issue.number),
  );
  const blockers = await Promise.all(remaining.map(fetchBlockers));

  const planned: { id: string; title: string; branch: string }[] = [];
  const blocked: { id: string; title: string; blockedBy: number[] }[] = [];

  for (const [i, issue] of remaining.entries()) {
    const blockedBy = liveBlockers(blockers[i]!, alreadyMerged);
    if (blockedBy.length > 0) {
      blocked.push({ id: String(issue.number), title: issue.title, blockedBy });
    } else {
      planned.push({
        id: String(issue.number),
        title: issue.title,
        branch: issueBranchName(issue.number),
      });
    }
  }

  return { planned, blocked };
}

// ---------------------------------------------------------------------------
// Phase 2: execute + review
// ---------------------------------------------------------------------------

/**
 * What iterations 2+ send when the implementer's session survived the last one.
 *
 * A resumed session still holds the prompt it was given, the repo it explored
 * and the work it committed, so re-sending the prompt file would pay to rebuild
 * context the agent already has. The two rules restated here are the ones the
 * orchestrator itself depends on — commits are how it sees progress, the signal
 * is how it sees the end — and they are cheap enough to repeat every time.
 */
const IMPLEMENTER_CONTINUE_PROMPT = [
  "Continue working on this issue from where you stopped.",
  "Commit each coherent step as you finish it. Uncommitted work is invisible to the orchestrator and is lost if this turn is cut off.",
  "Once everything the issue asks for is committed and verified, output <promise>COMPLETE</promise>.",
].join("\n\n");

/** Run git in `cwd`, returning trimmed stdout. */
function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

/** The diff the reviewer sees: whole when small, a `--stat` summary above ~15k tokens. */
function reviewDiffFor(cwd: string, integrationBranch: string, branch: string): string {
  const range = `${integrationBranch}...${branch}`;
  const full = gitIn(cwd, ["diff", range]);
  if (diffPresentation(estimateTokens(full)) === "full") return full;
  return `The full diff is too large to paste (about ${estimateTokens(full)} tokens). Summary:\n\n${gitIn(cwd, ["diff", "--stat", range])}\n\nOpen the files that matter with \`git diff ${range} -- <path>\`.`;
}

/**
 * Implement one issue, then review it. The loop itself — iterations, the
 * dead-run breaker, the reviewer, the Done marker and the WIP saves — lives in
 * lib/issueLoop.mts behind ports; this function creates the sandbox, turns SDK
 * results into port results and closes the sandbox.
 *
 * Sandbox creation reuses an existing issue branch as-is and ignores
 * `baseBranch` for it — the SDK's own behaviour. That is fine now that a
 * stale branch (one holding nothing BASE_REF lacks) is recreated from the
 * integration branch before this runs; see recreateStaleBranches.
 */
async function workIssue(
  issue: { id: string; title: string; branch: string },
  integrationBranch: string,
  cycleAbort: AbortController,
): Promise<{ commits: { sha: string }[]; completed: boolean }> {
  const sandbox = await sandcastle.createSandbox({
    branch: issue.branch,
    // A new issue branch forks from the batch so far, so it builds on what this
    // group has already merged. The default is the host's HEAD, which is only
    // the batch when something has checked it out — and nothing does any more.
    baseBranch: integrationBranch,
    sandbox: sandboxProvider(),
    hooks,
  });

  const issueNumber = Number(issue.id);
  const issueContext = issueContextFor(issueNumber);
  const avoidTerms = extractAvoidTerms(
    readFileSync(join(REPO_CWD, "GLOSSARY.md"), "utf-8"),
  ).join(", ");
  let last: Awaited<ReturnType<typeof sandbox.run>> | undefined;
  let lastRole = "implementer";
  let lastOptions: Parameters<typeof sandbox.run>[0] | undefined;
  const toRunResult = (result: Awaited<ReturnType<typeof sandbox.run>>): RunResult => {
    last = result;
    recordUsage(`#${issue.id}`, lastRole, result.iterations ?? []);
    return {
      stdout: result.stdout,
      commits: result.commits,
      completed: result.completionSignal !== undefined,
      resumable: Boolean(result.resume),
      sessionId: result.iterations.at(-1)?.sessionId,
    };
  };

  const ports: IssueLoopPorts = {
    startRun: async ({ role, model, resumeSessionId, extraPrompt }) => {
      lastRole = role;
      lastOptions =
        role === "implementer"
          ? {
              name: `implementer#${issue.id}`,
              maxIterations: 1,
              resumeSession: resumeSessionId,
              agent: sandcastle.claudeCode("claude-sonnet-5"),
              signal: cycleAbort.signal,
              promptFile: PROMPTS.implement,
              promptArgs: {
                TASK_ID: issue.id,
                ISSUE_TITLE: issue.title,
                ISSUE_CONTEXT: issueContext,
                AVOID_TERMS: avoidTerms,
                BRANCH: issue.branch,
                INTEGRATION_BRANCH: integrationBranch,
                CHECK_FAILURE: extraPrompt ?? "",
              },
            }
          : {
              name: `reviewer#${issue.id}`,
              maxIterations: 1,
              agent: sandcastle.claudeCode(model!),
              signal: cycleAbort.signal,
              promptFile: PROMPTS.review,
              promptArgs: {
                ISSUE_CONTEXT: issueContext,
                BRANCH: issue.branch,
                INTEGRATION_BRANCH: integrationBranch,
                DIFF: reviewDiffFor(sandbox.worktreePath, integrationBranch, issue.branch),
              },
            };
      return toRunResult(await sandbox.run(lastOptions));
    },
    // Not `last.resume(prompt)`: the SDK's resume keeps promptArgs and throws; see lib/resumeRun.mts.
    resumeSession: async (prompt) =>
      toRunResult(
        await sandbox.run(resumeRunOptions(lastOptions!, prompt, last!.iterations.at(-1)!.sessionId!)),
      ),
    exec: async (command) => sandbox.exec(command),
    saveWorktree: (reason) => saveWorktree(sandbox.worktreePath, issueNumber, reason),
    writeDone: () => markDone(sandbox.worktreePath, issueNumber, integrationBranch),
    readSession: () => runState.loadSession(issueNumber),
    writeSession: (sessionId) => runState.saveSession(issueNumber, sessionId),
    clearSession: () => runState.clearSession(issueNumber),
    abortSignal: cycleAbort.signal,
    reviewerModel: () =>
      chooseReviewerModel(
        changedLines(
          gitIn(sandbox.worktreePath, ["diff", "--numstat", `${integrationBranch}...${issue.branch}`]),
        ),
      ),
  };

  try {
    const outcome = await runIssueLoop(ports, {
      maxSteps: MAX_IMPLEMENTER_ITERATIONS,
      continuePrompt: IMPLEMENTER_CONTINUE_PROMPT,
      checkCommand: withTimeLimit(CHECK_COMMAND),
      log: (message) => console.log(`#${issue.id}: ${message}`),
      pastEndTime,
    });
    if (outcome.reason === "dead-run") {
      throw new Error(
        `Implementer for #${issue.id} produced nothing in ${DEAD_ITERATION_THRESHOLD} consecutive iterations — presuming the run is dead.`,
      );
    }
    return { commits: outcome.commits, completed: outcome.completed };
  } catch (error) {
    // The first run-fatal failure stops every sibling at its next step boundary.
    // Re-derive the fatal error from the text so a thrown SDK error counts too.
    try {
      throwIfRunFatal(errorText(error));
    } catch (fatalError) {
      if (!cycleAbort.signal.aborted) cycleAbort.abort(fatalError);
    }
    throw error;
  } finally {
    await sandbox.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 4: the PR
// ---------------------------------------------------------------------------

/**
 * Push the group's batch and open or refresh its PR.
 *
 * Always a draft while work is outstanding: a partial batch is worth publishing
 * — the next run grows the same PR — but it is not worth anyone's review yet.
 * Once it is complete, the PR writer drafts the body a reviewer reads.
 */
async function publish(
  group: Group,
  integration: IntegrationSandbox,
  complete: boolean,
  blocked: { id: string; title: string; blockedBy: number[] }[],
): Promise<boolean> {
  const integrationBranch = integration.branch;
  if (commitsAhead(BASE_REF, integrationBranch) === 0) {
    console.log(`\n${describeGroup(group.id)}: no commits produced. No PR opened.`);
    return false;
  }

  const local = sh(`git rev-parse ${integrationBranch}`);
  const pushed = shQuiet(`git rev-parse --verify --quiet origin/${integrationBranch}`);
  if (local === pushed) {
    console.log(`\n${integrationBranch} is already on origin; nothing to push.`);
  } else {
    execSync(`git push -u origin ${integrationBranch}`, { stdio: "inherit" });
  }

  const mergedIssues = resolveMergedIssues(group, integrationBranch);
  const title = buildPrTitle(group, mergedIssues.length);
  const writeup = complete
    ? await integration.writePrBody(
        mergedIssues.map((issue) => `- ${issue.id}: ${issue.title}`).join("\n"),
      )
    : undefined;
  const body = buildPrBody({ group, mergedIssues, blockedIssues: blocked, complete, writeup });

  const existing = sh(
    `gh pr list --head ${integrationBranch} --state open --json url --jq ".[0].url // empty"`,
  );

  // Title and body go to gh as argv, never through a shell. They are built from
  // issue titles a human wrote and from Markdown that uses backticks, and a
  // JSON-quoted string is still double-quoted to the shell: backticks and `$`
  // run as command substitution, and `\n` escapes arrive as literal text. The
  // first published PR shipped with its group label executed out of the body.
  if (existing) {
    execFileSync(
      "gh",
      ["pr", "edit", integrationBranch, "--title", title, "--body", body],
      { stdio: "inherit" },
    );
    console.log(`\nRefreshed PR for ${integrationBranch}: ${existing}`);
  } else {
    execFileSync(
      "gh",
      [
        "pr", "create", "--draft",
        "--base", BASE_BRANCH,
        "--head", integrationBranch,
        "--title", title,
        "--body", body,
      ],
      { stdio: "inherit" },
    );
    console.log(`\nOpened draft PR for ${integrationBranch} → ${BASE_BRANCH}.`);
  }

  if (complete) {
    // `gh pr ready` on an already-ready PR is a no-op, so a resumed run that
    // finishes a group needs no check of the current draft state.
    sh(`gh pr ready ${integrationBranch}`);
    console.log(`Group ${describeGroup(group.id)} is complete — PR marked ready for review.`);
  } else {
    console.log(`Group ${describeGroup(group.id)} still has outstanding work — PR left as a draft.`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// One group, start to finish
// ---------------------------------------------------------------------------

async function runGroup(group: Group): Promise<boolean> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Group ${describeGroup(group.id)} — ${group.issues.length} open issue(s)`);
  console.log(`${"=".repeat(70)}`);

  const integrationBranch = resolveIntegrationBranch(group);
  activeIntegrationBranch = integrationBranch;

  // Covers the process-killed-with-Ctrl-C path: nothing else runs between an
  // interrupted invocation and this one, so this is the only point that ever
  // sees a worktree left dirty by it.
  saveDirtyWorktreesAtGroupStart(group);

  const integration = new IntegrationSandbox(integrationBranch);
  try {
    return await workGroup(group, integration);
  } finally {
    await integration.close();
  }
}

/** Phases 0–4 for one group, merging and checking through `integration`. */
async function workGroup(group: Group, integration: IntegrationSandbox): Promise<boolean> {
  const integrationBranch = integration.branch;

  await integration.syncWithBase(
    group.issues.map((issue) => `- ${issue.number}: ${issue.title}`).join("\n"),
  );
  await pickUpPriorWork(group, integration);

  let planned: { id: string; title: string; branch: string }[] = [];
  let blocked: { id: string; title: string; blockedBy: number[] }[] = [];
  let settledWithNothingToDo = false;

  let stoppedAtEndTime = false;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (pastEndTime()) {
      console.log(`\nEnd time reached — no new cycle for ${describeGroup(group.id)}.`);
      stoppedAtEndTime = reachedEndTime = true;
      break;
    }
    console.log(`\n=== ${describeGroup(group.id)} — cycle ${iteration}/${MAX_ITERATIONS} ===\n`);

    const alreadyMerged = resolveMergedIssues(group, integrationBranch).map(
      (issue) => Number(issue.id),
    );
    // Rechecked every cycle, not cached: a blocker that closes mid-run — or
    // whose work this run has just merged — should let its dependent join this
    // same run, not wait for the next invocation.
    ({ planned, blocked } = await planGroup(group, alreadyMerged));

    if (blocked.length > 0) {
      console.log(`${blocked.length} issue(s) blocked, skipped this cycle:`);
      for (const issue of blocked) {
        console.log(`  #${issue.id}: ${issue.title} (blocked by ${issue.blockedBy.map((n) => `#${n}`).join(", ")})`);
      }
    }

    if (planned.length === 0) {
      // Nothing left that this batch can unblock by itself: every remaining
      // blocker sits outside the integration branch.
      console.log("No unblocked issues left in this group.");
      break;
    }

    console.log(`${planned.length} issue(s) to work in parallel:`);
    for (const issue of planned) {
      console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
    }

    await integration.assertGreen();
    recreateStaleBranches(planned, integrationBranch);

    const cycleAbort = new AbortController();
    const settled = await Promise.allSettled(
      planned.map((issue) => workIssue(issue, integrationBranch, cycleAbort)),
    );

    // A fatal failure in any pipeline ends the run, but only after every other
    // pipeline has settled — killing sibling agents mid-commit would strand
    // exactly the work this design exists to preserve.
    for (const outcome of settled) {
      if (outcome.status !== "rejected") continue;
      // Rethrown as-is, so the quota stop keeps what it read from the full output.
      if (outcome.reason instanceof RunFatalError) throw outcome.reason;
      throwIfRunFatal(errorText(outcome.reason));
    }
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        console.error(`  ✗ ${planned[i]!.id} (${planned[i]!.branch}) failed: ${outcome.reason}`);
      }
    }

    // "Completed" here means carrying a Done marker for this integration
    // branch — written inside workIssue once the implementer signalled and
    // the reviewer finished — not merely having produced a commit.
    const ready = new Set(
      readyToMerge(REPO_CWD, integrationBranch, groupIssueBranchDescriptors(group)),
    );
    const completed = planned.filter((issue) => ready.has(issue.branch));

    if (completed.length === 0) {
      console.log("No issues marked done this cycle. Nothing to merge.");

      // Every issue reporting completion with nothing to show for it means the
      // work was already done. Replanning would ask the same question and get
      // the same answer, so stop rather than spend the remaining cycles on it.
      const outcomes = settled.map((outcome) => ({
        failed: outcome.status === "rejected",
        commits: outcome.status === "fulfilled" ? outcome.value.commits.length : 0,
        completed: outcome.status === "fulfilled" && outcome.value.completed,
      }));
      if (isSettledWithNothingToDo(outcomes)) {
        console.log("Every issue reports its work was already done. Group finished.");
        settledWithNothingToDo = true;
        break;
      }

      continue;
    }

    console.log(`\nMerging ${completed.length} finished branch(es):`);
    await integration.merge(completed);

    console.log("\nBranches merged into integration branch.");
  }

  warnAboutUnfinishedBranches(group, integrationBranch);
  const stillUnfinished = unfinishedBranches(
    REPO_CWD,
    integrationBranch,
    groupIssueBranchDescriptors(group),
  ).length;
  stranded += stillUnfinished;

  // Stopping before planning leaves `planned` empty, which would read as complete.
  const complete = !stoppedAtEndTime && isGroupComplete({
    plannedIssues: planned.length,
    blockedIssues: blocked.length,
    settledWithNothingToDo,
    strandedBranches: stillUnfinished,
  });

  return publish(group, integration, complete, blocked);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

// `refresh` cannot collide with a group id: those are a parent issue's number
// or `solo-<number>`.
const REFRESHING = REQUESTED_GROUP === "refresh";

const allGroups = REFRESHING ? [] : partitionIntoGroups(fetchOpenIssues());
for (const group of allGroups) assertSafeGroupId(group.id);

const groups = REQUESTED_GROUP
  ? allGroups.filter((group) => group.id === REQUESTED_GROUP)
  : allGroups;

const refreshTargets = REFRESHING ? openBatchPrBranches() : [];
if (REFRESHING) {
  if (refreshTargets.length === 0) {
    console.log("No open Sandcastle PRs. Nothing to refresh.");
    process.exit(0);
  }
  execSync(`git fetch --quiet origin ${BASE_BRANCH} ${refreshTargets.join(" ")}`, {
    stdio: "inherit",
  });
  console.log(`\n${refreshTargets.length} open Sandcastle PR(s), against ${BASE_REF}:\n`);
  for (const branch of refreshTargets) {
    const behind = isBehind(REPO_CWD, `origin/${branch}`, BASE_REF);
    console.log(`  ${branch} — ${behind ? "behind, will merge main in" : "up to date"}`);
  }
}

if (!REFRESHING && REQUESTED_GROUP && groups.length === 0) {
  console.error(
    // The board listing prints raw ids, not describeGroup's rendering: these
    // are the strings you type as the argument, and a solo group's argument is
    // `solo-365`, not the `#365` a message about it would say.
    `No Sandcastle group or solo issue matches ${JSON.stringify(REQUESTED_GROUP)}. Groups on the board: ${allGroups.map((g) => g.id).join(", ") || "(none)"}`,
  );
  process.exit(1);
}

if (!REFRESHING && groups.length === 0) {
  console.log("No issues are labelled for Sandcastle. Nothing to do.");
  process.exit(0);
}

if (REFRESHING && DRY_RUN) {
  console.log("\nSANDCASTLE_DRY_RUN=1 — listed above, nothing refreshed.");
  process.exit(0);
}

if (!REFRESHING) console.log(`\n${groups.length} group(s), in run order:\n`);
for (const group of groups) {
  const parent = group.parentIssue ? ` (closes spec #${group.parentIssue} when complete)` : "";
  console.log(`  ${describeGroup(group.id)}${parent}`);
  const blockersOf = await Promise.all(group.issues.map(fetchBlockers));
  for (const [i, issue] of group.issues.entries()) {
    const blockers = blockersOf[i]!;
    const suffix =
      blockers.length > 0 ? ` [blocked by ${blockers.map((n) => `#${n}`).join(", ")}]` : "";
    console.log(`    #${issue.number} ${issue.title}${suffix}`);
  }
  console.log(`    → ${batchBranchGlob(group.id)}, one draft PR`);
}

if (DRY_RUN) {
  const freshness = imageFreshness();
  console.log(
    `\nSandbox image ${defaultImageName(REPO_CWD)}: ${
      freshness === "current" ? "current" : `${freshness} — a real run would rebuild it`
    }`,
  );
  if (END_AT) {
    console.log(`\nOvernight: waits through quota stops, starts nothing after ${localTime(END_AT)}.`);
  } else if (WAIT_FOR_QUOTA) {
    console.log("\nWaiting through quota stops, with no end time.");
  }
  const dryGate = quotaGate(runState.readQuotaReset(), new Date(), IGNORE_QUOTA_GATE);
  console.log(
    dryGate.allowed
      ? "\nQuota gate: open — a real run would start."
      : `\nQuota gate: closed — a real run would refuse. Quota resets ${localTime(dryGate.resetAt)} (${dryGate.minutesLeft} min left).`,
  );
  console.log("\nReviewer model per planned issue:");
  for (const group of groups) {
    for (const issue of group.issues) {
      const numstat = shQuiet(`git diff --numstat ${BASE_REF}...${issueBranchName(issue.number)}`);
      const choice =
        numstat === undefined
          ? "no branch yet — chosen from its diff once the implementer finishes"
          : (({ model, reason }) => `${model} (${reason})`)(
              chooseReviewerModel(changedLines(numstat)),
            );
      console.log(`  #${issue.number}: ${choice}`);
    }
  }
  const savedSessions = Object.entries(runState.sessions());
  console.log(
    savedSessions.length === 0
      ? "\nSaved implementer sessions: none"
      : `\nSaved implementer sessions (resumed on the next run):\n${savedSessions
          .map(([issue, id]) => `  #${issue} → ${id}`)
          .join("\n")}`,
  );
  console.log("\nSANDCASTLE_DRY_RUN=1 — planned above, nothing executed.");
  process.exit(0);
}

/** Hash of the lockfiles and Dockerfile as they are now. */
function currentImageHash(): string {
  return computeImageHash(
    IMAGE_INPUT_FILES.map((name) => ({
      name,
      content: readFileSync(join(REPO_CWD, name), "utf-8"),
    })),
  );
}

/** Whether the sandbox image is missing, stale (built from other lockfiles) or current. */
function imageFreshness(): "missing" | "stale" | "current" {
  const image = defaultImageName(REPO_CWD);
  const label = shQuiet(
    `docker image inspect --format '{{ index .Config.Labels "${IMAGE_HASH_LABEL}" }}' ${image}`,
  );
  if (label === undefined) return "missing";
  return label === currentImageHash() ? "current" : "stale";
}

/**
 * Build the sandbox image from a context holding only the manifests, lockfiles
 * and Dockerfile, so the repo's node_modules never ship to the Docker daemon.
 * Exits 1 with the end of the build output if the build fails.
 */
function rebuildImage(): void {
  console.log(`\nLockfiles changed — rebuilding sandbox image… (about 2-4 minutes)`);
  const context = mkdtempSync(join(tmpdir(), "sandcastle-image-"));
  try {
    for (const name of IMAGE_INPUT_FILES) {
      const target = join(context, name === ".sandcastle/Dockerfile" ? "Dockerfile" : name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(REPO_CWD, name), target);
    }
    const uid = sh("id -u");
    const gid = sh("id -g");
    execSync(
      `docker build -t ${defaultImageName(REPO_CWD)} --label ${IMAGE_HASH_LABEL}=${currentImageHash()} ` +
        `--build-arg AGENT_UID=${uid} --build-arg AGENT_GID=${gid} ${context}`,
      {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
        // The Dockerfile's `RUN --mount=type=cache` steps need BuildKit.
        env: { ...process.env, DOCKER_BUILDKIT: "1" },
      },
    );
    console.log("Sandbox image rebuilt.");
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    console.error(
      `\nSandbox image build failed. End of the build output:\n${output.slice(-CHECK_OUTPUT_TAIL_CHARS)}`,
    );
    process.exit(1);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/**
 * Refuse to start a run the sandboxes cannot possibly survive.
 *
 * A stopped Docker daemon or a missing image fails every sandbox in exactly the
 * same way, and it fails them by *throwing* out of createSandbox — which
 * bypasses both the dead-iteration breaker and the fatal-output check, so the
 * run burns every cycle of every group retrying a machine that cannot change
 * mid-run. The costlier half is quieter: a failed create tears down the
 * worktree it had just prepared, so uncommitted work a previous run left behind
 * to be resumed is deleted by a run that never got as far as reading it. One
 * second of checking here is cheaper than either.
 */
function preflightSandbox(): void {
  if (shQuiet(`docker info`) === undefined) {
    console.error(
      `\nDocker is not responding — every sandbox would fail to start. Open Docker Desktop, wait for it to finish starting, then re-run Sandcastle.`,
    );
    process.exit(1);
  }

  if (imageFreshness() !== "current") rebuildImage();
}

preflightSandbox();

let startGate = quotaGate(runState.readQuotaReset(), new Date(), IGNORE_QUOTA_GATE);
if (!startGate.allowed) {
  const plan = planQuotaWait({
    kind: "session",
    resetAt: startGate.resetAt,
    now: new Date(),
    waiting: WAIT_FOR_QUOTA,
    endAt: END_AT,
  });
  if (!plan.wait) {
    console.error(
      `\nClaude quota resets at ${localTime(startGate.resetAt)} — ${startGate.minutesLeft} minute(s) from now. Nothing was started${WAIT_FOR_QUOTA ? `, because ${plan.reason}` : ""}. Set SANDCASTLE_IGNORE_QUOTA_GATE=1 to run anyway.`,
    );
    process.exit(1);
  }
  await sleepUntil(plan.until, "Quota is spent.");
  startGate = quotaGate(runState.readQuotaReset(), new Date(), IGNORE_QUOTA_GATE);
}

const startBranch = sh(`git rev-parse --abbrev-ref HEAD`);

/**
 * Put the developer's checkout back where they left it.
 *
 * Registered as an exit handler rather than run as a line at the end, because
 * the ends that matter most never reach that line: Ctrl-C and a spent quota
 * both leave through `process.exit`, and stranding someone on an integration
 * branch is a poor way to greet them after a run died overnight. Everything
 * here is synchronous, which an exit handler requires, and nothing here may
 * throw — an exception at this point would mask whatever actually went wrong.
 */
let restored = false;
function restoreStartBranch(): void {
  if (restored) return;
  restored = true;
  try {
    if (sh(`git rev-parse --abbrev-ref HEAD`) === startBranch) return;
    if (shQuiet(`git checkout ${startBranch}`) === undefined) {
      console.error(
        `\nCould not return to ${startBranch} — your checkout is still on the integration branch.`,
      );
    }
  } catch {
    console.error(`\nCould not determine the current branch to restore ${startBranch}.`);
  }
}
process.on("exit", restoreStartBranch);

let fatal: RunFatalError | undefined;

// The group a fatal failure stopped, and the integration branch it was on.
// Set as each group starts, so the ending can say where that group's work sits.
let fatalGroup: Group | undefined;
let activeIntegrationBranch: string | undefined;

let published = 0;

let failed = 0;

// Branches left holding commits no batch took. Counted so the ending cannot
// claim the agents produced nothing while the warning above lists their work.
let stranded = 0;

// Set when the end time stopped a group or kept one from starting.
let reachedEndTime = false;

/** Sleep until `wakeAt`, saying why first. */
async function sleepUntil(wakeAt: Date, why: string): Promise<void> {
  console.log(`\n${why} Waiting until ${localTime(wakeAt)}, then continuing.`);
  // Short naps against the wall clock, so a Mac that slept anyway wakes on time.
  while (Date.now() < wakeAt.getTime()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(wakeAt.getTime() - Date.now(), 60_000)));
  }
}

const PROBE_MODEL = "claude-haiku-4-5";

/**
 * One tiny Haiku call on the host, so quota spent elsewhere is caught before
 * any sandbox is paid for. Returns the run-fatal failure it found, if any.
 * A missing `claude` binary skips the probe with a warning.
 */
function probeQuota(): RunFatalError | undefined {
  let output: string;
  try {
    output = execFileSync("claude", ["-p", "Reply with the single word: ok", "--model", PROBE_MODEL], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn("\nWarning: no `claude` binary on this machine — skipping the quota probe.");
      return undefined;
    }
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    output = `${stdout ?? ""}\n${stderr ?? ""}\n${errorText(error)}`;
  }
  try {
    throwIfRunFatal(output);
  } catch (rethrown) {
    return rethrown as RunFatalError;
  }
  return undefined;
}

/**
 * The one quota path, shared by an agent's quota stop and the probe: record the
 * reset time and, while waiting is on, sleep until it — or, with no reset time
 * in the message, an hour at a time with a probe after each. Returns the stop
 * that ends the run, or undefined when it waited and the run should carry on.
 */
async function handleQuotaStop(stop: RunFatalError): Promise<RunFatalError | undefined> {
  let current = stop;
  while (current.kind === "quota") {
    if (current.resetAt) runState.recordQuotaReset(current.resetAt);
    const plan = planQuotaWait({
      kind: current.quotaStop ?? "session",
      resetAt: current.resetAt,
      now: new Date(),
      waiting: WAIT_FOR_QUOTA,
      endAt: END_AT,
    });
    if (!plan.wait) {
      if (WAIT_FOR_QUOTA) console.error(`\nNot waiting for the quota: ${plan.reason}.`);
      return current;
    }
    if (!plan.recheck) {
      await sleepUntil(plan.until, `Quota stop (reset plus ${QUOTA_WAIT_MARGIN_MS / 60_000} minutes).`);
      return undefined;
    }
    await sleepUntil(plan.until, "Quota stop with no reset time — checking again in an hour.");
    const again = probeQuota();
    if (!again) return undefined;
    current = again;
  }
  return current;
}

if (shouldProbeQuota(startGate, runState.readQuotaReset(), new Date(), DRY_RUN)) {
  const probeStop = probeQuota();
  if (probeStop) fatal = await handleQuotaStop(probeStop);
}

const RESUME_ADVICE: Record<Exclude<FailureKind, "local">, string> = {
  quota: "Re-run Sandcastle when your quota resets.",
  auth: "Log the agent in, then re-run Sandcastle.",
  network: "Check the sandbox's connectivity, then re-run Sandcastle.",
};

/**
 * `refresh`: merge main into every open batch PR that is behind it, and push.
 * No issue is planned or implemented, and a PR's title, body and draft state
 * are left as they are. Meant for right after a PR merges, so the others are
 * rebuilt on it before they are reviewed. Exits the process.
 */
async function refreshBatchPrs(branches: string[]): Promise<never> {
  let refreshed = 0;
  let refreshFailed = 0;
  for (let index = 0; index < branches.length; index++) {
    const branch = branches[index]!;
    activeIntegrationBranch = branch;
    console.log(`\n=== Refresh ${branch} ===`);
    try {
      if (branchesMatching(branch).length === 0) {
        sh(`git branch ${branch} origin/${branch}`);
      } else {
        catchUpIntegrationBranch(branch);
      }
      if (!isBehind(REPO_CWD, branch, BASE_REF)) {
        console.log(`Already up to date with ${BASE_REF}.`);
        continue;
      }
      const integration = new IntegrationSandbox(branch);
      try {
        const prTitle = sh(`gh pr view ${branch} --json title --jq .title`);
        await integration.syncWithBase(`- the PR "${prTitle}"`);
      } finally {
        await integration.close();
      }
      execSync(`git push origin ${branch}`, { stdio: "inherit" });
      refreshed++;
    } catch (error) {
      let stop = runFatalStop(error);
      if (stop) {
        stop = await handleQuotaStop(stop);
        if (!stop) {
          index--; // retry the PR the quota stopped
          continue;
        }
        console.error(`\n${stop.message}\n\n${RESUME_ADVICE[stop.kind]} Nothing for ${branch} was pushed.`);
        reportOutcome("interrupted");
        process.exit(2);
      }
      refreshFailed++;
      console.error(`\n✗ ${branch} could not be refreshed, continuing:\n${errorText(error)}\n`);
    }
  }

  restoreStartBranch();
  if (refreshFailed > 0) {
    console.error(`\n${refreshFailed} PR(s) could not be refreshed, ${refreshed} refreshed. The error above says what broke.`);
    reportOutcome("crash");
    process.exit(1);
  }
  console.log(`\nAll done — ${refreshed} PR(s) refreshed, ${branches.length - refreshed} already up to date.`);
  reportOutcome("success");
  process.exit(0);
}

if (REFRESHING && !fatal) await refreshBatchPrs(refreshTargets);

for (let index = 0; !fatal && index < groups.length; index++) {
  if (pastEndTime()) {
    reachedEndTime = true;
    console.log(`\nEnd time reached — ${groups.length - index} group(s) left for the next run.`);
    break;
  }
  const group = groups[index]!;
  activeIntegrationBranch = undefined;
  let stop: RunFatalError | undefined;
  try {
    if (await runGroup(group)) published++;
  } catch (error) {
    stop = runFatalStop(error);
    if (!stop) {
      failed++;
      console.error(
        `\n✗ Group ${describeGroup(group.id)} failed, continuing to the next group:\n${errorText(error)}\n`,
      );
    }
  }
  if (!stop) continue;
  const runEnding = await handleQuotaStop(stop);
  if (!runEnding) {
    index--; // carry on from the group that was stopped
    continue;
  }
  fatal = runEnding;
  fatalGroup = group;
  break;
}

restoreStartBranch();

/**
 * Name the branches holding the interrupted group's work that GitHub does not
 * have. A group is pushed only when it reaches publish, and a fatal failure
 * stops it before then — so whatever it committed exists on this machine alone.
 * Measured against the integration branch's remote copy when one exists, so a
 * resumed group's already-pushed commits are not reported as local.
 */
function unpushedWork(
  group: Group,
  integrationBranch: string | undefined,
): { branch: string; commits: number }[] {
  const pushedRef =
    integrationBranch &&
    shQuiet(`git rev-parse --verify --quiet origin/${integrationBranch}`) !== undefined
      ? `origin/${integrationBranch}`
      : BASE_REF;

  return [
    ...(integrationBranch ? [integrationBranch] : []),
    ...group.issues.map((issue) => issueBranchName(issue.number)),
  ]
    .filter((branch) => branchesMatching(branch).length > 0)
    .map((branch) => ({ branch, commits: commitsAhead(pushedRef, branch) }))
    .filter(({ commits }) => commits > 0);
}

if (fatal) {
  console.error(`\n${fatal.message}`);
  console.error(
    published > 0
      ? `\nThe ${published} group(s) published above are pushed and covered by their PRs.`
      : `\nNo group was published this run.`,
  );

  const local = fatalGroup ? unpushedWork(fatalGroup, activeIntegrationBranch) : [];
  if (fatalGroup && local.length > 0) {
    console.error(
      `${describeGroup(fatalGroup.id)} was stopped mid-way. Its work is saved on this machine only — not pushed, no PR yet:`,
    );
    for (const { branch, commits } of local) {
      console.error(`  ${branch} — ${commits} commit(s)`);
    }
  } else if (fatalGroup) {
    console.error(`${describeGroup(fatalGroup.id)} was stopped before it committed anything.`);
  }

  console.error(`\n${RESUME_ADVICE[fatal.kind]} It will resume where it stopped.`);
  if (fatal.kind === "quota" && fatal.resetAt) {
    console.error(`Quota resets at ${localTime(fatal.resetAt)}.`);
  }
  reportOutcome("interrupted");
  process.exit(2);
}

// A group that threw says nothing either way about what its agents committed —
// the merge step is the last thing to run, so a failure there lands with the
// work already committed on the issue branches. Reporting that as "nothing was
// produced" sends you looking for an agent that did nothing, when what actually
// happened is that finished work never got merged. The commits are not lost:
// the next run picks those branches up.
if (failed > 0) {
  console.error(
    `\n${failed} group(s) failed${published > 0 ? `, ${published} published` : " and nothing was published"}. Any commits their agents made are still on the sandcastle/issue-* branches and the next run will pick them up. The error above says what broke.`,
  );
  reportOutcome("crash");
  process.exit(1);
}

if (reachedEndTime) {
  console.log(
    `\nStopped at the end time, ${localTime(END_AT!)} — ${published} group(s) published. Unfinished work stays on its branches and the next run resumes it.`,
  );
  reportOutcome("interrupted");
  process.exit(2);
}

if (published === 0 && stranded > 0) {
  console.error(
    `\nNothing was published, but ${stranded} branch(es) carry finished commits that never reached a batch — see the warning above. The agents did work; it is the merge that did not happen.`,
  );
  reportOutcome("empty");
} else if (published === 0) {
  console.log(
    `\nNo group produced any commits, so nothing was published. Check the logs in .sandcastle/logs/ — the agents ran but left nothing behind.`,
  );
  reportOutcome("empty");
} else {
  console.log(`\nAll done — ${published} group(s) published.`);
  reportOutcome("success");
}
