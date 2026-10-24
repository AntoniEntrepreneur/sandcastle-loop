// The options that continue a run's session with a short inline prompt.
//
// The SDK's own `result.resume(prompt)` (0.12.0) spreads the first run's
// options and swaps `promptFile` for the inline prompt but keeps `promptArgs`,
// which the SDK then rejects for an inline prompt — so every resume of a run
// started from a prompt file threw `PromptError`. This drops both.

/** `runOptions` with its prompt file and arguments replaced by `prompt`, resuming `sessionId`. */
export function resumeRunOptions<T extends { promptFile?: string; promptArgs?: unknown }>(
  runOptions: T,
  prompt: string,
  sessionId: string,
): Omit<T, "promptFile" | "promptArgs"> & { prompt: string; maxIterations: 1; resumeSession: string } {
  const { promptFile: _file, promptArgs: _args, ...rest } = runOptions;
  return { ...rest, prompt, maxIterations: 1, resumeSession: sessionId };
}
