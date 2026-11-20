/** Own Docker startup recovery before any sandbox is opened. */

export interface DockerPreflightPorts {
  /** Report daemon readiness, respecting the timeout when supplied. */
  probe(timeoutMs?: number): boolean;
  /** Run the project's host command within the remaining startup budget. */
  start(command: string, timeoutMs: number): void;
  /** Read monotonic milliseconds. */
  now(): number;
  /** Wait without blocking the event loop. */
  sleep(ms: number): Promise<void>;
}

const unavailable = "Docker is not responding — every sandbox would fail to start. Open Docker Desktop, wait for it to finish starting, then re-run Sandcastle.";

/** Start an unresponsive Docker when configured, or throw the existing startup advice. */
export async function preflightDocker(ports: DockerPreflightPorts, startCommand?: string): Promise<void> {
  if (ports.probe()) return;
  if (!startCommand) throw new Error(unavailable);

  const deadline = ports.now() + 180_000;
  try {
    ports.start(startCommand, 180_000);
  } catch {
    // A launcher can fail while a daemon is already starting; readiness decides.
  }
  while (ports.now() < deadline) {
    if (ports.probe(Math.min(5_000, deadline - ports.now()))) return;
    const remaining = deadline - ports.now();
    if (remaining > 0) await ports.sleep(Math.min(5_000, remaining));
  }
  throw new Error(unavailable);
}
