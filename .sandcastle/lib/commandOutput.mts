// Preserve captured command diagnostics in the run's own output streams.
import { isGitHubUnreachable } from "./groups.mts";

/** Include captured stdout and stderr even when the command's message omits them. */
export function commandErrorText(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  if (typeof error === "object" && error !== null) {
    const streams = [
      "stdout" in error ? error.stdout : undefined,
      "stderr" in error ? error.stderr : undefined,
    ];
    for (const value of streams) {
      const output = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
      if (output.trim() && !parts.some((part) => part.includes(output.trim()))) parts.push(output.trim());
    }
  }
  return parts.join("\n");
}

/** Run a captured command and log its own diagnostics before propagating failure. */
export function loggedCommand<T>(run: () => T, log: (message: string) => void): T {
  try {
    return run();
  } catch (error) {
    log(commandErrorText(error));
    throw error;
  }
}

/** Name a push refusal and preserve git's output in both the log and the error. */
export function pushFailure(branch: string, error: unknown, log: (message: string) => void): Error {
  const text = commandErrorText(error);
  const category = /non-fast-forward|\(fetch first\)/i.test(text) ? "pushed copy moved on"
    : /GH013|GH006|repository rule|protected branch|pre-receive hook declined/i.test(text) ? "repository rule"
    : isGitHubUnreachable(text) ? "unreachable" : "other";
  const failure = new Error(`Push ${branch} refused: ${category}\n${text}`, { cause: error });
  log(failure.message);
  return failure;
}
