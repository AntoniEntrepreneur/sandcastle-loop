// Unit tests for the antigravity (`agy`) AgentProvider, through its public
// methods only. The NDJSON fixtures are hand-built to the stream shape #725
// recorded against `agy` 1.4.6: the build sandbox has no `agy` binary to
// record a fresh probe against (#729).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agySignInFiles,
  agySignInMounts,
  antigravity,
  missingAgySignInFiles,
  parseGeminiQuotaReset,
} from "./antigravity.mts";

const MODEL = "gemini-3.8-flash-high";

// `agy -p "/usage" > file`, recorded 2026-10-26 against `agy` 1.4.7: piped, so
// the reset times are UTC. Gemini had quota left; Claude's weekly was spent.
const RECORDED_USAGE = [
  "Gemini Models\tWeekly Limit Remaining\t50%\t2026-10-27T18:25:06Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-26T14:57:42Z",
  "Claude and GPT models\tWeekly Limit Remaining\t0%\t2026-10-27T18:37:47Z",
  "Claude and GPT models\tFive Hour Limit Remaining\tdisabled\t",
  "",
].join("\n");

const USAGE_NOW = new Date("2026-10-26T12:00:00Z");

/** The recorded output with Gemini's limits set to the given percentages. */
function usageWithGemini(weekly: string, fiveHour: string): string {
  return RECORDED_USAGE.replace("\t50%\t", `\t${weekly}\t`).replace("\t100%\t", `\t${fiveHour}\t`);
}

/** Pins that a spent five-hour Gemini limit reads as a session stop at its UTC reset (#732). */
test("parseGeminiQuotaReset reads a spent five-hour limit's reset", () => {
  assert.deepEqual(parseGeminiQuotaReset(usageWithGemini("50%", "0%"), USAGE_NOW), {
    resetAt: new Date("2026-10-26T14:57:42Z"),
    kind: "session",
  });
});

/** Pins that with both Gemini limits spent, the later reset wins and the stop is weekly. */
test("parseGeminiQuotaReset waits for the later of two spent limits", () => {
  assert.deepEqual(parseGeminiQuotaReset(usageWithGemini("0%", "0%"), USAGE_NOW), {
    resetAt: new Date("2026-10-27T18:25:06Z"),
    kind: "weekly",
  });
});

/** Pins that the recorded output, Gemini unspent and Claude's row spent, names no Gemini reset. */
test("parseGeminiQuotaReset ignores unspent Gemini limits and other model families", () => {
  assert.equal(parseGeminiQuotaReset(RECORDED_USAGE, USAGE_NOW), undefined);
});

/** Pins that a spent limit whose reset has already passed is not a reset to wait for. */
test("parseGeminiQuotaReset ignores a reset already past", () => {
  const later = new Date("2026-10-26T15:00:00Z");
  assert.equal(parseGeminiQuotaReset(usageWithGemini("50%", "0%"), later), undefined);
});

/** Pins that output in another shape reads as no reset rather than a guess. */
test("parseGeminiQuotaReset reads unrecognised output as no reset", () => {
  assert.equal(parseGeminiQuotaReset("", USAGE_NOW), undefined);
  assert.equal(parseGeminiQuotaReset("Gemini Models: 0% left, resets in 2h", USAGE_NOW), undefined);
});

// Trimmed from a real `agy` 1.4.6 run's stdout (#728).
const STREAM_FIXTURE = [
  '{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-high","cwd":"/tmp","tools":["run_command"]}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":6776,"output_tokens":765,"thinking_tokens":730,"cache_read_tokens":0,"total_tokens":7541}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","output":"hello\\r\\n"}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"hi\\n\\n<promise>COMPLETE</promise>\\n","usage":{"input_tokens":7618,"output_tokens":1904,"thinking_tokens":1895,"cache_read_tokens":0,"total_tokens":9522}}}',
  '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"hi\\n\\n<promise>COMPLETE</promise>\\n","num_turns":1,"usage":{"input_tokens":14394,"output_tokens":2669,"thinking_tokens":2625,"cache_read_tokens":300,"total_tokens":17063}}}',
];

const AGY_ERROR_LINE = "AGY_ERROR: Your AI credits balance is too low to continue.";

/** Pins that text deltas and the final result carry the completion signal through. */
test("parseStreamLine turns step_update and result into text containing the completion signal", () => {
  const provider = antigravity(MODEL);
  const events = STREAM_FIXTURE.flatMap((line) => provider.parseStreamLine(line));
  const text = events
    .map((event) => (event.type === "text" ? event.text : event.type === "result" ? event.result : ""))
    .join("");
  assert.match(text, /<promise>COMPLETE<\/promise>/);
});

/** Pins that only the final result's usage is read, not any step's. */
test("parseStreamLine reads usage from the final result only", () => {
  const provider = antigravity(MODEL);
  const events = STREAM_FIXTURE.flatMap((line) => provider.parseStreamLine(line));
  const usageEvents = events.filter((event) => event.type === "usage");
  assert.equal(usageEvents.length, 1);
  assert.deepEqual(usageEvents[0], {
    type: "usage",
    usage: {
      inputTokens: 14394,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 300,
      outputTokens: 2669,
      thinkingTokens: 2625,
    },
  });
});

/** Pins that the init line's conversation id becomes the session id a later step resumes. */
test("parseStreamLine reads the init line's conversation_id as the session id", () => {
  assert.deepEqual(antigravity(MODEL).parseStreamLine(STREAM_FIXTURE[0]!), [{ type: "session_id", sessionId: "c-1" }]);
});

/** Pins that an unrecognised event or a non-JSON line maps to nothing. */
test("parseStreamLine drops unrecognised events", () => {
  const provider = antigravity(MODEL);
  assert.deepEqual(provider.parseStreamLine('{"event":"something_else"}'), []);
  assert.deepEqual(provider.parseStreamLine("not json at all"), []);
});

/** Pins that an AGY_ERROR line becomes an error the engine can see. */
test("parseStreamLine turns an AGY_ERROR line into a result event carrying it", () => {
  const events = antigravity(MODEL).parseStreamLine(AGY_ERROR_LINE);
  assert.deepEqual(events, [{ type: "result", result: AGY_ERROR_LINE }]);
});

/** Pins the command: prompt from stdin into -p, stream-json output, model, skip-permissions. */
test("buildPrintCommand carries the model, stream-json, stdin input and skip-permissions", () => {
  const { command, stdin } = antigravity(MODEL).buildPrintCommand({
    prompt: "do the thing",
    dangerouslySkipPermissions: true,
  });
  assert.match(command, /^agy --output-format/);
  assert.match(command, / -p "\$\(cat\)"$/);
  assert.match(command, /--output-format stream-json/);
  assert.match(command, /--model 'gemini-3\.8-flash-high'/);
  assert.match(command, /--dangerously-skip-permissions/);
  assert.equal(stdin, "do the thing");
});

/** Pins that a resumed run names its conversation with the long flag and keeps every other flag. */
test("buildPrintCommand resumes the given conversation with --conversation", () => {
  const { command, stdin } = antigravity(MODEL).buildPrintCommand({
    prompt: "fix the lint",
    dangerouslySkipPermissions: true,
    resumeSession: "c-1",
  });
  assert.match(command, /^agy --conversation 'c-1' --output-format stream-json /);
  assert.match(command, /--model 'gemini-3\.8-flash-high'/);
  assert.match(command, / -p "\$\(cat\)"$/);
  assert.equal(stdin, "fix the lint");
});

/** Pins that a fresh run names no conversation. */
test("buildPrintCommand without a session starts a new conversation", () => {
  const { command } = antigravity(MODEL).buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true });
  assert.doesNotMatch(command, /--conversation/);
});

/** Pins the shape the engine needs to offer a resume: capture on, storage set, no session-usage parsing. */
test("antigravity captures sessions into its storage and parses no session usage", () => {
  const provider = antigravity(MODEL);
  assert.equal(provider.captureSessions, true);
  assert.ok(provider.sessionStorage);
  assert.equal(provider.parseSessionUsage, undefined);
  assert.equal(provider.name, "agy");
});

type Storage = NonNullable<ReturnType<typeof antigravity>["sessionStorage"]>;
type Handle = Parameters<Storage["captureToHost"]>[0]["handle"];

/** A stand-in sandbox handle; the storage compares handles by identity only. */
function fakeHandle(): Handle {
  return {} as Handle;
}

/** The transfer arguments the engine passes, for `sessionId` in sandbox `handle`. */
function transfer(sessionId: string, handle: Handle) {
  return { hostCwd: "/repo", sandboxCwd: "/home/agent/workspace", sessionId, handle };
}

/** Pins that a conversation captured in a sandbox resumes in that same sandbox. */
test("sessionStorage resumes a conversation in the sandbox that ran it", async () => {
  const storage = antigravity(MODEL).sessionStorage!;
  const sandbox = fakeHandle();
  assert.equal(await storage.existsOnHost("/repo", "c-1"), false);
  await storage.captureToHost(transfer("c-1", sandbox));
  assert.equal(await storage.existsOnHost("/repo", "c-1"), true);
  await storage.resumeIntoSandbox(transfer("c-1", sandbox));
});

/** Pins that a conversation is never resumed in another sandbox, where agy would lack the issue's prompt. */
test("sessionStorage refuses to resume a conversation in a different sandbox", async () => {
  const storage = antigravity(MODEL).sessionStorage!;
  await storage.captureToHost(transfer("c-1", fakeHandle()));
  await assert.rejects(storage.resumeIntoSandbox(transfer("c-1", fakeHandle())), /not in this sandbox/);
  await assert.rejects(storage.resumeIntoSandbox(transfer("c-unknown", fakeHandle())), /not in this sandbox/);
});

/** Pins that nothing is copied to the host, so a later run finds no conversation to resume. */
test("sessionStorage keeps no host copy of a conversation", async () => {
  const storage = antigravity(MODEL).sessionStorage!;
  await storage.captureToHost(transfer("c-1", fakeHandle()));
  assert.equal(await storage.readHostSession("/repo", "c-1"), undefined);
  assert.equal(storage.hostSessionFilePath("/repo", "c-1"), undefined);
  assert.equal((await storage.findByIdOnHost("c-1")).path, undefined);
  assert.equal(await antigravity(MODEL).sessionStorage!.existsOnHost("/repo", "c-1"), false);
});

/** Pins the two sign-in file paths, not the whole `~/.gemini` folder (#730). */
test("agySignInFiles names the two sign-in files under the given home, nothing else", () => {
  assert.deepEqual(agySignInFiles("/home/dev"), {
    googleOAuthCreds: "/home/dev/.gemini/oauth_creds.json",
    antigravityOAuthToken: "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token",
  });
});

/** Pins that a missing file is reported, by path, and a present one is not. */
test("missingAgySignInFiles reports only the files that don't exist", () => {
  const onlyTokenMissing = (path: string) => !path.endsWith("antigravity-oauth-token");
  assert.deepEqual(missingAgySignInFiles("/home/dev", onlyTokenMissing), [
    "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token",
  ]);
  assert.deepEqual(missingAgySignInFiles("/home/dev", () => true), []);
  assert.deepEqual(missingAgySignInFiles("/home/dev", () => false), [
    "/home/dev/.gemini/oauth_creds.json",
    "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token",
  ]);
});

/** Pins the sandbox paths `agy` reads inside the container, and that the mounts are writable. */
test("agySignInMounts maps both files to agy's sandbox paths, writable", () => {
  const mounts = agySignInMounts("/home/dev");
  assert.deepEqual(mounts, [
    { hostPath: "/home/dev/.gemini/oauth_creds.json", sandboxPath: "/home/agent/.gemini/oauth_creds.json" },
    {
      hostPath: "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token",
      sandboxPath: "/home/agent/.gemini/antigravity-cli/antigravity-oauth-token",
    },
  ]);
  for (const mount of mounts) assert.ok(!("readonly" in mount));
});
