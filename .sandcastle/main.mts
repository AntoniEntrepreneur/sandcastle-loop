// Parallel Planner with Review — grouped, resumable orchestration loop
//
// A run works one **group** at a time, in sequence. A group is the set of open
// issues sharing a `sandcastle:<id>` label; an issue carrying the bare
// `sandcastle` label is a group of one. Each group gets its own integration
// branch and its own PR, so two unrelated specs never share a review.
//
// Per group:
//   Phase 0 (Sync + Pick up):   Merge the pushed copy of a resumed integration
//                               branch that diverged from it (the merger agent
//                               takes any conflict), then merge origin/main into it
//                               when main has moved on, so the PR
//                               is rebuilt on what already shipped. Then merge
//                               `sandcastle/issue-<N>` branches belonging to
//                               THIS group that a prior run left finished.
//   Phase 1 (Plan):             Each remaining issue is checked against
//                               GitHub's own record of what blocks it — native
//                               issue dependencies, or a `Blocked by:` line in
//                               the body as a fallback. A blocker whose work is
//                               already on the integration branch counts as
//                               resolved, so a group that blocks itself drains
//                               as its issues merge rather than waiting for
//                               its own PR to merge. Planning repeats after
//                               every merge (lib/groupQueue.mts). Anything still blocked is
//                               skipped, not attempted; there is no inferred
//                               dependency graph and no fallback candidate
//                               forced through when everything is blocked.
//   Phase 2 (Execute + Review): Per issue, a sandbox is created. The implementer
//                               is driven one iteration at a time so a dead run
//                               can be cut short; the reviewer follows if the
//                               branch differs from the integration branch.
//                               An issue starts as soon as it is plannable;
//                               there is no cycle to wait out.
//   Phase 3 (Merge):            As soon as an issue carries its Done marker,
//                               git merges its branch (together with any
//                               others finished by then) and the
//                               integration sandbox runs the project's
//                               check. An agent is called only for a conflict
//                               or a red result. Agents never start on a red
//                               integration branch. A tree the check has
//                               already passed — here or in an issue
//                               sandbox, this run or an earlier one — is
//                               not checked again.
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
//   npm run sandcastle -- 278, 251, 555  # several groups, in the order typed
//   npm run sandcastle -- refresh   # only merge main into every open batch PR
//   npm run sandcastle -- prune     # delete local branches and worktrees whose work shipped
//   npm run sandcastle -- --overnight               # leave it running; see below
//   npm run sandcastle -- 244 --overnight --until 06:30
//   npm run sandcastle -- 244 --implementer agy     # Gemini implements #244; see below
//   npm run sandcastle -- 244 --reviewer agy        # Gemini reviews #244; see below
//   npm run sandcastle -- 244 --merger agy          # Gemini resolves conflicts and repairs checks
//   npm run sandcastle -- 244 --pr-writer agy       # Gemini writes the PR body; see below
//   npm run sandcastle -- 244 --implementer codex   # Codex implements #244; see below
//   npm run sandcastle -- 244 --reviewer codex --merger codex --pr-writer codex
//   SANDCASTLE_DRY_RUN=1 npm run sandcastle
//   SANDCASTLE_WAIT_FOR_QUOTA=1 npm run sandcastle  # sleep through quota stops, no end time
//   SANDCASTLE_IGNORE_QUOTA_GATE=1 npm run sandcastle  # start before the recorded reset
//   SANDCASTLE_SOUND=0 npm run sandcastle           # no sound when the run ends
//   node --test .sandcastle/lib/    # unit tests for the logic below
//
// --overnight sleeps through quota stops (and a spent quota at startup) until
// the reset, but never past the end time — 05:00 local unless --until says
// otherwise. After the end time, agent runs already going finish and are merged
// and pushed; nothing new starts. A weekly limit or an empty credit balance
// still ends the run. It also mutes the end-of-run sound.
//
// Every run keeps the Mac from idle-sleeping while it lives, on battery too.
// Closing the lid still sleeps it.
//
// --implementer agy names an Antigravity (`agy`) agent running
// gemini-3.8-flash-medium (lib/antigravity.mts) as the implementer, and only
// the implementer: the reviewer, merger and PR writer stay on Claude. Its
// fix rounds and follow-up steps resume the conversation in the issue's
// sandbox, but a dead agy run starts cold on its branch next time — the
// conversation stays in the sandbox that ran it — so its session is never
// saved and the dry-run plan's saved-sessions list leaves it out. Its shell commands
// pass the same dangerous-git guard as Claude's, through the workspace's
// .agents/hooks.json (#733).
// An unknown value stops the run before anything starts, naming the accepted
// values. With --overnight it sleeps through a Gemini quota stop as it does a
// Claude one, until the reset `agy -p "/usage"` reports, kept on a clock of
// its own in the run state (lib/runState.mts). It needs `agy` already
// signed in to the developer's Google/Antigravity account: a one-word probe
// checks the host's quota at run start, and two files — the Google OAuth
// credentials and the Antigravity OAuth token, not the whole ~/.gemini
// folder (lib/antigravity.mts) — are mounted into the sandbox. Either file
// missing on the host stops the run before any sandbox is built, naming
// `agy` as the sign-in command. The exit token table labels its row
// gemini-3.8-flash-medium, with input, output, thinking and cache-read tokens
// read from the stream's own result usage; the PR body names the actual
// implementer per issue, Claude or Gemini (lib/groups.mts, lib/runState.mts).
//
// --reviewer agy names an Antigravity (`agy`) agent as the reviewer, running
// gemini-3.8-flash-medium whatever the diff's size (lib/reviewDiff.mts). Every other role is
// unaffected. Its fix rounds resume the reviewer's conversation inside the
// issue's sandbox, but the conversation is never saved to the run state. An
// unknown value stops the run before anything starts, naming the accepted
// values. With --overnight it sleeps through a spent Gemini quota as a Gemini
// quota stop. The exit token table labels its row with the model that actually
// ran, and a resumed round records only its own difference; the PR body names
// the reviewer when it ran on agy (#803).
//
// --merger agy runs conflict resolution and red-check repair on
// gemini-3.8-flash-low (lib/rolePlan.mts). A thrown error carrying an
// AGY_ERROR credits/quota line stops the run as a Gemini quota stop, while
// non-quota errors are judged by what the merger left on the branch
// (lib/issueLoop.mts). The merger's token row is labelled
// gemini-3.8-flash-low, and the PR body names the merger when it ran on agy
// (lib/groups.mts).
//
// --pr-writer agy drafts the batch's PR body on gemini-3.8-flash-low instead
// of Claude; every other role is unaffected (#805). It extracts the body from
// the stream's said text rather than raw stdout, and falls back to the generated
// body if no body is output. A spent Gemini quota while writing stops the run
// as a Gemini quota stop. The PR writer's token row comes from the stream and
// is labelled gemini-3.8-flash-low; the PR body names the agy PR writer.
//
// --implementer, --reviewer, --merger and --pr-writer each also take codex,
// which runs that role on Codex (`codex exec`, the engine's own provider): the
// implementer on gpt-6.1-sol, the reviewer on gpt-6.1-sol under 200 changed
// lines and gpt-6-astra at 200 or more, the merger and the PR writer on
// gpt-6-luna (lib/rolePlan.mts).
// --codex-account NAME runs every Codex role on ~/.codex-NAME; see
// docs/agents/sandcastle.md. The PR body never names the account.
// Agents mix per role: `--implementer codex --reviewer agy` is one run. It
// needs `codex login` on the host: its sign-in is copied into each sandbox,
// whose ~/.codex is Sandcastle's own, never the developer's (lib/codex.mts).
// The copy has no refresh token, so no sandbox can spend the one-use token
// the host's Codex depends on; instead the run renews the sign-in on the host
// at the start when its access token has under two days left, and a sandbox
// that still can't renew stops the run as a sign-in stop. A
// linked worktree's Codex reads the project .codex/ from the main checkout,
// which the sandbox doesn't mount, so the repo's Codex hooks and rules are
// installed there at user level instead, and the hooks trusted by the hash the
// host's Codex reports. A hook it can't trust stops the run before any sandbox
// starts, since it would otherwise silently not run. The quota is read from
// the host's `codex app-server`, which spends none of it: at the start, after
// a shared failure, and on a Codex usage-limit stop, which --overnight sleeps
// through on a clock of its own as it does Claude's and Gemini's. Only Claude
// sessions are saved for a later run; a Codex one is resumed within its
// sandbox only. The token table's Codex rows are named by label, e.g.
// `gpt-6.1-sol medium (codex)`, read from the captured session file, and the PR
// body names the roles Codex ran.
//
// Every agent shares one effort per role (ROLE_EFFORT in lib/rolePlan.mts):
// medium for the implementer and the reviewer, low for the merger and the PR
// writer. Claude and Codex take it as a setting, and agy as its model's
// -medium/-low variant. Claude's labels name it too, e.g.
// `claude-sonnet-5 medium` in the PR body.
//
// The startup banner and the dry-run plan name every role's agent and model,
// read from the one role plan the whole run works from (lib/rolePlan.mts).
//
// Each argument is one or more group ids, split on commas and spaces
// (`278 251`, `278,251` and `278, 251` are the same), duplicates dropped, run
// in the order typed. An id is a group id, `solo-N`, or a bare N: the group N
// if the board has one, else the solo issue #N; a number that is both is an
// error. An id that resolves to nothing stops the run before any sandbox
// starts, naming every such id. `refresh` takes no ids, and --overnight,
// --until and the role flags apply to every chosen group. What you can run by
// hand is decided by the admission label. An issue carrying the bare `sandcastle` label is the
// group `solo-<its number>`, which is how you name it above. An issue inside a
// `sandcastle:<id>` group has no handle of its own: the whole group is the
// smallest thing a run will take, and the siblings you did not want cost a
// sandbox each to report they have nothing to do.

import * as sandcastle from "@ai-hero/sandcastle";
import { defaultImageName, docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFile, execFileSync, execSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { commandErrorText, loggedCommand } from "./lib/commandOutput.mts";
import { ciHasPassedBase } from "./lib/ciGreen.mts";
import { preflightDocker } from "./lib/dockerPreflight.mts";
import { IntegrationSandbox } from "./lib/integrationSandbox.mts";
import {
  catchUpWithRemote,
  foreignWorktreeHolding,
  cleanTree,
  doneIssues,
  hasImplementerComplete,
  hasReviewerComplete,
  isBatchBranchShipped,
  isBehind,
  isStale,
  markDone,
  markImplementerComplete,
  markReviewerComplete,
  prunableBranches,
  readyToMerge,
  saveWorktree,
  unfinishedBranches,
  type CatchUp,
} from "./lib/gitFacts.mts";
import {
  changedLines,
  diffPresentation,
  estimateTokens,
} from "./lib/reviewDiff.mts";
import {
  AGY_PROBE_MODEL,
  formatRoleBanner,
  roleLabel,
  rolePlan,
  type AgentKind,
  type RoleEffort,
} from "./lib/rolePlan.mts";
import { createGitHubAccess } from "./lib/githubAccess.mts";
import { runGroupQueue } from "./lib/groupQueue.mts";
import { runGroup as runGroupWithPorts, refreshBranch } from "./lib/groupRun.mts";
import {
  runIssueLoop,
  RunFatalError,
  throwIfRunFatal,
  runFatalStop,
  type IssueLoopPorts,
  type Role,
  type RunResult,
} from "./lib/issueLoop.mts";
import {
  agySignInMounts,
  antigravity,
  missingAgySignInFiles,
  parseGeminiQuotaReset,
  stageAgyToken,
} from "./lib/antigravity.mts";
import {
  appServerRequest,
  accessTokenExpiry,
  codexAuthFile,
  codexQuotaStopMessage,
  defaultCodexAccount,
  missingCodexAccountMessage,
  resolveCodexHome,
  MIN_ACCESS_TOKEN_LIFE_MS,
  renewHostCodexSignIn,
  codexHookTrust,
  CodexMissingError,
  countHooks,
  parseCodexRateLimits,
  sandboxCodexConfig,
  sandboxCodexMounts,
  stageCodexAuth,
  type CodexQuotaReading,
} from "./lib/codex.mts";
import { openRunState } from "./lib/runState.mts";
import { withCheckSlot } from "./lib/checkSlots.mts";
import { resumeRunOptions } from "./lib/resumeRun.mts";
import {
  extractAvoidTerms,
  fillProjectPlaceholders,
  parentIssueNumber,
  renderIssueContext,
  type IssueText,
} from "./lib/promptInputs.mts";
import { inspectSandboxImage, prepareSandboxImage } from "./lib/sandboxImage.mts";
import { formatUsageTable, logsToDelete, RunReport, sessionUsage, streamStepUsage, type UsageRow } from "./lib/runReport.mts";
import { IMAGE_HASH_LABEL, computeImageHash } from "./lib/imageHash.mts";
import { muteSounds, reportOutcome } from "./notify.mts";
import { config } from "./sandcastle.config.mts";
import {
  nextClockTime,
  parseCommandLine,
  planQuotaWait,
  QUOTA_WAIT_MARGIN_MS,
  type CommandLine,
  type QuotaProvider,
  type QuotaStopKind,
} from "./lib/overnight.mts";
import {
  batchBranchGlob,
  withTimeLimit,
  DEAD_ITERATION_THRESHOLD,
  describeGroup,
  AGENT_IDLE_TIMEOUT_SECONDS,
  type FailureKind,
  issueBranchName,
  issueNumberOfBranch,
  parseBlockedByLine,
  partitionIntoGroups,
  resolveGroupIds,
  quotaGate,
  shouldProbeQuota,
  type Group,
  type Issue,
  type QuotaGateDecision,
} from "./lib/groups.mts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Upper bound on implementer iterations per issue. Driven one at a time from
// here rather than handed to maxIterations, so the circuit breaker below can
// stop a dead run instead of burning the remainder on container starts.
const MAX_IMPLEMENTER_ITERATIONS = 100;

// Hooks run inside the sandbox before the agent starts.
// Every sandbox installs from cold, and the 60s default is a budget for a
// top-up rather than an install. A hook that times out throws the whole group
// away *after* the agents have done their expensive work. Slow is recoverable;
// dead is not — and this one budget covers the whole setup command, which
// runs in sequence rather than installs racing each other.
const HOOK_TIMEOUT_MS = 20 * 60 * 1000;

// The project's setup command must leave no trace: dirt in the worktree is
// indistinguishable from an interrupted agent, so Phase 0 would refuse to pick
// the branch up — permanently, since every run redoes the same install.
// Finished commits then never reach a PR, and `gh pr merge` cannot clean up
// the worktree afterwards. It all runs before the agent starts, so a lockfile
// change the agent genuinely intends is unaffected.
const SETUP_COMMAND = config.setupCommand;

// Installs and checks are the memory peaks: nine sandboxes running `npm install`
// or `make test` at once exceeded Docker's VM and the kernel OOM-killed some of
// them. Only this many may be in those phases together; the rest wait their turn.
const HEAVY_PHASE_SLOTS = Number(process.env.SANDCASTLE_HEAVY_SLOTS ?? 3);

const heavyWaiters: Array<() => void> = [];
let heavyRunning = 0;

async function inHeavyPhase<T>(work: () => Promise<T>): Promise<T> {
  if (heavyRunning >= HEAVY_PHASE_SLOTS) {
    await new Promise<void>((resolve) => heavyWaiters.push(resolve));
  } else {
    heavyRunning++;
  }
  try {
    return await work();
  } finally {
    // Hand the slot straight to the next waiter, so the count stays put.
    const next = heavyWaiters.shift();
    if (next) next();
    else heavyRunning--;
  }
}

const hooks = {
  sandbox: {
    onSandboxReady: [{ command: SETUP_COMMAND, timeoutMs: HOOK_TIMEOUT_MS }],
  },
};

// What "the integration branch is green" means. The setup is repeated first
// because a merge can change a lockfile, and on a warm sandbox it is a top-up.
const CHECK_COMMAND = `${SETUP_COMMAND} && ${config.checkCommand}`;

// How much of a failed check's output is kept, for a log line or a prompt. The
// end is where test runners and linters print what failed.
const CHECK_OUTPUT_TAIL_CHARS = 6000;

/** How much of a failed quota probe's output is worth reporting. */
const PROBE_FAILURE_CHARS = 300;

// Nothing is copied from the host. node_modules was, to make the hooks above a
// top-up rather than a cold install, but the host is Darwin arm64 and the
// sandbox is Linux aarch64: the tree carries platform-specific binaries like
// @rollup/rollup-darwin-arm64 that are wrong inside the container. npm has to
// reconcile them, and that reconciliation rewrote the lockfiles on a good day
// and died with ENOTEMPTY on a bad one.
//
// What is shared instead is the project's download caches, which hold tarballs
// and wheels rather than an installed tree, so every sandbox's install still
// runs cold against its own platform but stops re-downloading.
const CACHE_DIR = ".sandcastle/cache";
const runState = openRunState(CACHE_DIR);
const CHECK_SLOTS_DIR = join(CACHE_DIR, "check-slots");
const AGY_STAGED_TOKEN = resolve(CACHE_DIR, "agy-sign-in", "antigravity-oauth-token");
// The sandbox's own ~/.codex, staged on the host (lib/codex.mts): a copy of the
// sign-in, and a config that trusts the repo's Codex hooks at their sandbox path.
const CODEX_STAGED_AUTH = resolve(CACHE_DIR, "codex-home", "auth.json");
const CODEX_STAGED_CONFIG = resolve(CACHE_DIR, "codex-home", "config.toml");
// Codex sessions captured out of the sandboxes, kept apart from the
// developer's own ~/.codex/sessions so they never crowd `codex resume`.
const CODEX_SESSIONS_DIR = resolve(CACHE_DIR, "codex-sessions");

function sandboxProvider() {
  const mounts = config.cacheMounts.map(({ name, sandboxPath }) => {
    const hostPath = join(CACHE_DIR, name);
    mkdirSync(hostPath, { recursive: true });
    return { hostPath, sandboxPath };
  });
  // Only these two files, never the whole ~/.gemini folder — see
  // lib/antigravity.mts for which, why the token is a staged copy, and why
  // they're writable (#730).
  if (ROLE_PLAN.needsAgySignIn) {
    stageAgyToken(AGY_STAGED_TOKEN);
    mounts.push(...agySignInMounts(AGY_STAGED_TOKEN));
  }
  // Re-staged at every sandbox open, so each copies the sign-in the host's own
  // Codex keeps renewed, its refresh token blanked (lib/codex.mts sandboxAuth).
  if (ROLE_PLAN.needsCodexSignIn) {
    stageCodexAuth(CODEX_STAGED_AUTH);
    mounts.push(
      ...sandboxCodexMounts({
        stagedAuth: CODEX_STAGED_AUTH,
        stagedConfig: CODEX_STAGED_CONFIG,
        hooksFile: resolve(config.codexHooksFile!),
        rulesDir: config.codexRulesDir === undefined ? undefined : resolve(config.codexRulesDir),
      }),
    );
  }
  return docker({
    mounts,
    // A long test suite outlasts Claude Code's 2-minute Bash default, which
    // moved it to the background: agents then polled it with `sleep` loops,
    // and some went silent long enough for the idle timeout to kill them.
    // Commands now stay in the foreground, with 8 minutes to finish. Both
    // settings are Claude Code's own, so `agy` gets the same rule from the
    // implement and review prompts instead, and Codex relies on
    // AGENT_IDLE_TIMEOUT_SECONDS, which every agent run is given.
    env: {
      ...config.sandboxEnv,
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

// The only folder Sandcastle moves a branch inside; a checkout elsewhere is foreign.
const WORKTREES_DIR = ".sandcastle/worktrees";

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

/**
 * Which agent and model each role runs this run (lib/rolePlan.mts). Every
 * branch that used to ask whether the implementer is agy asks the plan
 * instead: sign-in, mounts, quota, token rows, sessions and labels (#802).
 */
const ROLE_PLAN = rolePlan(commandLine);

// The run's one Codex account (#1201): the flag, else $CODEX_ACCOUNT, and only
// when a role is on Codex. Every host-side Codex step (sign-in check, renewal,
// staging, quota reading, hook trust) reads $CODEX_HOME, so the resolved home is
// exported once here.
// A comma list names several accounts (#1233); the run starts on the first with quota and swaps on a quota stop (#1234).
let CODEX_ACCOUNTS: string[] | undefined;
try {
  CODEX_ACCOUNTS = ROLE_PLAN.needsCodexSignIn
    ? (commandLine.codexAccounts ?? defaultCodexAccount(process.env))
    : undefined;
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
// Changes when a quota stop swaps to another listed account (#1234).
let CODEX_ACCOUNT: string | undefined = CODEX_ACCOUNTS?.[0];
if (CODEX_ACCOUNT !== undefined) process.env.CODEX_HOME = resolveCodexHome(CODEX_ACCOUNT);
// Each account has its own quota, so its reset time is saved apart from the others'.
runState.useCodexAccount(CODEX_ACCOUNT);

// Fail before any sandbox is built, not with a dead agent later (#730): the
// sign-in files are created by running `agy` once on the host, which opens a
// browser for Google sign-in. On macOS the token lives in the Keychain instead
// of its file, and is staged from there.
if (ROLE_PLAN.needsAgySignIn) {
  const missing = missingAgySignInFiles(stageAgyToken(AGY_STAGED_TOKEN));
  if (missing.length > 0) {
    console.error(
      `${ROLE_PLAN.agyFlags.join(", ")} needs these sign-in files, missing on this machine:\n${missing
        .map((path) => `  ${path}`)
        .join("\n")}\n\nRun \`agy\` once on the host and sign in with your Google account — it writes these (on macOS, the token goes to the Keychain, which Sandcastle reads) — then re-run Sandcastle.`,
    );
    process.exit(1);
  }
}

// The same for Codex, plus its hooks (lib/codex.mts): the sandbox never loads
// the repo's project .codex/, so the dangerous-git hook is installed in the
// sandbox's own ~/.codex and trusted there by its hash. A hook that can't be
// trusted would silently not run, so the run stops instead.
if (ROLE_PLAN.needsCodexSignIn) {
  const fail = (message: string): never => {
    console.error(`${ROLE_PLAN.codexFlags.join(", ")}: ${message}`);
    process.exit(1);
  };
  // Every listed account must be able to sign in, so a later swap never lands on a dead one.
  for (const account of CODEX_ACCOUNTS ?? []) {
    const home = resolveCodexHome(account);
    if (!existsSync(codexAuthFile(home))) fail(missingCodexAccountMessage(account, home));
  }
  if (!existsSync(codexAuthFile())) {
    if (CODEX_ACCOUNT !== undefined) fail(missingCodexAccountMessage(CODEX_ACCOUNT, process.env.CODEX_HOME!));
    fail(
      `needs Codex's sign-in file, missing on this machine:\n  ${codexAuthFile()}\n\nRun \`codex login\` on the host, then re-run Sandcastle.`,
    );
  }
  // The sandboxes get no refresh token (lib/codex.mts sandboxAuth), so the
  // access token they get must outlast the run: renew it here when it won't.
  const expiresAt = accessTokenExpiry(readFileSync(codexAuthFile(), "utf-8"));
  if (expiresAt !== undefined && expiresAt.getTime() - Date.now() < MIN_ACCESS_TOKEN_LIFE_MS) {
    if (DRY_RUN) {
      console.log(`Codex sign-in: expires ${expiresAt.toISOString()} — a real run renews it on the host first.`);
    } else {
      console.log(`Codex sign-in expires ${expiresAt.toISOString()} — renewing it on the host…`);
      try {
        renewHostCodexSignIn();
      } catch (error) {
        fail(`could not renew Codex's sign-in — ${(error as Error).message}\n\nRun \`codex login\` on the host, then re-run Sandcastle.`);
      }
      const renewed = accessTokenExpiry(readFileSync(codexAuthFile(), "utf-8"));
      if (renewed === undefined || renewed.getTime() - Date.now() < MIN_ACCESS_TOKEN_LIFE_MS) {
        fail(`Codex's sign-in still expires ${renewed?.toISOString() ?? "at an unknown time"} after renewing it. Run \`codex login\` on the host, then re-run Sandcastle.`);
      }
    }
  }
  stageCodexAuth(CODEX_STAGED_AUTH);
  if (config.codexHooksFile === undefined) {
    fail("sandcastle.config.mts names no codexHooksFile, so Codex would run in the sandbox with no dangerous-git guard.");
  }
  const hooksFile = resolve(config.codexHooksFile!);
  let trust: ReturnType<typeof codexHookTrust> | undefined;
  try {
    trust = codexHookTrust(hooksFile);
  } catch (error) {
    fail(`could not read the trust hash of ${config.codexHooksFile} from \`codex app-server\` — ${(error as Error).message}`);
  }
  const expected = countHooks(readFileSync(hooksFile, "utf-8"));
  if (trust!.hooks.length !== expected) {
    fail(
      `Codex found ${trust!.hooks.length} of the ${expected} hook(s) in ${config.codexHooksFile}; the sandbox would run without them.`,
    );
  }
  mkdirSync(dirname(CODEX_STAGED_CONFIG), { recursive: true });
  writeFileSync(CODEX_STAGED_CONFIG, sandboxCodexConfig(trust!.hooks, trust!.standInHooksFile));
}

/** The agent a role runs, from the kind, model and (unless agy) effort its plan names. */
function roleAgent({ kind, model, effort }: { kind: AgentKind; model: string; effort?: RoleEffort }) {
  if (kind === "agy") return antigravity(model);
  if (kind === "codex") {
    return sandcastle.codex(model, { effort, sessionStorage: { hostSessionsDir: CODEX_SESSIONS_DIR } });
  }
  return sandcastle.claudeCode(model, { effort });
}

const IMPLEMENTER_AGENT = roleAgent(ROLE_PLAN.implementer);

/** Whose quota this run spends, each gated on its own reset: Claude when any role is Claude, Gemini when any role is agy, Codex when any role is Codex. */
const QUOTA_PROVIDERS: readonly QuotaProvider[] = ROLE_PLAN.quotaProviders;
const PROVIDER_NAMES: Record<QuotaProvider, string> = { claude: "Claude", gemini: "Gemini", codex: "Codex" };

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

if (!DRY_RUN) keepAwake();
if (OVERNIGHT) muteSounds();

/** A reset time as the developer's local clock reads it. */
function localTime(at: Date): string {
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const RESUME_ADVICE: Record<Exclude<FailureKind, "local">, string> = {
  quota: "Re-run Sandcastle when your quota resets.",
  auth: "Log the agent in, then re-run Sandcastle.",
  network: "Check the sandbox's connectivity, then re-run Sandcastle.",
  shared: "Fix what the failure above names — the machine, a login or the quota, since every issue met it — then re-run Sandcastle.",
};

const githubAccess = createGitHubAccess({
  now: Date.now,
  sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)); },
  reachable: async () => {
    try {
      await execFileAsync("gh", ["api", "rate_limit", "--silent"], { timeout: 30_000 });
      return true;
    } catch { return false; }
  },
  log: (message) => console.log(message),
});
const githubCall = githubAccess.run;
const waitForGitHub = githubAccess.wait;

/** Give pre-run GitHub failures the same network ending and resume advice as a running group. */
async function startupGitHub<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await githubCall(call);
  } catch (error) {
    const stop = runFatalStop(error);
    if (!stop) throw error;
    console.error(`\n${stop.message}\n\n${RESUME_ADVICE[stop.kind]} It will resume where it stopped.`);
    reportOutcome("interrupted");
    process.exit(2);
  }
}

/** Fetch an issue and its comments on the host, as JSON. */
async function fetchIssueText(number: number): Promise<IssueText & { comments: string[] }> {
  const raw = JSON.parse(
    await ghCommand(["issue", "view", String(number), "--json", "number,title,body,comments"]),
  ) as IssueText & { comments: { body: string }[] };
  return { ...raw, comments: raw.comments.map((c) => c.body) };
}

/** The issue, its comments and its parent spec, rendered for the implementer prompt. */
async function issueContextFor(number: number): Promise<string> {
  const issue = await fetchIssueText(number);
  const parentNumber = parentIssueNumber(issue.body);
  return renderIssueContext({
    issue,
    parent: parentNumber === undefined ? undefined : await fetchIssueText(parentNumber),
  });
}

/**
 * The prompt files as they were when this run started, with the project's
 * placeholders already filled in.
 *
 * This script is loaded once, but the SDK reads a prompt file from disk at
 * every run() call. A prompt edited mid-run therefore met code that predated
 * it: a new {{PLACEHOLDER}} with no promptArg failed every agent for the rest
 * of the run. Copying them here keeps code and prompts from the same moment.
 */
const PROMPTS_DIR = mkdtempSync(join(tmpdir(), "sandcastle-prompts-"));
const PROMPTS = (() => {
  const dir = PROMPTS_DIR;
  const projectValues = {
    PROJECT_NOTES: readFileSync(join(".sandcastle", "project-notes.md"), "utf-8").trim(),
    CHECK_COMMAND: config.checkCommand,
  };
  const snapshot = (name: string) => {
    const copy = join(dir, name);
    const text = readFileSync(join(".sandcastle", name), "utf-8");
    writeFileSync(copy, fillProjectPlaceholders(text, projectValues));
    return copy;
  };
  return {
    implement: snapshot("implement-prompt.md"),
    review: snapshot("review-prompt.md"),
    merge: snapshot("merge-prompt.md"),
    pr: snapshot("pr-prompt.md"),
  };
})();

const REQUESTED_GROUPS = commandLine.groups;

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

const runReport = new RunReport(Date.now());

// One exit handler covers every way a run ends — success, empty, failed,
// interrupted: print the usage table, then remove the prompt snapshot.
process.on("exit", () => {
  try {
    console.log(`\nToken use this run:\n${runReport.render()}`);
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
  return loggedCommand(() => execSync(command, { encoding: "utf-8", stdio: "pipe" }).trim(), console.error);
}

/** Run a command, returning its stdout or undefined if it failed. */
function shQuiet(command: string): string | undefined {
  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (error) {
    if (command.startsWith("gh ")) console.error(commandErrorText(error));
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

/** Run a GitHub command through the shared outage policy, preserving its diagnostics. */
async function ghCommand(args: string[]): Promise<string> {
  return githubCall(async () => {
    try {
      const { stdout } = await execFileAsync("gh", args, { encoding: "utf-8" });
      return stdout.trim();
    } catch (error) {
      console.error(commandErrorText(error));
      throw error;
    }
  });
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
async function fetchOpenIssues(): Promise<Issue[]> {
  const json = await ghCommand(["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,body,labels"]);
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
 * GitHub per issue, on every plan, and in sequence those added up.
 */
async function fetchBlockers(
  issue: Issue,
  isOpen: (number: number) => Promise<boolean> = isIssueOpen,
): Promise<number[]> {
  const native = await ghCommand([
    "api",
    `repos/{owner}/{repo}/issues/${issue.number}/dependencies/blocked_by`,
    "--paginate",
    "--jq",
    '[.[] | select(.state=="open") | .number]',
  ]);
  const numbers = JSON.parse(native.length > 0 ? native : "[]") as number[];
  if (numbers.length > 0) return numbers;

  const candidates = parseBlockedByLine(issue.body);
  const open = await Promise.all(candidates.map(isOpen));
  return candidates.filter((_, i) => open[i]);
}

/** Read issue freshness without treating a failed lookup as a closed issue. */
async function isIssueOpen(issueNumber: number): Promise<boolean> {
  const state = await ghCommand(["issue", "view", String(issueNumber), "--json", "state", "--jq", ".state"]);
  if (state !== "OPEN" && state !== "CLOSED") {
    throw new Error(`Could not read state of #${issueNumber}: ${state}`);
  }
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

/**
 * Merged PR head branches matching `glob`, for deciding whether a batch
 * branch shipped by squash merge rather than by ancestry. `gh` has no glob
 * search over head branch names, so every merged PR is fetched once and
 * filtered here.
 */
async function fetchMergedPrHeadBranches(glob: string): Promise<string[]> {
  const json = await ghCommand(["pr", "list", "--state", "merged", "--limit", "200", "--json", "headRefName", "--jq", "[.[].headRefName]"]);

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
async function openBatchPrBranches(): Promise<string[]> {
  const json = await ghCommand(["pr", "list", "--state", "open", "--base", BASE_BRANCH, "--limit", "100", "--json", "headRefName", "--jq", "[.[].headRefName]"]);
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`Unexpected 'gh pr list' output, expected a string array: ${json}`);
  }
  return parsed.filter((branch) => branch.startsWith("sandcastle/batch-"));
}

/**
 * Bring a resumed integration branch level with `origin`. A branch that never
 * reached `origin` has nothing to fetch, so a failed fetch is not an error.
 * A divergence — each side has commits the other lacks — is not resolved here:
 * `IntegrationSandbox.mergeRemoteCopy` merges the pushed copy in, and hands
 * conflicts to the merger agent.
 */
async function fetchAndCatchUp(branch: string): Promise<CatchUp> {
  try {
    await githubCall(() => sh(`git fetch --quiet origin ${branch}`));
  } catch (error) {
    if (!/couldn.t find remote ref/i.test(commandErrorText(error))) throw error;
  }
  return catchUpWithRemote(REPO_CWD, branch, `origin/${branch}`, WORKTREES_DIR);
}

/** Host path of the worktree Sandcastle keeps for a branch. */
function worktreePathOf(branch: string): string {
  return `${WORKTREES_DIR}/${branch.replace(/\//g, "-")}`;
}

/** Whether a branch's worktree has uncommitted changes mid-edit. */
function worktreeIsDirty(branch: string): boolean {
  const status = shQuiet(`git -C ${worktreePathOf(branch)} status --porcelain`);
  // No worktree checked out for this branch means nothing is mid-edit.
  return status !== undefined && status.length > 0;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Turn an unknown thrown value into text the failure classifier can read. */
function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

/**
 * The stop for issues that failed alike with `message` (the queue raises it
 * when two issues fail alike back to back). The quota is probed first: a quota stop in wording no pattern knows reads as a shared
 * failure, and a probe that names it lets the run wait for the reset instead.
 */
function sharedFailureStop(message: string): RunFatalError {
  const quotaStop =
    (ROLE_PLAN.quotaProviders.includes("claude") ? probeQuota("claude", CLAUDE_PROBE_MODEL) : undefined) ??
    (ROLE_PLAN.quotaProviders.includes("gemini") ? probeQuota("agy", AGY_PROBE_MODEL) : undefined) ??
    (ROLE_PLAN.quotaProviders.includes("codex") ? probeCodexQuota() : undefined);
  return quotaStop ?? new RunFatalError("shared", message.slice(0, 300));
}

// ---------------------------------------------------------------------------
// The integration sandbox: checks and merges
// ---------------------------------------------------------------------------

/**
 * The group's integration sandbox (lib/integrationSandbox.mts), wired to this
 * run's real Docker, SDK, git and check slots.
 *
 * It is always opened on the named integration branch. The bind-mount default
 * is the "head" strategy, which mounts the developer's own checkout: every
 * setup hook then ran against it, which replaced the Mac's node_modules with
 * Linux binaries, rewrote the lockfile, and let the merger `git stash` the
 * developer's working tree. A named branch gets a worktree under
 * .sandcastle/worktrees/ instead, exactly as an issue sandbox always has.
 */
function createIntegrationSandbox(branch: string): IntegrationSandbox {
  return new IntegrationSandbox(
    branch,
    {
      openSandbox: (onBranch) =>
        sandcastle.createSandbox({ branch: onBranch, sandbox: sandboxProvider(), hooks }),
      agentFor: (role) => roleAgent(role),
      withCheckSlot: (work, onWait) => withCheckSlot(CHECK_SLOTS_DIR, work, { onWait }),
      ciHasPassedBase: (tree) => ciHasPassedBase(tree, BASE_REF, shQuiet),
      runState,
      recordRoleUsage: (role, agent, iterations) =>
        runReport.recordRoleUsage("batch", role, agent, iterations),
    },
    {
      cwd: REPO_CWD,
      baseRef: BASE_REF,
      refreshDepsCommand: config.refreshDepsCommand,
      check: {
        command: withTimeLimit(CHECK_COMMAND),
        label: config.checkCommand,
        tailChars: CHECK_OUTPUT_TAIL_CHARS,
      },
      prompts: PROMPTS,
      rolePlan: ROLE_PLAN,
      log: (message) => console.log(message),
    },
  );
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
  signal: AbortSignal,
): Promise<{ commits: { sha: string }[]; completed: boolean }> {
  // Read from GitHub before the sandbox exists: a throw here would otherwise
  // leave the sandbox, outside the try that closes it, open until exit (#999's run).
  const issueNumber = Number(issue.id);
  const issueContext = await issueContextFor(issueNumber);
  const avoidTerms =
    config.glossaryFile === undefined
      ? undefined
      : extractAvoidTerms(readFileSync(join(REPO_CWD, config.glossaryFile), "utf-8")).join(", ");

  // The onSandboxReady hook installs dependencies, so creation is a heavy phase.
  const sandbox = await inHeavyPhase(() =>
    sandcastle.createSandbox({
      branch: issue.branch,
      // A new issue branch forks from the batch so far, so it builds on what this
      // group has already merged. The default is the host's HEAD, which is only
      // the batch when something has checked it out — and nothing does any more.
      baseBranch: integrationBranch,
      sandbox: sandboxProvider(),
      hooks,
    }),
  );

  let last: Awaited<ReturnType<typeof sandbox.run>> | undefined;
  /** The agent the step now running was started with; the reviewer's model is only known per review. */
  let lastAgent: { role: Role; kind: AgentKind; model: string; effort?: RoleEffort; label: string } = {
    role: "implementer",
    ...ROLE_PLAN.implementer,
  };
  let lastOptions: Parameters<typeof sandbox.run>[0] | undefined;
  const toRunResult = (result: Awaited<ReturnType<typeof sandbox.run>>): RunResult => {
    last = result;
    // The token table's row and the PR body's "implemented by"/"reviewed by"
    // lines name the agent that actually ran, not just the generic role, so an
    // agy issue and a Claude one read differently in the same batch (#731).
    if (lastAgent.role === "implementer") runState.recordImplementer(issueNumber, lastAgent.label);
    else runState.recordReviewer(issueNumber, lastAgent.label);
    runReport.recordRoleUsage(`#${issue.id}`, lastAgent.role, lastAgent, result.iterations ?? []);
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
      if (role === "implementer") {
        lastAgent = { role, ...ROLE_PLAN.implementer };
        lastOptions = {
          name: `implementer#${issue.id}`,
          maxIterations: 1,
          idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
          resumeSession: resumeSessionId,
          agent: IMPLEMENTER_AGENT,
          signal,
          promptFile: PROMPTS.implement,
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            ISSUE_CONTEXT: issueContext,
            ...(avoidTerms === undefined ? {} : { AVOID_TERMS: avoidTerms }),
            BRANCH: issue.branch,
            INTEGRATION_BRANCH: integrationBranch,
            CHECK_FAILURE: extraPrompt ?? "",
          },
        };
      } else {
        // The loop picks the reviewer's model from the branch's diff before it
        // starts the review, so it is always named here.
        const { kind, effort } = ROLE_PLAN.reviewer;
        const reviewerModel = model!;
        lastAgent = { role, kind, model: reviewerModel, effort, label: roleLabel(kind, reviewerModel, effort) };
        lastOptions = {
          name: `reviewer#${issue.id}`,
          maxIterations: 1,
          idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
          agent: roleAgent(lastAgent),
          signal,
          promptFile: PROMPTS.review,
          promptArgs: {
            ISSUE_CONTEXT: issueContext,
            BRANCH: issue.branch,
            INTEGRATION_BRANCH: integrationBranch,
            DIFF: reviewDiffFor(sandbox.worktreePath, integrationBranch, issue.branch),
            CHECK_FAILURE: extraPrompt ?? "",
          },
        };
      }
      return toRunResult(await sandbox.run(lastOptions));
    },
    // Not `last.resume(prompt)`: the SDK's resume keeps promptArgs and throws; see lib/resumeRun.mts.
    resumeSession: async (prompt) =>
      toRunResult(
        await sandbox.run(resumeRunOptions(lastOptions!, prompt, last!.iterations.at(-1)!.sessionId!)),
      ),
    // The check command installs and runs the suites, so it takes a slot too.
    exec: async (command) => inHeavyPhase(() => sandbox.exec(command)),
    withCheckSlot: (work) =>
      withCheckSlot(CHECK_SLOTS_DIR, work, {
        signal,
        onWait: () => console.log(`#${issue.id}: waiting for a free check slot…`),
      }),
    saveWorktree: (reason) => saveWorktree(sandbox.worktreePath, issueNumber, reason),
    writeDone: () => markDone(sandbox.worktreePath, issueNumber, integrationBranch),
    hasImplementerComplete: () => hasImplementerComplete(sandbox.worktreePath, issueNumber),
    writeImplementerComplete: () => markImplementerComplete(sandbox.worktreePath, issueNumber),
    hasReviewerComplete: () => hasReviewerComplete(sandbox.worktreePath, issueNumber),
    writeReviewerComplete: () => markReviewerComplete(sandbox.worktreePath, issueNumber),
    readSession: () => runState.loadSession(issueNumber) ?? codexSessions.get(issueNumber),
    // Only a Claude session is saved for a later run. An agy conversation stays
    // in this sandbox (lib/antigravity.mts), so a later run could never resume
    // it. A Codex session could be, but a later run may put another agent on
    // the role, and the saved id carries no note of whose it is. Within this
    // process it is kept, so the issue a Codex account swap stopped resumes it
    // on the new account (#1234); a failed resume starts the issue cold.
    writeSession: (sessionId) => {
      if (lastAgent.kind === "claude") runState.saveSession(issueNumber, sessionId);
      else if (lastAgent.kind === "codex") codexSessions.set(issueNumber, sessionId);
    },
    clearSession: () => {
      codexSessions.delete(issueNumber);
      runState.clearSession(issueNumber);
    },
    abortSignal: signal,
    cleanTree: () => cleanTree(sandbox.worktreePath),
    isGreenTree: (tree) => runState.isGreenTree(tree),
    recordGreenTree: (tree) => runState.recordGreenTree(tree),
    reviewerModel: () =>
      ROLE_PLAN.reviewer.model(
        changedLines(
          gitIn(sandbox.worktreePath, ["diff", "--numstat", `${integrationBranch}...${issue.branch}`]),
          config.lockfiles,
          config.testFiles,
        ),
      ),
    hasChanges: () =>
      gitIn(sandbox.worktreePath, ["diff", "--name-only", `${integrationBranch}...${issue.branch}`]) !== "",
  };

  try {
    const outcome = await runIssueLoop(ports, {
      issueNumber,
      maxSteps: MAX_IMPLEMENTER_ITERATIONS,
      continuePrompt: IMPLEMENTER_CONTINUE_PROMPT,
      checkCommand: withTimeLimit(CHECK_COMMAND),
      formatCommand: config.formatCommand,
      refreshDepsCommand: config.refreshDepsCommand,
      // Every loop message also goes into the agent log of the run just
      // finished, so a check result or a cold start sits beside the step it
      // follows there, not only in the run log (#810).
      log: (message) => {
        console.log(`#${issue.id}: ${message}`);
        if (last?.logFilePath === undefined) return;
        try {
          appendFileSync(last.logFilePath, `\n[sandcastle] ${message}\n`);
        } catch {
          // A log that cannot be written must not break the run.
        }
      },
      pastEndTime,
    });
    if (outcome.reason === "dead-run") {
      throw new Error(
        `Implementer for #${issue.id} produced nothing in ${DEAD_ITERATION_THRESHOLD} consecutive iterations — presuming the run is dead.`,
      );
    }
    return { commits: outcome.commits, completed: outcome.completed };
  } finally {
    await sandbox.close();
  }
}

// ---------------------------------------------------------------------------
// One group, start to finish
// ---------------------------------------------------------------------------

/** Wire the group's lifecycle to this run's real GitHub, git, sandbox and clock. */
async function runGroup(group: Group): Promise<boolean> {
  return runGroupWithPorts({
    github: {
      isIssueOpen,
      issueTitle: async (number) => ghCommand(["issue", "view", String(number), "--json", "title", "--jq", ".title"]),
      blockers: fetchBlockers,
      mergedPrHeads: fetchMergedPrHeadBranches,
      mergedPr: async (head) => {
        const json = await ghCommand([
          "pr", "list", "--head", head, "--state", "merged", "--limit", "200",
          "--json", "number,url,headRefOid",
        ]);
        const parsed: unknown = JSON.parse(json);
        if (
          !Array.isArray(parsed) ||
          !parsed.every((entry) =>
            typeof entry === "object" && entry !== null &&
            typeof entry.number === "number" && typeof entry.url === "string" &&
            typeof entry.headRefOid === "string")
        ) {
          throw new Error(`Unexpected 'gh pr list' output, expected number/url/headRefOid: ${json}`);
        }
        return parsed[0];
      },
      openPr: async (head) => ghCommand(["pr", "list", "--head", head, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"]),
      // Title and body go to gh as argv, never through a shell. They are built
      // from issue titles a human wrote and from Markdown that uses backticks,
      // and a JSON-quoted string is still double-quoted to the shell: backticks
      // and `$` run as command substitution, and `\n` escapes arrive as literal
      // text. The first published PR shipped with its group label executed out
      // of the body.
      editPr: async ({ head, title, body }) => {
        await ghCommand(["pr", "edit", head, "--title", title, "--body", body]);
      },
      createDraftPr: async ({ head, base, title, body }) => {
        await ghCommand(["pr", "create", "--draft", "--base", base, "--head", head, "--title", title, "--body", body]);
      },
      readyPr: async (head) => { await ghCommand(["pr", "ready", head]); },
    },
    git: {
      fetchBase: () => { sh(`git fetch origin ${BASE_BRANCH}`); },
      branchesMatching,
      isBatchBranchShipped: (branch, mergedHeads) => isBatchBranchShipped(REPO_CWD, branch, BASE_REF, mergedHeads),
      createBranch: (branch, from, force) => { sh(`git branch ${force ? "-f " : ""}${branch} ${from}`); },
      catchUp: fetchAndCatchUp,
      foreignWorktree: (branch) => foreignWorktreeHolding(REPO_CWD, branch, WORKTREES_DIR),
      doneIssues: (branch) => doneIssues(REPO_CWD, branch),
      worktreeExists: (branch) => existsSync(worktreePathOf(branch)),
      worktreeIsDirty,
      saveWorktree: (branch, issue) => saveWorktree(worktreePathOf(branch), issue, "found-dirty-at-start"),
      isStale: (branch) => isStale(REPO_CWD, branch, BASE_REF),
      resetWorktree: (branch, from) => {
        execFileSync("git", ["-C", worktreePathOf(branch), "reset", "--hard", from], { encoding: "utf-8" });
      },
      commitsAhead,
      hasFileChanges: (ref, branch) => gitIn(REPO_CWD, ["diff", "--name-only", ref, branch, "--"]) !== "",
      commitsSince: (ref, branch) => lines(gitIn(REPO_CWD, ["log", "--format=%h %s", `${ref}..${branch}`, "--"])),
      readyToMerge: (branch, issues) => readyToMerge(REPO_CWD, branch, issues),
      unfinishedBranches: (branch, issues) => unfinishedBranches(REPO_CWD, branch, issues),
      resolveCommit: (branch) => sh(`git rev-parse ${branch}`),
      resolveRemoteCommit: (branch) => shQuiet(`git rev-parse --verify --quiet origin/${branch}`),
    },
    push: pushBranch,
    githubCall,
    createIntegrationSandbox,
    runQueue: runGroupQueue,
    workIssue,
    clearSession: (issue) => runState.clearSession(issue),
    prAttribution: () => ({
      implementers: { byIssue: runState.implementedBy(), fallback: ROLE_PLAN.implementer.label },
      reviewers: runState.reviewedBy(),
      merger: runState.batchRole("merger"),
      prWriter: runState.batchRole("pr-writer"),
    }),
    integrationBranchSelected: (branch) => { activeIntegrationBranch = branch; },
    recordStranded: (count) => { stranded += count; },
    endTimeReached: () => { reachedEndTime = true; },
    pastEndTime,
    sharedFailureStop,
    waitForGitHub,
    now: Date.now,
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
  }, { baseBranch: BASE_BRANCH, baseRef: BASE_REF }, group);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

// `refresh` and `prune` cannot collide with a group id: those are a parent
// issue's number or `solo-<number>`.
const REFRESHING = REQUESTED_GROUPS[0] === "refresh";

/**
 * `prune`: delete the local Sandcastle branches whose work has shipped, with
 * their worktrees (see prunableBranches for what counts as shipped). A branch
 * whose worktree holds uncommitted changes is kept. Nothing on origin is
 * touched. Exits the process.
 */
async function pruneBranches(): Promise<never> {
  await githubCall(() => sh(`git fetch --quiet origin ${BASE_BRANCH}`));
  // A worktree folder deleted by hand still holds its branch until git forgets it.
  sh(`git worktree prune`);
  const { batches, issues } = prunableBranches(REPO_CWD, {
    batchBranches: branchesMatching("sandcastle/batch-*"),
    issueBranches: branchesMatching("sandcastle/issue-*"),
    mainRef: BASE_REF,
    mergedPrHeadBranches: await fetchMergedPrHeadBranches("sandcastle/batch-*"),
  });
  const branches = [...issues, ...batches];
  if (branches.length === 0) {
    console.log("No shipped Sandcastle branches. Nothing to prune.");
    process.exit(0);
  }

  console.log(`\n${branches.length} shipped Sandcastle branch(es):\n`);
  if (DRY_RUN) {
    for (const branch of branches) console.log(`  ${branch}`);
    console.log("\nSANDCASTLE_DRY_RUN=1 — listed above, nothing deleted.");
    process.exit(0);
  }

  let kept = 0;
  for (const branch of branches) {
    const worktree = worktreePathOf(branch);
    if (existsSync(worktree)) {
      if (worktreeIsDirty(branch) || shQuiet(`git worktree remove ${worktree}`) === undefined) {
        console.warn(`  kept ${branch}: its worktree ${worktree} has uncommitted changes or could not be removed`);
        kept++;
        continue;
      }
    }
    sh(`git branch -D ${branch}`);
    const issue = issueNumberOfBranch(branch);
    if (issue !== undefined) runState.clearSession(issue);
    console.log(`  deleted ${branch}`);
  }
  console.log(`\nPruned ${branches.length - kept} branch(es)${kept > 0 ? `, kept ${kept}` : ""}.`);
  process.exit(0);
}

if (REQUESTED_GROUPS[0] === "prune") await startupGitHub(pruneBranches);

const allGroups = REFRESHING ? [] : partitionIntoGroups(await startupGitHub(fetchOpenIssues));
for (const group of allGroups) assertSafeGroupId(group.id);

let groups = allGroups;
if (REQUESTED_GROUPS.length > 0 && !REFRESHING) {
  const resolution = resolveGroupIds(REQUESTED_GROUPS, allGroups);
  if (!resolution.ok) {
    console.error(resolution.message);
    process.exit(1);
  }
  groups = resolution.groups;
}

const refreshTargets = REFRESHING ? await startupGitHub(openBatchPrBranches) : [];
if (REFRESHING) {
  if (refreshTargets.length === 0) {
    console.log("No open Sandcastle PRs. Nothing to refresh.");
    process.exit(0);
  }
  await startupGitHub(() => sh(`git fetch --quiet origin ${BASE_BRANCH} ${refreshTargets.join(" ")}`));
  console.log(`\n${refreshTargets.length} open Sandcastle PR(s), against ${BASE_REF}:\n`);
  for (const branch of refreshTargets) {
    const behind = isBehind(REPO_CWD, `origin/${branch}`, BASE_REF);
    console.log(`  ${branch} — ${behind ? "behind, will merge main in" : "up to date"}`);
  }
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
  const blockersOf = await startupGitHub(() => Promise.all(group.issues.map((issue) => fetchBlockers(issue))));
  for (const [i, issue] of group.issues.entries()) {
    const blockers = blockersOf[i]!;
    const suffix =
      blockers.length > 0 ? ` [blocked by ${blockers.map((n) => `#${n}`).join(", ")}]` : "";
    console.log(`    #${issue.number} ${issue.title}${suffix}`);
  }
  console.log(`    → ${batchBranchGlob(group.id)}, one draft PR`);
}

if (!REFRESHING) {
  console.log(`\n${formatRoleBanner(ROLE_PLAN)}`);
  if (ROLE_PLAN.needsCodexSignIn) {
    console.log(`  Codex account: ${CODEX_ACCOUNTS?.join(", ") ?? "default sign-in"}`);
  }
}

const sandboxImageOptions = {
  repoCwd: REPO_CWD,
  imageName: defaultImageName(REPO_CWD),
  inputFiles: config.imageInputFiles,
};

if (DRY_RUN) {
  const freshness = inspectSandboxImage(sandboxImageOptions);
  console.log(
    `\nSandbox image ${sandboxImageOptions.imageName}: ${
      freshness === "current" ? "current" : `${freshness} — a real run would rebuild it`
    }`,
  );
  if (END_AT) {
    console.log(`\nOvernight: waits through quota stops, starts nothing after ${localTime(END_AT)}.`);
  } else if (WAIT_FOR_QUOTA) {
    console.log("\nWaiting through quota stops, with no end time.");
  }
  for (const provider of QUOTA_PROVIDERS) {
    const dryGate = quotaGate(runState.readQuotaReset(provider), new Date(), IGNORE_QUOTA_GATE);
    console.log(
      dryGate.allowed
        ? `\n${PROVIDER_NAMES[provider]} quota gate: open — a real run would start.`
        : `\n${PROVIDER_NAMES[provider]} quota gate: closed — a real run would refuse. Quota resets ${localTime(dryGate.resetAt)} (${dryGate.minutesLeft} min left).`,
    );
  }
  if (ROLE_PLAN.quotaProviders.includes("gemini")) {
    // The one agent call a dry run makes: a word of Gemini costs nothing next
    // to finding out after the sandboxes are built that its quota is spent.
    const probe = runQuotaProbe("agy", AGY_PROBE_MODEL);
    console.log(`\nGemini quota probe: ${describeQuotaProbe(probe)}`);
  }
  if (ROLE_PLAN.quotaProviders.includes("codex")) {
    // Free: Codex's app-server reports the quota without a model call.
    for (const account of CODEX_ACCOUNTS ?? [undefined]) {
      const label = CODEX_ACCOUNTS && CODEX_ACCOUNTS.length > 1 ? ` (account "${account}")` : "";
      console.log(`\nCodex quota probe${label}: ${describeQuotaProbe(runCodexQuotaProbe(account))}`);
    }
  }
  console.log("\nReviewer model per planned issue:");
  for (const group of groups) {
    for (const issue of group.issues) {
      const numstat = shQuiet(`git diff --numstat ${BASE_REF}...${issueBranchName(issue.number)}`);
      const choice =
        numstat === undefined
          ? "no branch yet — chosen from its diff once the implementer finishes"
          : (({ model, reason }) => `${model} (${reason})`)(
              ROLE_PLAN.reviewer.model(changedLines(numstat, config.lockfiles, config.testFiles)),
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

/**
 * Refuse to start a run the sandboxes cannot possibly survive.
 *
 * A stopped Docker daemon or a missing image fails every sandbox in exactly the
 * same way, and it fails them by *throwing* out of createSandbox — which
 * bypasses both the dead-iteration breaker and the fatal-output check, so the
 * run burns every attempt of every group retrying a machine that cannot change
 * mid-run. The costlier half is quieter: a failed create tears down the
 * worktree it had just prepared, so uncommitted work a previous run left behind
 * to be resumed is deleted by a run that never got as far as reading it. One
 * second of checking here is cheaper than either.
 */
async function preflightSandbox(): Promise<void> {
  try {
    await preflightDocker({
      probe: (timeout) => {
        try {
          execFileSync("docker", ["info"], { stdio: "ignore", timeout });
          return true;
        } catch {
          return false;
        }
      },
      start: (command, timeout) => {
        console.log("\nDocker is not responding — running the configured start command and waiting up to 3 minutes…");
        execSync(command, { stdio: "ignore", timeout });
      },
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }, config.dockerStartCommand);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (inspectSandboxImage(sandboxImageOptions) !== "current") {
    console.log(`\nSandbox image ${sandboxImageOptions.imageName} is stale — rebuilding… (about 2-4 minutes)`);
  }
  try {
    if (prepareSandboxImage(sandboxImageOptions) === "rebuilt") {
      console.log("Sandbox image rebuilt.");
    }
  } catch (error) {
    const stdout = error instanceof Error && "stdout" in error ? error.stdout : "";
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : "";
    const output = `${stdout ?? ""}${stderr ?? ""}` || String(error);
    console.error(
      `\nSandbox image build failed. End of the build output:\n${output.slice(-CHECK_OUTPUT_TAIL_CHARS)}`,
    );
    process.exit(1);
  }
}

await preflightSandbox();

// Each provider's gate in turn, so a spent Gemini quota at startup is slept
// through like a spent Claude one — each on its own reset, never past the end.
// With several Codex accounts, begin on the first with quota. The saved reset
// of a single account says nothing about the others, so the live readings
// replace the Codex gate here; if every account is spent, the Codex probe below
// stops or waits under the same rules as a mid-run stop.
const MULTI_CODEX = (CODEX_ACCOUNTS?.length ?? 0) > 1;
if (MULTI_CODEX && ROLE_PLAN.quotaProviders.includes("codex") && !DRY_RUN) {
  const first = CODEX_ACCOUNTS!.find((account) => !readCodexQuota(account)?.spent);
  if (first !== undefined && first !== CODEX_ACCOUNT) {
    console.log(`\nCodex account "${CODEX_ACCOUNT}" is out of quota; starting on "${first}".`);
    switchCodexAccount(first);
  }
}
for (const provider of QUOTA_PROVIDERS) {
  if (provider === "codex" && MULTI_CODEX) continue;
  const gate = quotaGate(runState.readQuotaReset(provider), new Date(), IGNORE_QUOTA_GATE);
  if (gate.allowed) continue;
  const plan = planQuotaWait({
    provider,
    kind: "session",
    resets: quotaResets(),
    now: new Date(),
    waiting: WAIT_FOR_QUOTA,
    endAt: END_AT,
  });
  if (!plan.wait) {
    console.error(
      `\n${PROVIDER_NAMES[provider]} quota resets at ${localTime(gate.resetAt)} — ${gate.minutesLeft} minute(s) from now. Nothing was started${WAIT_FOR_QUOTA ? `, because ${plan.reason}` : ""}. Set SANDCASTLE_IGNORE_QUOTA_GATE=1 to run anyway.`,
    );
    process.exit(1);
  }
  await sleepUntil(plan.until, `${PROVIDER_NAMES[provider]} quota is spent.`);
}
const startGate: QuotaGateDecision = ROLE_PLAN.quotaProviders.includes("claude")
  ? quotaGate(runState.readQuotaReset("claude"), new Date(), IGNORE_QUOTA_GATE)
  : { allowed: true };

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

/** Push once with captured output; the group owns logging and outage retry. */
async function pushBranch(branch: string): Promise<void> {
  // --no-verify: the pre-push hook would lint this checkout, not the branch;
  // CHECK_COMMAND already linted the branch in the sandbox.
  execSync(`git push --no-verify -u origin ${branch}`, { stdio: "pipe" });
}

const CLAUDE_PROBE_MODEL = "claude-haiku-4-5";

/**
 * What a host quota probe found: the stop that ends the run, a quota that is
 * holding, or no answer at all — an agent that isn't installed, or a call that
 * failed for a reason the classifier doesn't name. No answer is not a clean
 * quota, so every caller has to say which it got.
 */
type QuotaProbe = { kind: "stop"; stop: RunFatalError } | { kind: "clear" } | { kind: "no-answer"; why: string };

/**
 * One tiny call to `binary` on the host, so quota spent elsewhere is caught
 * before any sandbox is paid for — Claude's probe, and `agy`'s under
 * `--implementer agy` (#729).
 */
function runQuotaProbe(binary: string, model: string): QuotaProbe {
  let output: string;
  /** What a failed call printed; undefined while the call is still fine. */
  let printed: string | undefined;
  // `claude` would otherwise save each probe as a session, cluttering `--resume`.
  const args = ["-p", "Reply with the single word: ok", "--model", model];
  if (binary === "claude") args.push("--no-session-persistence");
  try {
    output = execFileSync(binary, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "no-answer", why: `no \`${binary}\` binary on this machine` };
    }
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    printed = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    output = `${printed}\n${errorText(error)}`;
  }
  try {
    throwIfRunFatal(output);
  } catch (rethrown) {
    return { kind: "stop", stop: rethrown as RunFatalError };
  }
  if (printed !== undefined) {
    // What the agent printed, not the Node stack that follows it in `output`.
    const tail = printed.slice(-PROBE_FAILURE_CHARS) || "it printed nothing";
    return { kind: "no-answer", why: `\`${binary}\` failed: ${tail}` };
  }
  return { kind: "clear" };
}

/** The stop a probe found, saying so when it could not answer at all. */
function probeQuota(binary: string, model: string): RunFatalError | undefined {
  const probe = runQuotaProbe(binary, model);
  if (probe.kind === "no-answer") console.warn(`\nWarning: quota not checked — ${probe.why}.`);
  return probe.kind === "stop" ? probe.stop : undefined;
}

/** The dry-run plan's one-line reading of a probe. */
function describeQuotaProbe(probe: QuotaProbe): string {
  switch (probe.kind) {
    case "stop":
      return probe.stop.message;
    case "clear":
      return "ok.";
    case "no-answer":
      return `not checked — ${probe.why}.`;
  }
}

/** Every provider's saved reset, for the wait planner to pick the stopped one's from. */
function quotaResets(): Record<QuotaProvider, Date | undefined> {
  return {
    claude: runState.readQuotaReset("claude"),
    gemini: runState.readQuotaReset("gemini"),
    codex: runState.readQuotaReset("codex"),
  };
}

/**
 * When the spent Gemini quota resets and which limit it is, from `agy -p
 * "/usage"` on the host — an `AGY_ERROR` line names neither (#732). Undefined
 * when the output can't be read or names no spent Gemini limit.
 */
function readGeminiQuotaReset(): { resetAt: Date; kind: QuotaStopKind } | undefined {
  try {
    const usage = execFileSync("agy", ["-p", "/usage"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return parseGeminiQuotaReset(usage, new Date());
  } catch (error) {
    console.warn(`\nWarning: could not read Gemini's reset time from \`agy -p "/usage"\` — ${errorText(error)}`);
    return undefined;
  }
}

/**
 * Codex's quota as its app-server on the host reports it (lib/codex.mts).
 * Undefined, with a warning, when the server can't be asked or read.
 * `account` names a listed account to read under its own home; omitted, the run's current `CODEX_HOME`.
 */
function readCodexQuota(account?: string): CodexQuotaReading | undefined {
  try {
    const env = account === undefined ? process.env : { ...process.env, CODEX_HOME: resolveCodexHome(account) };
    return parseCodexRateLimits(appServerRequest("account/rateLimits/read", {}, env), new Date());
  } catch (error) {
    console.warn(`\nWarning: could not read Codex's quota from \`codex app-server\` — ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Codex's quota probe: free, since the app-server reads the quota without a model call.
 * `account` names a listed account to probe under its own home; omitted, the run's current `CODEX_HOME`.
 */
function runCodexQuotaProbe(account?: string): QuotaProbe {
  let reading: CodexQuotaReading;
  try {
    // Under that account's CODEX_HOME when one is named; otherwise the run's own.
    const env = account === undefined ? process.env : { ...process.env, CODEX_HOME: resolveCodexHome(account) };
    reading = parseCodexRateLimits(appServerRequest("account/rateLimits/read", {}, env), new Date());
  } catch (error) {
    const why =
      error instanceof CodexMissingError ? error.message : `\`codex app-server\` failed: ${(error as Error).message}`;
    return { kind: "no-answer", why };
  }
  if (!reading.spent) return { kind: "clear" };
  const when = reading.resetAt ? ` until ${localTime(reading.resetAt)}` : "";
  return {
    kind: "stop",
    stop: new RunFatalError("quota", `Codex reports its ${reading.kind} limit spent${when}`, {
      resetAt: reading.resetAt,
      quotaStop: reading.kind,
      provider: "codex",
      reason: "Codex usage limit reached — re-run when it resets",
    }),
  };
}

/** The stop Codex's probe found, saying so when it could not answer at all. */
function probeCodexQuota(): RunFatalError | undefined {
  const probe = runCodexQuotaProbe();
  if (probe.kind === "no-answer") console.warn(`\nWarning: Codex quota not checked — ${probe.why}.`);
  return probe.kind === "stop" ? probe.stop : undefined;
}

/** Codex sessions of this run by issue number, resumed after an account swap. */
const codexSessions = new Map<number, string>();

/**
 * Carry on with another listed Codex account (#1234): point `CODEX_HOME` and the
 * run state at it, renew its access token when it would not outlast the run, and
 * re-stage the sandbox sign-in. Staging rewrites the staged file in place, so
 * every running sandbox's bind mount follows it without a rebuild.
 */
function switchCodexAccount(account: string): void {
  CODEX_ACCOUNT = account;
  process.env.CODEX_HOME = resolveCodexHome(account);
  runState.useCodexAccount(account);
  const expiresAt = accessTokenExpiry(readFileSync(codexAuthFile(), "utf-8"));
  if (expiresAt !== undefined && expiresAt.getTime() - Date.now() < MIN_ACCESS_TOKEN_LIFE_MS) {
    try {
      renewHostCodexSignIn();
    } catch (error) {
      console.warn(`\nWarning: could not renew Codex account "${account}"'s sign-in — ${(error as Error).message}`);
    }
  }
  stageCodexAuth(CODEX_STAGED_AUTH);
}

/**
 * The one quota path, shared by an agent's quota stop and the probe: record the
 * stopped provider's reset time and, while waiting is on, sleep until it — or,
 * with no reset time known, an hour at a time with a probe of that provider
 * after each. Returns the stop that ends the run, or undefined when it waited
 * and the run should carry on.
 */
async function handleQuotaStop(stop: RunFatalError): Promise<RunFatalError | undefined> {
  let current = stop;
  while (current.kind === "quota") {
    const provider = current.provider;
    let kind = current.quotaStop ?? "session";
    let codexAccounts: { accounts: string[]; current: string; readings: Record<string, CodexQuotaReading | undefined> } | undefined;
    if (provider === "codex") {
      const reading = readCodexQuota();
      if (reading?.spent) {
        if (reading.resetAt) runState.recordQuotaReset("codex", reading.resetAt);
        kind = reading.kind;
      }
      if (CODEX_ACCOUNTS && CODEX_ACCOUNTS.length > 1 && CODEX_ACCOUNT !== undefined) {
        const readings: Record<string, CodexQuotaReading | undefined> = { [CODEX_ACCOUNT]: reading };
        for (const account of CODEX_ACCOUNTS) {
          if (account === CODEX_ACCOUNT) continue;
          const other = readCodexQuota(account);
          readings[account] = other;
          if (other?.spent && other.resetAt) runState.recordQuotaReset("codex", other.resetAt, account);
        }
        codexAccounts = { accounts: CODEX_ACCOUNTS, current: CODEX_ACCOUNT, readings };
      }
    } else if (provider === "gemini") {
      const reset = readGeminiQuotaReset();
      if (reset) {
        runState.recordQuotaReset("gemini", reset.resetAt);
        kind = reset.kind;
      } else if (current.resetAt) {
        runState.recordQuotaReset("gemini", current.resetAt);
      }
    } else if (current.resetAt) {
      runState.recordQuotaReset("claude", current.resetAt);
    }
    const plan = planQuotaWait({
      provider,
      kind,
      resets: quotaResets(),
      now: new Date(),
      waiting: WAIT_FOR_QUOTA,
      endAt: END_AT,
      codex: codexAccounts,
    });
    const name = PROVIDER_NAMES[provider];
    if (plan.swapTo !== undefined) {
      console.log(`\nCodex account "${CODEX_ACCOUNT}" is out of quota; switching to "${plan.swapTo}".`);
      switchCodexAccount(plan.swapTo);
      return undefined;
    }
    if (provider === "codex") {
      const resetAt = quotaResets().codex;
      const allSpent = codexAccounts?.accounts.map((account) => {
        const reading = codexAccounts.readings[account];
        const at = (reading?.spent ? reading.resetAt : undefined) ?? (account === CODEX_ACCOUNT ? resetAt : undefined);
        return { account, resetAt: at && localTime(at) };
      });
      console.error(`\n${codexQuotaStopMessage(CODEX_ACCOUNT, resetAt && localTime(resetAt), plan.wait, allSpent)}`);
    }
    if (!plan.wait) {
      if (WAIT_FOR_QUOTA) console.error(`\nNot waiting for the ${name} quota: ${plan.reason}.`);
      return current;
    }
    // Waiting on another account: carry on with it once it has reset.
    const continueOn = (): void => {
      if (plan.account === undefined || plan.account === CODEX_ACCOUNT) return;
      console.log(`\nCodex account "${CODEX_ACCOUNT}" is out of quota; switching to "${plan.account}".`);
      switchCodexAccount(plan.account);
    };
    if (!plan.recheck) {
      await sleepUntil(plan.until, `${name} quota stop (reset plus ${QUOTA_WAIT_MARGIN_MS / 60_000} minutes).`);
      continueOn();
      return undefined;
    }
    await sleepUntil(plan.until, `${name} quota stop with no reset time — checking again in an hour.`);
    continueOn();
    const again =
      provider === "codex"
        ? probeCodexQuota()
        : provider === "gemini"
          ? probeQuota("agy", AGY_PROBE_MODEL)
          : probeQuota("claude", CLAUDE_PROBE_MODEL);
    if (!again) return undefined;
    current = again;
  }
  return current;
}

if (
  ROLE_PLAN.quotaProviders.includes("claude") &&
  shouldProbeQuota(startGate, runState.readQuotaReset("claude"), new Date(), DRY_RUN)
) {
  const probeStop = probeQuota("claude", CLAUDE_PROBE_MODEL);
  if (probeStop) fatal = await handleQuotaStop(probeStop);
}

// A spent Gemini quota has to stop the run before any sandbox is built too,
// whenever any role in the plan is agy.
if (!fatal && ROLE_PLAN.quotaProviders.includes("gemini")) {
  const agyProbeStop = probeQuota("agy", AGY_PROBE_MODEL);
  if (agyProbeStop) fatal = await handleQuotaStop(agyProbeStop);
}

// And a spent Codex quota, whenever any role in the plan is Codex.
if (!fatal && ROLE_PLAN.quotaProviders.includes("codex")) {
  const codexProbeStop = probeCodexQuota();
  if (codexProbeStop) fatal = await handleQuotaStop(codexProbeStop);
}

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
      const pushed = await refreshBranch({
        git: {
          branchesMatching,
          createBranch: (head, from) => { sh(`git branch ${head} ${from}`); },
          catchUp: fetchAndCatchUp,
          isBehindBase: (head) => isBehind(REPO_CWD, head, BASE_REF),
        },
        prTitle: async (head) => ghCommand(["pr", "view", head, "--json", "title", "--jq", ".title"]),
        createIntegrationSandbox,
        push: pushBranch,
        githubCall,
        log: (message) => console.log(message),
      }, { baseRef: BASE_REF }, branch);
      if (pushed) refreshed++;
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
  // A Gemini stop's reset came from `agy -p "/usage"` into the run state, not from its message.
  const resetAt = fatal.kind === "quota" ? (fatal.resetAt ?? runState.readQuotaReset(fatal.provider)) : undefined;
  if (resetAt && resetAt.getTime() > Date.now()) {
    console.error(`${PROVIDER_NAMES[fatal.provider]} quota resets at ${localTime(resetAt)}.`);
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
