# TASK

You are on a Sandcastle integration branch — NOT `main`; do not check out or
touch `main`. The orchestrator has already run `git merge --no-ff` for every
finished issue branch in this batch — or, when the branch is being brought up
to date, for `origin/main` itself. You are called only because that left one
of two problems, and your job is to fix exactly those.

## Branches that did not merge cleanly

The orchestrator aborted these, so nothing of them is on this branch yet:

{{CONFLICTED}}

For each one, run `git merge <branch> --no-ff --no-edit` and resolve the
conflicts by reading both sides and choosing the correct resolution.

When the branch is `origin/main`, its side has already shipped: other PRs
merged it after this branch was cut. Keep main's version of their work and
fit this branch's changes onto it, rather than reverting either side.

## Checks

The output of `make test && make lint` after the clean merges, if it failed:

<check-output>
{{CHECK_OUTPUT}}
</check-output>

Once everything is merged, run `make test` and `make lint` (the repo's real
entry points — there is no `npm run test` at the root) and fix what fails in a
follow-up commit. A failure here usually means two branches built in parallel
— or this branch and what main gained since — broke each other; fix the
combination, do not revert either side's work.

# RULES

Leave the merge commits exactly as `git merge` wrote them. Do NOT tidy the
history afterwards — no `git reset`, no `git rebase`, no squash, no amending a
merge commit away, and no single commit summarizing the whole merge. Each
branch carries a **Done marker**: an empty commit with a
`Sandcastle-Done: #<issue>` trailer. Sandcastle decides what is done and which
issues this PR closes by asking whether that marker is reachable from this
branch. Squashing throws the marker away.

Do not use `git stash`. The stash is shared with every other worktree in the
repo, so `git stash pop` can apply another issue's unrelated work. To check
whether a failure predates the merge, use `git show <commit>:<path>` or
`git worktree add` into a scratch directory instead.

Commit everything before you finish — uncommitted fixes are not seen.

Do not push, do not open a PR, and do not close any issues — that happens
automatically afterwards. These are the issues this batch covers, for your
reference only:

{{ISSUES}}

Once every branch above is merged and both checks pass, output
<promise>COMPLETE</promise>.

Finish with only the completion signal and at most three lines. No summary.
