// Codex (`codex`) in the loop: its sign-in, the home folder its sandboxes get,
// its quota and its token rows. The agent itself is the engine's own `codex()`
// provider, which runs `codex exec --json --dangerously-bypass-approvals-and-sandbox`;
// the container is the sandbox, so Codex's own one stays off.
//
// Checked against codex-cli 0.169.0 on 2026-11-15:
// - Quota: `codex app-server` answers `account/rateLimits/read` with each
//   limit window's `usedPercent`, `windowDurationMins` and `resetsAt` (Unix
//   seconds), without a model call, so reading the quota spends none of it.
//   The server answers only while its stdin stays open: piping the requests
//   in and closing stdin exits it unanswered, hence `appServerRequest`.
// - Hooks: a linked git worktree reads its project `.codex/` from the main
//   checkout's working tree, which the sandbox does not mount (only that
//   checkout's `.git` is), so the repo's project hooks and rules never load
//   there. The sandbox gets them at user level instead, in a `~/.codex` of its
//   own (`sandboxCodexMounts`).
// - Hook trust: Codex runs a hook only once its `hooks.state` entry, keyed by
//   the hooks file's path and the hook's place in it, records the hook's
//   `trusted_hash`. The hash is of the hook's definition, not its path (the
//   main checkout's and a worktree's copy of one file hash alike), so the host
//   asks `hooks/list` for it from a stand-in home holding the same file
//   (`codexHookTrust`) and the sandbox's config records it under the sandbox
//   path. A `trusted_hash` written ahead of time is honoured: `hooks/list`
//   then reports the hook `trusted`.
// - Tokens: each `token_count` event in a session file carries the request's
//   own `last_token_usage`, so a step's tokens are summed from those rather
//   than diffed from a running total.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseCodexAccountList, type QuotaStopKind } from "./overnight.mts";

/** Where Codex keeps its home inside the sandbox image: the agent user's `~/.codex`. */
export const CODEX_SANDBOX_HOME = "/home/agent/.codex";

/** The host's Codex home: `$CODEX_HOME`, else `~/.codex`. */
export function hostCodexHome(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(home, ".codex");
}

/**
 * The Codex home a run uses: `~/.codex-NAME` for a named account, else the
 * default (`$CODEX_HOME`, else `~/.codex`). The folder convention is fixed.
 */
export function resolveCodexHome(
  account: string | undefined,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return account === undefined ? hostCodexHome(home, env) : join(home, `.codex-${account}`);
}

/** The accounts `$CODEX_ACCOUNT` lists when no flag does, under the flag's name rule; undefined when unset. Throws on a bad name. */
export function defaultCodexAccount(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const value = env.CODEX_ACCOUNT;
  if (!value) return undefined;
  return parseCodexAccountList(value, "CODEX_ACCOUNT");
}

/** The startup error for a missing account sign-in: the exact `codex login` to run. */
export function missingCodexAccountMessage(account: string, codexHome: string): string {
  return `needs Codex account "${account}", whose sign-in is missing:\n  ${codexAuthFile(codexHome)}\n\nRun \`CODEX_HOME=~/.codex-${account} codex login\`, then re-run Sandcastle.`;
}

/**
 * What a Codex usage-limit stop prints: the account (or default sign-in), when
 * it resets, and how to swap accounts, whether the run sleeps or stops (#1205).
 */
export function codexQuotaStopMessage(
  account: string | undefined,
  resetAt: string | undefined,
  sleeping: boolean,
  /** Every listed account's reset, when more than one is listed and all are spent. */
  allSpent?: { account: string; resetAt: string | undefined }[],
): string {
  if (allSpent && allSpent.length > 1) {
    const lines = allSpent.map(
      (entry) => `  "${entry.account}" resets ${entry.resetAt === undefined ? "at an unknown time" : `at ${entry.resetAt}`}`,
    );
    return `Every listed Codex account is out of quota:\n${lines.join("\n")}`;
  }
  const who = account === undefined ? "the default Codex sign-in" : `Codex account "${account}"`;
  const when = resetAt === undefined ? "at an unknown time" : `at ${resetAt}`;
  // The default sign-in can't be listed (named accounts only), so its hint is how to add a named one.
  if (account === undefined) {
    return `${who} is out of quota; it resets ${when}. To carry on with another account, sign a named one in with \`CODEX_HOME=~/.codex-NAME codex login\`, then list it: --codex-account NAME.`;
  }
  const next = sleeping
    ? "To carry on without waiting, list a second account: --codex-account NAME,OTHER."
    : "Wait, or list a second account to swap to: --codex-account NAME,OTHER.";
  return `${who} is out of quota; it resets ${when}. ${next}`;
}

/** The sign-in file `codex login` writes, holding the ChatGPT tokens or an API key. */
export function codexAuthFile(codexHome: string = hostCodexHome()): string {
  return join(codexHome, "auth.json");
}

/**
 * How long the host's access token must still be good for when a run starts,
 * or the host renews it first: the sandboxes cannot renew it themselves
 * (`sandboxAuth`). Longer than any run, --overnight included.
 */
export const MIN_ACCESS_TOKEN_LIFE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * When a sign-in's access token expires, read from its JWT's `exp` claim;
 * undefined for an API-key sign-in or a token that doesn't parse.
 */
export function accessTokenExpiry(authJson: string): Date | undefined {
  try {
    const token = (JSON.parse(authJson) as { tokens?: { access_token?: unknown } }).tokens?.access_token;
    if (typeof token !== "string") return undefined;
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sign-in a sandbox gets: the host's, its refresh token blanked. ChatGPT's
 * refresh tokens work once, and Codex saves a renewed sign-in by renaming a
 * new file over `auth.json`, which a single-file bind mount refuses. A sandbox
 * renewing with the host's refresh token would spend it and lose the new one,
 * signing the developer's own Codex out at its next renewal. With no refresh
 * token the worst a sandbox can do is fail its own renewal, which stops the
 * run (`isCodexAuthStop`); the host renews instead, before staging. An API-key
 * sign-in, with no tokens, is passed through as it is.
 */
export function sandboxAuth(authJson: string): string {
  const auth = JSON.parse(authJson) as { tokens?: Record<string, unknown> };
  if (auth.tokens === undefined || auth.tokens === null) return authJson;
  return JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "" } }, null, 2);
}

/**
 * Copy the host's Codex sign-in, as `sandboxAuth` makes it, to `stagedPath`,
 * which the sandboxes mount. The host's own file is never mounted. Rewrites in
 * place, never by rename, so a running sandbox's bind mount keeps following
 * the file, and only when it changed. Returns whether the host has a sign-in
 * to stage.
 */
export function stageCodexAuth(stagedPath: string, authFile: string = codexAuthFile()): boolean {
  if (!existsSync(authFile)) return false;
  const token = Buffer.from(sandboxAuth(readFileSync(authFile, "utf-8")));
  const staged = existsSync(stagedPath) ? readFileSync(stagedPath) : undefined;
  if (staged === undefined || !staged.equals(token)) {
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, token, { mode: 0o600 });
    chmodSync(stagedPath, 0o600);
  }
  return true;
}

/**
 * Renew the host's own Codex sign-in through its app-server (`account/read`
 * with `refreshToken`), which spends no quota. Codex saves the renewal to the
 * host's `auth.json` under its own lock, so a host Codex running alongside
 * keeps working. Renews unconditionally, so it is called only when the access
 * token is near expiry. Throws when Codex could not renew.
 */
export function renewHostCodexSignIn(): void {
  appServerRequest("account/read", { refreshToken: true });
}

/** One hook Codex found, as `hooks/list` reports it. */
export interface ListedHook {
  readonly key: string;
  readonly currentHash: string;
}

/**
 * The sandbox's `config.toml`: every hook of the user-level hooks file trusted
 * under its sandbox path. `standInHooksFile` is where `hooks/list` saw the same
 * file on the host; a hook's key is that path plus its place in the file
 * (`<path>:pre_tool_use:0:0`), so only the path part is swapped.
 */
export function sandboxCodexConfig(hooks: readonly ListedHook[], standInHooksFile: string): string {
  const sandboxHooksFile = `${CODEX_SANDBOX_HOME}/hooks.json`;
  const lines = [
    "# Written by Sandcastle for every Codex sandbox (.sandcastle/lib/codex.mts); not the developer's config.",
    "",
    "[hooks.state]",
  ];
  for (const { key, currentHash } of hooks) {
    if (!key.startsWith(`${standInHooksFile}:`)) continue;
    const sandboxKey = `${sandboxHooksFile}${key.slice(standInHooksFile.length)}`;
    lines.push("", `[hooks.state.${JSON.stringify(sandboxKey)}]`, `trusted_hash = ${JSON.stringify(currentHash)}`, "enabled = true");
  }
  return `${lines.join("\n")}\n`;
}

// A Node child that speaks to `codex app-server` over stdio and prints the one
// response asked for. Run synchronously, since the quota probe is synchronous
// everywhere it is called. argv: method, JSON params, timeout in ms.
const APP_SERVER_CLIENT = `
const { spawn } = require("node:child_process");
const [method, params, timeoutMs] = process.argv.slice(1);
const server = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
const done = (code, text) => { (code === 0 ? process.stdout : process.stderr).write(text); server.kill(); process.exit(code); };
server.on("error", (error) => done(error.code === "ENOENT" ? 127 : 1, String(error.message)));
setTimeout(() => done(1, "codex app-server did not answer within " + timeoutMs + " ms"), Number(timeoutMs));
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== 2) continue;
    if (message.error) done(1, JSON.stringify(message.error));
    done(0, JSON.stringify(message.result));
  }
});
const send = (message) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
send({ id: 1, method: "initialize", params: { clientInfo: { name: "sandcastle", version: "0" } } });
send({ method: "initialized" });
send({ id: 2, method, params: JSON.parse(params) });
`;

/** Thrown when there is no `codex` on the host to ask. */
export class CodexMissingError extends Error {}

/** Ask the host's `codex app-server` one request and return its result. Throws on any failure. */
export function appServerRequest(
  method: string,
  params: unknown = {},
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 60_000,
): unknown {
  try {
    const out = execFileSync(process.execPath, ["-e", APP_SERVER_CLIENT, method, JSON.stringify(params), String(timeoutMs)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: timeoutMs + 10_000,
    });
    return JSON.parse(out);
  } catch (error) {
    const { status, stderr } = error as { status?: number; stderr?: string };
    if (status === 127) throw new CodexMissingError("no `codex` binary on this machine");
    throw new Error(stderr?.trim() || (error as Error).message);
  }
}

/**
 * The hooks Codex finds in `hooksFile` when it is the user-level hooks file,
 * read from a stand-in home holding only a copy of it: no sign-in, so the
 * developer's own Codex home is never touched. Returns the stand-in path the
 * keys name alongside them.
 */
export function codexHookTrust(hooksFile: string): { hooks: ListedHook[]; standInHooksFile: string } {
  // Real path: Codex keys a hook by the resolved path (macOS's /var is /private/var).
  const standIn = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-codex-home-")));
  try {
    const standInHooksFile = join(standIn, "hooks.json");
    copyFileSync(hooksFile, standInHooksFile);
    const result = appServerRequest("hooks/list", { cwds: [standIn] }, { ...process.env, CODEX_HOME: standIn }) as {
      data?: { hooks?: { key?: unknown; currentHash?: unknown; source?: unknown }[] }[];
    };
    const hooks = (result.data ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .filter((hook) => hook.source === "user")
      .flatMap((hook) =>
        typeof hook.key === "string" && typeof hook.currentHash === "string"
          ? [{ key: hook.key, currentHash: hook.currentHash }]
          : [],
      );
    return { hooks, standInHooksFile };
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }
}

/** How many hooks a hooks file defines, to check `hooks/list` found every one. */
export function countHooks(hooksJson: string): number {
  const { hooks } = JSON.parse(hooksJson) as { hooks?: Record<string, { hooks?: unknown[] }[]> };
  return Object.values(hooks ?? {})
    .flat()
    .reduce((sum, group) => sum + (group.hooks?.length ?? 0), 0);
}

/** A limit window at or past which a stop is weekly, not waited out (overnight.mts). */
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;

/** A spent Codex quota: when it lifts, and which kind of limit it is. */
export type CodexQuotaReading = { spent: false } | { spent: true; resetAt: Date | undefined; kind: QuotaStopKind };

type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;

/**
 * Read an `account/rateLimits/read` result. Spent when Codex says ordinary use
 * is not allowed, names the limit it reached, or any window reads 100% used.
 * Every spent window must reset before a call goes through, so the latest
 * reset wins, and a window of a week or more makes it a weekly stop.
 */
export function parseCodexRateLimits(result: unknown, now: Date): CodexQuotaReading {
  const { ordinaryUsageAllowed, rateLimits } = (result ?? {}) as {
    ordinaryUsageAllowed?: unknown;
    rateLimits?: { primary?: Window; secondary?: Window; rateLimitReachedType?: unknown } | null;
  };
  const windows = [rateLimits?.primary, rateLimits?.secondary].filter(
    (w): w is NonNullable<Window> => typeof w === "object" && w !== null,
  );
  const full = windows.filter((w) => typeof w.usedPercent === "number" && w.usedPercent >= 100);
  const reached = ordinaryUsageAllowed === false || (rateLimits?.rateLimitReachedType ?? null) !== null;
  if (full.length === 0 && !reached) return { spent: false };
  // Codex named the limit but no window reads full: any window could be it.
  const spentWindows = full.length > 0 ? full : windows;
  let resetAt: Date | undefined;
  let weekly = false;
  for (const w of spentWindows) {
    if (typeof w.resetsAt !== "number") continue;
    const at = new Date(w.resetsAt * 1000);
    if (at.getTime() <= now.getTime()) continue;
    if (!resetAt || at.getTime() > resetAt.getTime()) {
      resetAt = at;
      weekly = typeof w.windowDurationMins === "number" && w.windowDurationMins >= WEEKLY_WINDOW_MINS;
    }
  }
  return { spent: true, resetAt, kind: weekly ? "weekly" : "session" };
}

/** Tokens one Codex step spent, the token table's four columns. */
export interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
}

/**
 * Tokens a captured Codex session file spent at or after `sinceMs`. Each
 * request's `token_count` event carries its own `last_token_usage`; Codex
 * repeats the event unchanged when only the rate limits moved, so an event
 * whose running total did not change is skipped. A resumed session's file
 * holds the earlier steps' events again, so events already in `counted` are
 * skipped and new ones added to it. Input excludes cached input, which is
 * Cache-read; Output excludes reasoning, which is Thinking.
 */
export function codexSessionUsage(jsonl: string, sinceMs: number, counted: Set<string>): CodexUsage {
  const total: CodexUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0 };
  let previousTotal: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const info = entry.payload?.type === "token_count" ? entry.payload.info : undefined;
    if (entry.type !== "event_msg" || !info?.last_token_usage) continue;
    const runningTotal = JSON.stringify(info.total_token_usage);
    if (runningTotal === previousTotal) continue;
    previousTotal = runningTotal;
    const key = `${entry.timestamp}\0${runningTotal}`;
    if (counted.has(key) || !(Date.parse(entry.timestamp) >= sinceMs)) continue;
    counted.add(key);
    const usage = info.last_token_usage;
    const cached = usage.cached_input_tokens ?? 0;
    const reasoning = usage.reasoning_output_tokens ?? 0;
    total.inputTokens += Math.max(0, (usage.input_tokens ?? 0) - cached);
    total.cacheReadTokens += cached;
    total.thinkingTokens += reasoning;
    total.outputTokens += Math.max(0, (usage.output_tokens ?? 0) - reasoning);
  }
  return total;
}

/**
 * The sandbox's own `~/.codex`, as bind-mounts: the staged sign-in and config
 * (writable: Codex may refresh the token or record state), and the repo's
 * Codex hooks file and rules folder read-only, installed at user level because
 * the sandbox never loads the project's `.codex/` (see the header).
 */
export function sandboxCodexMounts(paths: {
  stagedAuth: string;
  stagedConfig: string;
  hooksFile: string;
  rulesDir?: string;
}): { hostPath: string; sandboxPath: string; readonly?: boolean }[] {
  return [
    { hostPath: paths.stagedAuth, sandboxPath: `${CODEX_SANDBOX_HOME}/auth.json` },
    { hostPath: paths.stagedConfig, sandboxPath: `${CODEX_SANDBOX_HOME}/config.toml` },
    { hostPath: paths.hooksFile, sandboxPath: `${CODEX_SANDBOX_HOME}/hooks.json`, readonly: true },
    ...(paths.rulesDir === undefined
      ? []
      : [{ hostPath: paths.rulesDir, sandboxPath: `${CODEX_SANDBOX_HOME}/rules`, readonly: true }]),
  ];
}
