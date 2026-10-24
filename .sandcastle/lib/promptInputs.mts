// Prompt inputs the orchestrator gathers on the host, so an agent spends no
// tool calls fetching them. Pure functions over strings; main.mts owns the
// `gh` and file reads that feed them.

/** One issue as handed to an implementer. */
export interface IssueText {
  number: number;
  title: string;
  body: string;
}

/** Every distinct `_Avoid_` term in a GLOSSARY.md-shaped glossary, in order. */
export function extractAvoidTerms(contextMd: string): string[] {
  const terms: string[] = [];
  for (const line of contextMd.split("\n")) {
    const match = /^_Avoid_:\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    for (const term of match[1]!.split(",")) {
      const trimmed = term.trim();
      if (trimmed && !terms.includes(trimmed)) terms.push(trimmed);
    }
  }
  return terms;
}

/** The parent issue number named under a `## Parent` heading, if any. */
export function parentIssueNumber(body: string): number | undefined {
  const match = /^##\s+Parent\s*\n+\s*#(\d+)/m.exec(body);
  return match ? Number(match[1]) : undefined;
}

/** The issue, its comments and its parent spec, as one block of prompt text. */
export function renderIssueContext(input: {
  issue: IssueText & { comments: string[] };
  parent?: IssueText;
}): string {
  const { issue, parent } = input;
  const parts = [`## Issue #${issue.number}: ${issue.title}\n\n${issue.body}`];
  if (issue.comments.length > 0) {
    parts.push(
      `## Comments on #${issue.number}\n\n${issue.comments.join("\n\n---\n\n")}`,
    );
  }
  if (parent) {
    parts.push(`## Parent spec #${parent.number}: ${parent.title}\n\n${parent.body}`);
  }
  return parts.join("\n\n");
}

/**
 * The PR body the PR writer put between `<pr-body>` tags, if it wrote one.
 * The last pair wins: the agent may quote the tags while reasoning first.
 */
export function extractPrBody(stdout: string): string | undefined {
  const matches = [...stdout.matchAll(/<pr-body>([\s\S]*?)<\/pr-body>/g)];
  const body = matches.at(-1)?.[1]?.trim();
  return body ? body : undefined;
}
