# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

The issue, its comments and its parent spec are below. Do not fetch them with
`gh`.

{{ISSUE_CONTEXT}}

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

{{CHECK_FAILURE}}

# RESUMPTION

**This branch may already carry your own unfinished work.** A previous run can
be cut off at any moment — most often because the developer's Claude usage ran
out mid-task — and it leaves everything it had done on this branch. Before you
plan anything, read what is already there. The orchestrator has run these for
you; do not run them again.

Commits already made for this issue (newest first, full messages). Read the
`Blockers or notes for next iteration` line of the most recent one; your past
self wrote it for you. Commits subject-lined `Sandcastle-WIP: #{{TASK_ID}} — ...`
are the orchestrator's own saves of whatever you had mid-edit when a turn was
cut off, not someone else's work. Continue them as you would your own last
commit; do not revert or redo them.

<branch-commits>

!`git log {{BRANCH}} --not {{INTEGRATION_BRANCH}} --format="%H%n%B---"`

</branch-commits>

Uncommitted changes left mid-edit (`git status --short`). They are your own
work in progress; read them with `git diff` before touching those files.

<branch-status>

!`git status --short`

</branch-status>

Continue from what you find. Do not restart work that is already committed, and
do not revert a half-finished edit just because it is incomplete — finish it.

If everything the issue asks for is already committed on this branch, verify it
with the feedback loops below and output the completion signal immediately
rather than inventing more work.

# CONTEXT

Here are the last 10 commits (subject lines only — see RESUMPTION above for
the full history of this branch's own work):

<recent-commits>

!`git log -n 10 --oneline`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Your feedback loop is the targeted test files for what you changed
(`uv run pytest tests/path/test_x.py`, `npx vitest run path` in `frontend`).
When they pass, your last check is done: output the completion signal. The
full suite belongs to the orchestrator — it runs `black`, `make test` and
`make lint` when you signal completion, and resumes you with the failing
output if any is red. There is no `npm run test` or `npm run typecheck` at the
repo root.

**Commit first, then verify.** As soon as the change is written and you believe
it is right, commit it. Run the targeted tests afterwards and fix what they
report in a follow-up commit. A commit is trivial to amend or revert; an
uncommitted change is invisible to the orchestrator, which reads commits alone
to decide whether you are making progress.

# THIRD-PARTY FACTS

Every flag, subcommand, API path, config key or file convention you write for a
service outside this repo (Railway, GitHub, Clerk, Cloudflare, Sentry, Next.js…)
is checked against its source before you commit: `<cli> <command> --help` for a
CLI the sandbox has (`railway`, `gh`), otherwise the vendor's docs via
WebFetch. Name the URL or command in the commit's key decisions. One no source
confirms goes in the commit's `Blockers or notes for next iteration` as
unverified, so the PR carries it to the human who runs it.

# SCREENSHOTS

For a visual change, headless Chromium is at `/usr/bin/chromium`. Start the
app with `uv run uvicorn backend.main:app --port 8000 >/tmp/api.log 2>&1 &` and
`npm run dev --prefix frontend >/tmp/web.log 2>&1 &`, then
`chromium --headless --no-sandbox --screenshot=/tmp/shot.png --window-size=390,844 http://127.0.0.1:3000/login`
(390×844 is a phone).

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

**Commit before you run out of room.** Your work only survives an interruption
if it is committed, so commit each coherent step as you finish it rather than
saving one commit for the end. Three turns in a row with no commit are read as
a dead agent and the issue is abandoned, so never end a turn with a working
change sitting uncommitted.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# GLOSSARY

The glossary hook refuses edits that use these terms. Use the canonical term
from GLOSSARY.md instead: {{AVOID_TERMS}}

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

Finish with only the completion signal and at most three lines. No summary.
