# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability, and check it delivers the issue.

# CONTEXT

## Issue

The issue, its comments and its parent spec. Do not fetch them with `gh`.

{{ISSUE_CONTEXT}}

## Branch diff

{{DIFF}}

## Commits on this branch

!`git log {{INTEGRATION_BRANCH}}..{{BRANCH}} --oneline`

## Check

The full suite belongs to the orchestrator. It passed `{{CHECK_COMMAND}}` on
this branch before the review started, and it runs the formatter and
`{{CHECK_COMMAND}}` again after every change you make. Do not run the full
suite, the linter or the formatter yourself.

{{CHECK_FAILURE}}

# REVIEW PROCESS

1. **Understand the change**: Read the issue, then the diff and commits above.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the diff deliver every acceptance criterion in the issue? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?
   - Is every third-party CLI flag, API path or config key the diff adds confirmed by its docs or `--help`? Check each one the commits don't cite. A wrong one is a `Fix:` commit; one no source confirms goes in your commit's `Blockers or notes for next iteration` as unverified.

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Fix bugs separately**: A correctness bug gets fixed in its own commit whose subject starts `Fix:`. Every other change keeps behaviour identical.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run the targeted test files for the code you changed, and nothing else
3. Commit describing the refinements

If the code is already clean and well-structured, do nothing, and run no tests.

Once complete, output <promise>COMPLETE</promise>.

Finish with only the completion signal and at most three lines. No summary.
