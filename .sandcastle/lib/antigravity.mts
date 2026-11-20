// The Antigravity CLI (`agy`) as a Sandcastle AgentProvider — project code,
// not an engine change, because the engine's maintainer declines built-in
// providers and asks projects to implement its public interface themselves.
// Used by `--implementer agy` (#729/#725). Its conversation is resumed only
// inside the sandbox that holds it, so a fix round or a follow-up step keeps
// the conversation and a dead run starts cold on its branch next time; see
// `inSandboxSessions`. No parseSessionUsage: the token table reads the stream.
//
// Stream shape verified 2026-10-23 against `agy` 1.4.6: an `init` event
// carries `conversation_id`, `model`, `tools` and `permission_mode`;
// `step_update` events carry `text_delta` and a per-step `usage`; the final
// `result` event carries `status`, `response` and the run's total `usage` —
// the one the token table reads (#731), per-step usage is not summed here. On
// a resumed conversation that total is cumulative (turn 2's input 14900 =
// 7323 + 7577), so `recordStreamUsage` records the difference from the previous
// step. Resuming (verified #788): `--conversation <id> -p` works in print mode,
// and the resumed `init` repeats the same `conversation_id`. An unknown id
// prints `warning: conversation "<id>" not found` on stderr, exits 0 and
// starts a new conversation under a new id — which is why `inSandboxSessions`
// checks the sandbox before agy is ever asked to resume. An
// `AGY_ERROR` line is not JSON; it is `agy`'s own error channel (exit code 3
// on a spent quota or credits balance).
//
// Flags, checked against `agy --help` in the sandbox image: `-p` is a value
// flag (`--print <prompt>`), not a bare print-mode switch, and `--input-format`
// only switches to NDJSON turns, so the prompt reaches `-p` through `$(cat)`
// from the stdin the engine feeds (one argument, so well under the 128 KB
// Linux limit). The rest are `--output-format stream-json`, `--model <slug>`
// and `--dangerously-skip-permissions`. That last is passed unconditionally
// rather than trusting print mode's reported `always-proceed` default. No
// `--effort`, though `agy --help` now lists `--effort low|medium|high|xhigh|max`
// (#802): the `-medium` model variant stays how effort is chosen. A
// resumed run adds `--conversation <id>`, which `agy`'s changelog (1.1.x,
// "headless print mode resumption (`--conversation`/`-c` `-p ...`)") lists as
// resuming in print mode; the long form, since `-c` is easily read as
// `--continue`.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync as defaultExistsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentProvider, IterationUsage } from "@ai-hero/sandcastle";

import type { QuotaStopKind } from "./overnight.mts";

// The engine names this type ParsedStreamEvent but does not export it, so it
// is read back off the interface.
type StreamEvent = ReturnType<AgentProvider["parseStreamLine"]>[number];

/** Single-quote a value for the shell command string the sandbox runs. */
function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `agy`'s thinking tokens, carried alongside the engine's `IterationUsage`
 * fields. The engine's type has no `thinking` field, so the count rides on the
 * same object as an extra property the engine never reads but the token table
 * does (#731): `agy`'s thinking tokens are reported on their own, not folded
 * into `outputTokens` the way Claude's extended thinking is counted.
 */
interface AgyUsage extends IterationUsage {
  readonly thinkingTokens: number;
}

/** The thinking tokens on an iteration's usage, 0 when it did not come from `agy`. */
export function agyThinkingTokens(usage: IterationUsage): number {
  const { thinkingTokens } = usage as Partial<AgyUsage>;
  return typeof thinkingTokens === "number" ? thinkingTokens : 0;
}

/** `agy`'s total usage object, shaped `{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens }`. */
function parseAgyUsage(usage: unknown): AgyUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const {
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: thinking,
    cache_read_tokens: cacheRead,
  } = usage as Record<string, unknown>;
  if (typeof input !== "number" || typeof output !== "number" || typeof cacheRead !== "number") {
    return undefined;
  }
  return {
    inputTokens: input,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
    thinkingTokens: typeof thinking === "number" ? thinking : 0,
  };
}

/**
 * The fields this provider reads off an `agy` stream line, which names its
 * event in `event` and nests the payload under a key of the same name; each
 * use is guarded. Verified against a real run's output (#728).
 */
type AgyStreamLine = {
  event?: string;
  conversation_id?: string;
  step_update?: { text_delta?: string };
  result?: { response?: string; usage?: unknown };
};

/** Parse one line of `agy`'s NDJSON stream, or its non-JSON `AGY_ERROR` line. */
function parseAgyStreamLine(line: string): StreamEvent[] {
  if (!line.startsWith("{")) {
    // Not JSON: either agy's own error line, or a line no event maps to.
    return line.startsWith("AGY_ERROR") ? [{ type: "result", result: line }] : [];
  }
  try {
    const { event, conversation_id: conversationId, step_update: step, result } = JSON.parse(line) as AgyStreamLine;
    if (event === "init" && typeof conversationId === "string") {
      return [{ type: "session_id", sessionId: conversationId }];
    }
    if (event === "step_update" && typeof step?.text_delta === "string") {
      return [{ type: "text", text: step.text_delta }];
    }
    if (event === "result" && typeof result?.response === "string") {
      const events: StreamEvent[] = [{ type: "result", result: result.response }];
      const usage = parseAgyUsage(result.usage);
      if (usage) events.push({ type: "usage", usage });
      return events;
    }
  } catch {
    // Not valid JSON either — dropped, same as an unrecognised event type.
  }
  return [];
}

// Sign-in (#730): the sandbox needs only two host files, not the whole
// `~/.gemini` folder, which also holds unrelated settings and past
// conversations. Paths:
// - `oauth_creds.json` is the Google OAuth credentials file, shared by
//   Gemini CLI and `agy`. Its path comes from `Storage.getOAuthCredsPath()`
//   in google-gemini/gemini-cli (`packages/core/src/config/storage.ts`):
//   `path.join(homedir(), ".gemini", "oauth_creds.json")`. Its own
//   `oauth2.ts` rewrites it on the client's `tokens` event (a refresh is
//   such an event) via a temp-file rename, so the mount must be writable.
// - `antigravity-cli/antigravity-oauth-token` is `agy`'s own token; its path
//   is confirmed by a strace in
//   https://github.com/google-antigravity/antigravity-cli/issues/479, which
//   shows `agy` opening it O_RDONLY on startup in a headless (no-keyring)
//   container — the sandbox's own situation. The CLI's changelog (`agy
//   changelog`) lists proactive token refresh (1.1.23) and a file-storage
//   fallback when the keyring is unreachable (1.1.26), so this file is
//   rewritten the same way and is mounted writable too.
//   Resolved by the real runs of #728 (2026-10-25): issue #479 reports that a
//   fresh `agy` in this container shape reads a valid on-disk token and
//   still falls through to an interactive OAuth prompt that times out. It
//   did not here — the sandbox's `agy` signed in from these two mounted
//   files and committed to its branch, and a one-prompt capture in the
//   sandbox image, with copies of the files mounted as the container's
//   whole `~/.gemini`, streamed a normal run. Still unproven: that `agy`
//   ever rewrites either file, so whether the mounts need to be writable is
//   as above, from the other tools' behaviour. Mounting one file at a time
//   into a bare image leaves their parent folders root-owned and `agy` then
//   cannot create its `log` and `crashes` folders there; the engine's
//   sandbox did not hit that.
const GOOGLE_OAUTH_CREDS_RELATIVE = [".gemini", "oauth_creds.json"];
const ANTIGRAVITY_OAUTH_TOKEN_RELATIVE = [".gemini", "antigravity-cli", "antigravity-oauth-token"];

/** The container paths `agy` reads inside the sandbox, home-relative there too. */
export const AGY_SANDBOX_HOME = "/home/agent";

/** The two sign-in files `agy` needs, as absolute host paths under `home`. */
export function agySignInFiles(
  home: string = homedir(),
): { googleOAuthCreds: string; antigravityOAuthToken: string } {
  return {
    googleOAuthCreds: join(home, ...GOOGLE_OAUTH_CREDS_RELATIVE),
    antigravityOAuthToken: join(home, ...ANTIGRAVITY_OAUTH_TOKEN_RELATIVE),
  };
}

/**
 * Which sign-in files are missing, if any: the Google credentials on the host,
 * and `agy`'s token by its host path when no copy could be staged.
 */
export function missingAgySignInFiles(
  tokenStaged: boolean,
  home: string = homedir(),
  exists: (path: string) => boolean = defaultExistsSync,
): string[] {
  const files = agySignInFiles(home);
  return [
    ...(exists(files.googleOAuthCreds) ? [] : [files.googleOAuthCreds]),
    ...(tokenStaged ? [] : [files.antigravityOAuthToken]),
  ];
}

// The sandbox mounts a copy of `agy`'s token that Sandcastle owns, never the
// file at `agy`'s own host path, for two reasons found 2026-11-10 (agy 1.5.5):
// - On macOS, a host `agy` that can reach the Keychain keeps the token in a
//   Keychain item (service `gemini`, account `antigravity`) through
//   zalando/go-keyring, which wraps it as `go-keyring-base64:<base64>`, and
//   never writes the file. The file is that value unwrapped (JSON with a
//   `token` field); the wrapped value fails in the sandbox with
//   "authentication required".
// - A token file written at that path was gone seconds later, after the run's
//   own host `agy -p "/usage"` signed in through the Keychain, and the mount
//   then failed with "Mount hostPath does not exist". The host `agy` appears
//   to move a file token into the Keychain.
// Re-staging at every sandbox open copies the token the host keeps refreshed.
const AGY_KEYCHAIN_SERVICE = "gemini";
const AGY_KEYCHAIN_ACCOUNT = "antigravity";
const GO_KEYRING_BASE64 = "go-keyring-base64:";
const GO_KEYRING_HEX = "go-keyring-encoded:";

/** Unwrap a go-keyring Keychain value into the bytes `agy` keeps in its token file. */
export function decodeGoKeyringValue(value: string): Buffer {
  if (value.startsWith(GO_KEYRING_BASE64)) return Buffer.from(value.slice(GO_KEYRING_BASE64.length), "base64");
  if (value.startsWith(GO_KEYRING_HEX)) return Buffer.from(value.slice(GO_KEYRING_HEX.length), "hex");
  return Buffer.from(value, "utf-8");
}

/**
 * Read `agy`'s Keychain item, undefined when there is none or macOS does not
 * answer. The timeout matters: a Keychain access prompt nobody answers would
 * otherwise hang the launch.
 */
function readAgyKeychainValue(): string | undefined {
  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-s", AGY_KEYCHAIN_SERVICE, "-a", AGY_KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 },
    ).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Read a file's bytes, undefined when it does not exist or cannot be read. */
function readFileIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Write `contents` to `path` readable by the owner only, creating its folder.
 * Rewrites in place, never by rename: a running sandbox's bind mount follows
 * the file's inode. The `chmodSync` covers a file that already existed, whose
 * mode `writeFileSync`'s `mode` option leaves alone.
 */
function writeOwnerOnlyFile(path: string, contents: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Copy `agy`'s current token to `stagedPath`, from the macOS Keychain or else
 * from `agy`'s token file under `home`. Mutates `stagedPath`, only when the
 * token changed. Returns whether a staged token is there afterwards.
 */
export function stageAgyToken(
  stagedPath: string,
  home: string = homedir(),
  ports: {
    platform: NodeJS.Platform;
    readKeychain: () => string | undefined;
    readFile: (path: string) => Buffer | undefined;
    writeFile: (path: string, contents: Buffer) => void;
  } = {
    platform: process.platform,
    readKeychain: readAgyKeychainValue,
    readFile: readFileIfPresent,
    writeFile: writeOwnerOnlyFile,
  },
): boolean {
  const keychainValue = ports.platform === "darwin" ? ports.readKeychain() : undefined;
  const token =
    keychainValue === undefined
      ? ports.readFile(agySignInFiles(home).antigravityOAuthToken)
      : decodeGoKeyringValue(keychainValue);
  const staged = ports.readFile(stagedPath);
  if (token === undefined) return staged !== undefined;
  if (staged === undefined || !staged.equals(token)) ports.writeFile(stagedPath, token);
  return true;
}

/**
 * The Google credentials and the staged token as sandbox bind-mounts, at the
 * paths `agy` reads inside the container. Writable (the default): see the
 * writability evidence above. Not `readonly`, so a later caller must not add
 * it without repeating that check.
 */
export function agySignInMounts(
  stagedTokenPath: string,
  home: string = homedir(),
): { hostPath: string; sandboxPath: string }[] {
  return [
    {
      hostPath: agySignInFiles(home).googleOAuthCreds,
      sandboxPath: join(AGY_SANDBOX_HOME, ...GOOGLE_OAUTH_CREDS_RELATIVE),
    },
    { hostPath: stagedTokenPath, sandboxPath: join(AGY_SANDBOX_HOME, ...ANTIGRAVITY_OAUTH_TOKEN_RELATIVE) },
  ];
}

/**
 * When a spent Gemini quota comes back, read from piped `agy -p "/usage"`
 * output (#732). Checked against `agy` 1.4.7: one tab-separated row per limit
 * — model family, limit name, percent remaining, reset as UTC ISO — e.g.
 * `Gemini Models\tFive Hour Limit Remaining\t0%\t2026-10-26T14:57:42Z`.
 * Every spent Gemini limit must reset before a call goes through, so the
 * latest one wins, and a weekly one makes it a weekly stop. Undefined when no
 * Gemini limit reads 0% with a reset still ahead of `now`.
 */
export function parseGeminiQuotaReset(
  usage: string,
  now: Date,
): { resetAt: Date; kind: QuotaStopKind } | undefined {
  let latest: { resetAt: Date; kind: QuotaStopKind } | undefined;
  for (const line of usage.split("\n")) {
    const [family, limit, remaining, reset] = line.split("\t").map((cell) => cell.trim());
    if (!family?.startsWith("Gemini") || !remaining?.endsWith("%") || Number.parseFloat(remaining) !== 0) continue;
    const resetAt = new Date(reset ?? "");
    if (Number.isNaN(resetAt.getTime()) || resetAt.getTime() <= now.getTime()) continue;
    if (!latest || resetAt.getTime() > latest.resetAt.getTime()) {
      latest = { resetAt, kind: /weekly/i.test(limit ?? "") ? "weekly" : "session" };
    }
  }
  return latest;
}

type SessionStorage = NonNullable<AgentProvider["sessionStorage"]>;
type SandboxHandle = Parameters<SessionStorage["captureToHost"]>[0]["handle"];

/**
 * Session storage that leaves each `agy` conversation in the sandbox that ran
 * it, remembering only which sandbox that was. The sandbox lives for the
 * whole of one issue's run, so its fix rounds and follow-up steps resume the
 * conversation instead of re-exploring the repo cold. Nothing is copied to
 * the host: where `agy` keeps a conversation on disk is not documented, so a
 * dead run still starts cold on its branch next time, keeping its commits.
 *
 * Why the sandbox check: resuming a conversation id in a sandbox that does
 * not hold it would hand `agy` only the short continue prompt, without the
 * issue. Throwing instead fails the resume before `agy` starts, and the
 * caller starts cold with the full prompt.
 */
function inSandboxSessions(): SessionStorage {
  const sandboxOf = new Map<string, SandboxHandle>();
  return {
    async captureToHost({ sessionId, handle }) {
      sandboxOf.set(sessionId, handle);
    },
    async resumeIntoSandbox({ sessionId, handle }) {
      if (sandboxOf.get(sessionId) !== handle) {
        throw new Error(`agy conversation ${sessionId} is not in this sandbox; it stays in the sandbox that ran it`);
      }
    },
    async readHostSession() {
      return undefined;
    },
    async existsOnHost(_cwd, sessionId) {
      return sandboxOf.has(sessionId);
    },
    hostSessionFilePath() {
      return undefined;
    },
    async findByIdOnHost() {
      return { path: undefined, searchedRoot: "the sandbox that ran it (agy conversations stay there)" };
    },
  };
}

/** The Antigravity CLI (`agy`), running `model`, as a Sandcastle AgentProvider. */
export function antigravity(model: string): AgentProvider {
  return {
    name: "agy",
    env: {},
    captureSessions: true,
    sessionStorage: inSandboxSessions(),
    buildPrintCommand({ prompt, resumeSession }) {
      const resume = resumeSession === undefined ? "" : ` --conversation ${shellEscape(resumeSession)}`;
      return {
        command: `agy${resume} --output-format stream-json --model ${shellEscape(model)} --dangerously-skip-permissions -p "$(cat)"`,
        stdin: prompt,
      };
    },
    parseStreamLine(line) {
      return parseAgyStreamLine(line);
    },
  };
}
