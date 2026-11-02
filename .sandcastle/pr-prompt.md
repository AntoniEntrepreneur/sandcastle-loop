# TASK

You are on a finished Sandcastle integration branch. Every issue in this batch
is merged and the orchestrator has passed `{{CHECK_COMMAND}}` on this exact
tree. The orchestrator is about to mark its PR ready for review, and you write
the PR body a human reviewer reads.

These are the issues the batch covers:

{{ISSUES}}

Read what changed with `git log --format=%B {{BASE_REF}}..HEAD` and
`git diff {{BASE_REF}}...HEAD`, then write the body with the `pr` skill.

Every commit's `Blockers or notes for next iteration` that names an unverified
assumption or something left for a human goes under **Merge Danger**, in the
commit's own words.

For **Evidence**, the change on `main` is the "before" and this branch is the
"after". Cite the passing `{{CHECK_COMMAND}}` as the evidence the tests pass,
and name the tests that cover the new behaviour. Do not rerun the full suite
or the linter. Run a single targeted test only when its output shows a
before/after the passing check cannot, such as the value a test asserts.
For a visual change, if `.sandcastle/project-notes.md` says how to take a
screenshot, take one and read the image; the body is text only, so state what
the screenshot showed.

# RULES

Read only. Do not commit, do not push, do not edit files, do not open or edit
the PR, and do not close any issues. Do not add `Closes #…` lines: the
orchestrator appends them below your body.

Output the finished body between `<pr-body>` and `</pr-body>`, then
<promise>COMPLETE</promise>. Nothing else.
