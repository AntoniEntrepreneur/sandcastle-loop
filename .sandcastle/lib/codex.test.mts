// Unit tests for Codex's host side: the quota reading, the sandbox's hook
// trust, its mounts, its token rows, and how its stream is judged.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CODEX_SANDBOX_HOME,
  accessTokenExpiry,
  codexQuotaStopMessage,
  defaultCodexAccount,
  codexSessionUsage,
  missingCodexAccountMessage,
  resolveCodexHome,
  sandboxAuth,
  countHooks,
  parseCodexRateLimits,
  sandboxCodexConfig,
  sandboxCodexMounts,
  stageCodexAuth,
} from "./codex.mts";
import { agentSaidText, isCodexQuotaStop } from "./groups.mts";
import { RunFatalError, throwIfRunFatal } from "./issueLoop.mts";

const NOW = new Date("2026-11-15T20:00:00Z");
const inHours = (hours: number) => Math.floor(NOW.getTime() / 1000) + hours * 3600;

/** An `account/rateLimits/read` result, shaped as codex-cli 0.169.0 answers it. */
function limits(primary: object | null, secondary: object | null = null, extra: object = {}) {
  return {
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: "codex", primary, secondary, rateLimitReachedType: null, planType: "plus", ...extra },
  };
}

/** Pins that a quota with room left reads as not spent. */
test("parseCodexRateLimits reads a quota with room left as not spent", () => {
  const result = limits(
    { usedPercent: 3, windowDurationMins: 300, resetsAt: inHours(2) },
    { usedPercent: 1, windowDurationMins: 10080, resetsAt: inHours(100) },
  );
  assert.deepEqual(parseCodexRateLimits(result, NOW), { spent: false });
});

/** Pins that a full five-hour window is a session stop that resets with that window. */
test("parseCodexRateLimits reads a full five-hour window as a session stop at its reset", () => {
  const result = limits(
    { usedPercent: 100, windowDurationMins: 300, resetsAt: inHours(2) },
    { usedPercent: 40, windowDurationMins: 10080, resetsAt: inHours(100) },
  );
  assert.deepEqual(parseCodexRateLimits(result, NOW), {
    spent: true,
    resetAt: new Date(inHours(2) * 1000),
    kind: "session",
  });
});

/** Pins that a full weekly window makes a weekly stop, which overnight mode does not wait out. */
test("parseCodexRateLimits reads a full weekly window as a weekly stop", () => {
  const result = limits(
    { usedPercent: 100, windowDurationMins: 300, resetsAt: inHours(2) },
    { usedPercent: 100, windowDurationMins: 10080, resetsAt: inHours(100) },
  );
  assert.deepEqual(parseCodexRateLimits(result, NOW), {
    spent: true,
    resetAt: new Date(inHours(100) * 1000),
    kind: "weekly",
  });
});

/** Pins that Codex's own verdict counts even when no window reads 100%. */
test("parseCodexRateLimits trusts ordinaryUsageAllowed false and a named reached limit", () => {
  const primary = { usedPercent: 99, windowDurationMins: 300, resetsAt: inHours(1) };
  assert.equal(parseCodexRateLimits({ ...limits(primary), ordinaryUsageAllowed: false }, NOW).spent, true);
  assert.equal(parseCodexRateLimits(limits(primary, null, { rateLimitReachedType: "primary" }), NOW).spent, true);
});

/** Pins that an answer with no limits at all (an API-key sign-in) reads as not spent. */
test("parseCodexRateLimits reads missing rate limits as not spent", () => {
  assert.deepEqual(parseCodexRateLimits({ rateLimits: null }, NOW), { spent: false });
  assert.deepEqual(parseCodexRateLimits(undefined, NOW), { spent: false });
});

/** Pins the sandbox config: the stand-in path swapped for the sandbox's, other keys left out. */
test("sandboxCodexConfig trusts each hook under the sandbox's hooks path", () => {
  const standIn = "/private/var/folders/x/sandcastle-codex-home-ab/hooks.json";
  const toml = sandboxCodexConfig(
    [
      { key: `${standIn}:pre_tool_use:0:0`, currentHash: "sha256:aaa" },
      { key: "/elsewhere/.codex/hooks.json:pre_tool_use:0:0", currentHash: "sha256:bbb" },
    ],
    standIn,
  );
  assert.match(
    toml,
    /\[hooks\.state\."\/home\/agent\/\.codex\/hooks\.json:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:aaa"\nenabled = true/,
  );
  assert.doesNotMatch(toml, /bbb/);
});

/** Pins that every hook in the file is counted, so a hook Codex didn't list stops the run. */
test("countHooks counts every handler under every event", () => {
  const hooksJson = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command" }, { type: "command" }] }],
      Stop: [{ hooks: [{ type: "command" }] }],
    },
  });
  assert.equal(countHooks(hooksJson), 3);
  assert.equal(countHooks("{}"), 0);
});

/** Pins the sandbox's ~/.codex: sign-in and config writable, hooks and rules read-only. */
test("sandboxCodexMounts writes sign-in and config, and reads hooks and rules", () => {
  const mounts = sandboxCodexMounts({
    stagedAuth: "/cache/auth.json",
    stagedConfig: "/cache/config.toml",
    hooksFile: "/repo/.codex/hooks.json",
    rulesDir: "/repo/.codex/rules",
  });
  assert.deepEqual(mounts, [
    { hostPath: "/cache/auth.json", sandboxPath: `${CODEX_SANDBOX_HOME}/auth.json` },
    { hostPath: "/cache/config.toml", sandboxPath: `${CODEX_SANDBOX_HOME}/config.toml` },
    { hostPath: "/repo/.codex/hooks.json", sandboxPath: `${CODEX_SANDBOX_HOME}/hooks.json`, readonly: true },
    { hostPath: "/repo/.codex/rules", sandboxPath: `${CODEX_SANDBOX_HOME}/rules`, readonly: true },
  ]);
  assert.equal(
    sandboxCodexMounts({ stagedAuth: "a", stagedConfig: "c", hooksFile: "h" }).length,
    3,
  );
});

/** A ChatGPT sign-in as `codex login` writes it, its access token expiring at `exp` (Unix seconds). */
function chatgptAuth(exp: number, refresh = "rt-host") {
  const jwt = ["header", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "id", access_token: jwt, refresh_token: refresh, account_id: "acc" },
    last_refresh: "2026-11-15T17:13:17Z",
  });
}

/** Pins that the sign-in is staged without its refresh token, re-staged when it changes, and reported missing. */
test("stageCodexAuth copies the host sign-in, minus its refresh token, and reports a missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
  try {
    const host = join(dir, "auth.json");
    const staged = join(dir, "staged", "auth.json");
    assert.equal(stageCodexAuth(staged, host), false);
    writeFileSync(host, chatgptAuth(inHours(240), "rt-one"));
    assert.equal(stageCodexAuth(staged, host), true);
    const first = JSON.parse(readFileSync(staged, "utf-8"));
    assert.equal(first.tokens.refresh_token, "");
    assert.equal(first.tokens.account_id, "acc");
    assert.equal(first.auth_mode, "chatgpt");
    writeFileSync(host, chatgptAuth(inHours(300), "rt-two"));
    stageCodexAuth(staged, host);
    assert.equal(accessTokenExpiry(readFileSync(staged, "utf-8"))?.getTime(), inHours(300) * 1000);
    assert.doesNotMatch(readFileSync(staged, "utf-8"), /rt-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Pins that an API-key sign-in, which has no tokens to spend, reaches the sandbox unchanged. */
test("sandboxAuth passes an API-key sign-in through", () => {
  const apiKey = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test", tokens: null });
  assert.equal(sandboxAuth(apiKey), apiKey);
});

/** Pins that the access token's expiry is read from its JWT, and missing for anything else. */
test("accessTokenExpiry reads the access token's exp claim", () => {
  assert.equal(accessTokenExpiry(chatgptAuth(inHours(48)))?.getTime(), inHours(48) * 1000);
  assert.equal(accessTokenExpiry(JSON.stringify({ OPENAI_API_KEY: "sk-test", tokens: null })), undefined);
  assert.equal(accessTokenExpiry(JSON.stringify({ tokens: { access_token: "not-a-jwt" } })), undefined);
  assert.equal(accessTokenExpiry("not json"), undefined);
});

/** Pins that a sandbox whose sign-in can't renew stops the whole run as a Codex sign-in stop. */
test("throwIfRunFatal stops the run on Codex's failed sign-in renewal", () => {
  const failed = codexStream(
    { type: "thread.started", thread_id: "t1" },
    {
      type: "turn.failed",
      error: { message: "Your access token could not be refreshed. Please log out and sign in again." },
    },
  );
  assert.throws(
    () => throwIfRunFatal(failed),
    (error: unknown) =>
      error instanceof RunFatalError && error.kind === "auth" && error.provider === "codex" && /renews it on the host/.test(error.message),
  );
});

/** One `token_count` line of a Codex session file. */
function tokenCount(timestamp: string, total: number, last: { input: number; cached: number; output: number; reasoning: number }) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          output_tokens: last.output,
          reasoning_output_tokens: last.reasoning,
        },
      },
    },
  });
}

/** Pins a step's tokens: summed per request, repeats skipped, earlier steps not counted twice. */
test("codexSessionUsage sums each request once, splitting cache and reasoning out", () => {
  const first = tokenCount("2026-11-15T20:01:00Z", 100, { input: 100, cached: 40, output: 30, reasoning: 10 });
  const repeat = tokenCount("2026-11-15T20:01:01Z", 100, { input: 100, cached: 40, output: 30, reasoning: 10 });
  const second = tokenCount("2026-11-15T20:02:00Z", 250, { input: 150, cached: 100, output: 20, reasoning: 0 });
  const before = tokenCount("2026-11-15T19:00:00Z", 50, { input: 50, cached: 0, output: 5, reasoning: 0 });
  const counted = new Set<string>();
  const since = NOW.getTime();

  assert.deepEqual(codexSessionUsage([before, first, repeat, "not json", second].join("\n"), since, counted), {
    inputTokens: 60 + 50,
    outputTokens: 20 + 20,
    thinkingTokens: 10,
    cacheReadTokens: 40 + 100,
  });

  // A resumed step's file holds the earlier events again, then its own.
  const third = tokenCount("2026-11-15T20:05:00Z", 400, { input: 150, cached: 0, output: 7, reasoning: 2 });
  assert.deepEqual(codexSessionUsage([first, second, third].join("\n"), since, counted), {
    inputTokens: 150,
    outputTokens: 5,
    thinkingTokens: 2,
    cacheReadTokens: 0,
  });
});

/** A `codex exec --json` stream, one event per line. */
const codexStream = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");

/** Pins that a command's output in Codex's stream is never judged, only what Codex said. */
test("agentSaidText keeps Codex's messages and errors, not command output", () => {
  const stdout = codexStream(
    { type: "thread.started", thread_id: "t1" },
    {
      type: "item.completed",
      item: { type: "command_execution", command: "cat groups.mts", aggregated_output: "/usage limit reached/i" },
    },
    { type: "item.completed", item: { type: "agent_message", text: "Done with the issue." } },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "turn.failed", error: { message: "stream disconnected" } },
  );
  assert.equal(agentSaidText(stdout), "Done with the issue.\nReconnecting... 1/5\nstream disconnected");
});

/** Pins that Codex's usage-limit error stops the run on Codex's clock, and quoted output does not. */
test("throwIfRunFatal stops the run as a Codex quota stop on Codex's usage-limit error", () => {
  const spent = codexStream(
    { type: "thread.started", thread_id: "t1" },
    {
      type: "turn.failed",
      error: { message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 9:40 PM." },
    },
  );
  assert.throws(
    () => throwIfRunFatal(spent),
    (error: unknown) => error instanceof RunFatalError && error.kind === "quota" && error.provider === "codex",
  );

  const quoted = codexStream(
    { type: "thread.started", thread_id: "t1" },
    { type: "item.completed", item: { type: "command_execution", aggregated_output: "You've hit your usage limit." } },
    { type: "item.completed", item: { type: "agent_message", text: "All green." } },
  );
  assert.doesNotThrow(() => throwIfRunFatal(quoted));
});

/** Pins that Claude's own stop wording stays on Claude's clock. */
test("a Claude usage-limit message is not read as Codex's", () => {
  assert.equal(isCodexQuotaStop("Claude AI usage limit reached|1794780797"), false);
  assert.throws(
    () => throwIfRunFatal("Claude AI usage limit reached. Your limit will reset at 3pm (UTC)."),
    (error: unknown) => error instanceof RunFatalError && error.provider === "claude",
  );
});

/** Pins the account-to-folder rule, the missing-sign-in text, and the quota-stop message (#1201). */
test("a Codex account resolves to ~/.codex-NAME and its messages name the account", () => {
  assert.equal(resolveCodexHome("b", "/h", { CODEX_HOME: "/elsewhere" }), "/h/.codex-b");
  assert.equal(resolveCodexHome(undefined, "/h", {}), "/h/.codex");
  assert.equal(resolveCodexHome(undefined, "/h", { CODEX_HOME: "/elsewhere" }), "/elsewhere");
  assert.match(missingCodexAccountMessage("b", "/h/.codex-b"), /CODEX_HOME=~\/\.codex-b codex login/);
  const stop = codexQuotaStopMessage("b", "07:30", false);
  assert.match(stop, /account "b"/);
  assert.match(stop, /07:30/);
  assert.match(stop, /Wait, or list a second account/);
  assert.match(codexQuotaStopMessage(undefined, undefined, false), /default Codex sign-in/);
  assert.match(codexQuotaStopMessage("b", "07:30", true), /list a second account/);
  assert.match(codexQuotaStopMessage("b", "07:30", false), /list a second account/);
  assert.doesNotMatch(codexQuotaStopMessage("b", "07:30", true), /Ctrl-C/);
});

/** Pins that when every account is spent the stop names each account and its reset. */
test("codexQuotaStopMessage with every account spent names each account and its reset", () => {
  const all = [
    { account: "antoni", resetAt: "03:10" },
    { account: "main", resetAt: undefined },
  ];
  const message = codexQuotaStopMessage("antoni", "03:10", false, all);
  assert.match(message, /Every listed Codex account is out of quota/);
  assert.match(message, /"antoni" resets at 03:10/);
  assert.match(message, /"main" resets at an unknown time/);
  assert.doesNotMatch(message, /list a second account/);
});

/** Pins that $CODEX_ACCOUNT is the default account, under the same name rule as the flag. */
test("defaultCodexAccount reads $CODEX_ACCOUNT and refuses a bad name", () => {
  assert.deepEqual(defaultCodexAccount({ CODEX_ACCOUNT: "b" }), ["b"]);
  assert.deepEqual(defaultCodexAccount({ CODEX_ACCOUNT: "a,b,a" }), ["a", "b"]);
  assert.throws(() => defaultCodexAccount({ CODEX_ACCOUNT: "a,B" }), /CODEX_ACCOUNT wants a name/);
  assert.equal(defaultCodexAccount({}), undefined);
  assert.equal(defaultCodexAccount({ CODEX_ACCOUNT: "" }), undefined);
  assert.throws(() => defaultCodexAccount({ CODEX_ACCOUNT: "../x" }), /CODEX_ACCOUNT wants a name/);
});

/** Pins that the default sign-in's stop hint tells how to add a named account, not to list the default. */
test("codexQuotaStopMessage for the default sign-in explains signing a named account in", () => {
  const message = codexQuotaStopMessage(undefined, "07:30", false);
  assert.match(message, /codex login/);
  assert.match(message, /then list it/);
  assert.doesNotMatch(message, /list a second account/);
});
