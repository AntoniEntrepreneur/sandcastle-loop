# TASK

You are on a finished Sandcastle integration branch. Every issue in this batch
is merged and `make test` / `make lint` pass. The orchestrator is about to mark
its PR ready for review, and you write the PR body a human reviewer reads.

These are the issues the batch covers:

{{ISSUES}}

Read what changed with `git log --format=%B {{BASE_REF}}..HEAD` and
`git diff {{BASE_REF}}...HEAD`, then write the body with the `pr` skill.

Every commit's `Blockers or notes for next iteration` that names an unverified
assumption or something left for a human goes under **Merge Danger**, in the
commit's own words.

For **Evidence**, the change on `main` is the "before" and this branch is the
"after". Name the tests that cover the new behaviour, and run them if that
makes the evidence concrete. For a visual change, you can screenshot it with
the headless Chromium in `.sandcastle/implement-prompt.md` (SCREENSHOTS) and
read the image; the body is text only, so state what the screenshot showed.

# RULES

Read only. Do not commit, do not push, do not edit files, do not open or edit
the PR, and do not close any issues. Do not add `Closes #…` lines: the
orchestrator appends them below your body.

Output the finished body between `<pr-body>` and `</pr-body>`, then
<promise>COMPLETE</promise>. Nothing else.
