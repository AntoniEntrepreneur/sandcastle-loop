# sandcastle-loop

My Sandcastle orchestration loop, ready to install into a project. It runs on Matt Pocock's [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle) engine and grew out of his `parallel-planner-with-review` template.

The loop:

- works through GitHub issues in groups (`sandcastle:<id>` labels), with one integration branch and one draft PR per group;
- implements and reviews each issue in its own Docker sandbox;
- merges the branches and runs the project's check;
- survives being killed, a spent quota, or a whole night unattended (`--overnight`).

The header of `.sandcastle/main.mts` has the full story.

## Where it comes from

This repo is a **published snapshot**, not where the loop is developed. The source is `.sandcastle/` in the Iletobędzie repo. An **Export** PR copies it here on the 1st and 15th of each month. Merging one tags the next version (`v0.1.0`, `v0.2.0`, …), and projects install tags. So don't edit the loop here: a change lands in the source and arrives with the next export.

Once a second project uses the loop, this repo becomes the source and exports stop.

## What's in it

| Path | Owned by | Update overwrites it? |
|---|---|---|
| `.sandcastle/main.mts`, `notify.mts`, `export.mts`, `lib/*`, the four `*-prompt.md` files, `.sandcastle/.gitignore` | the pack | yes |
| `patches/@ai-hero+sandcastle+<version>.patch` (keeps a dead implementer's session so the next run resumes it; dropped once the engine ships the fix) | the pack | yes |
| `examples/iletobedzie/`: `sandcastle.config.mts`, `project-notes.md`, `Dockerfile`, `CODING_STANDARDS.md` | the project | no: written once at install, as a draft from these examples |
| `manifest.json`: engine version, source commit, the pack-owned file list | the pack | n/a |

A project's own facts never go in a pack-owned file. They go in `sandcastle.config.mts` (setup, check and format commands, lockfiles, Docker image inputs, caches, glossary) or `project-notes.md` (how to run targeted tests, take screenshots, use the project's CLIs). The prompts reach them through `{{CHECK_COMMAND}}` and `{{PROJECT_NOTES}}`.

## Install into a project

From the project's root folder:

```bash
npx skills add AntoniEntrepreneur/skills -a claude-code -s setup-sandcastle
```

Then ask Claude Code to `/setup-sandcastle`. It:

1. copies the latest tag's pack-owned files and the engine patch in;
2. drafts the four project-owned files by reading the project, and shows them to you before writing;
3. adds `@ai-hero/sandcastle` (the version in `manifest.json`), `tsx` and `patch-package` to `package.json`, with `"sandcastle": "npx tsx .sandcastle/main.mts"` and `"postinstall": "patch-package"`;
4. records the version and each pack-owned file's hash in `.sandcastle/pack.json`.

Run the loop with `npm run sandcastle`. It needs Docker running and a gitignored `.sandcastle/.env` holding `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and `GH_TOKEN`. The skill walks you through both.

## Update a project

Run `/setup-sandcastle` again, on a branch, and merge through a PR. If you edited a pack-owned file in the project, its hash no longer matches `pack.json`. The skill then stops and shows the diff instead of overwriting your edit. Move the edit into the source repo, or into a project-owned file.

## On a new computer

```bash
git clone https://github.com/AntoniEntrepreneur/sandcastle-loop ~/Code/sandcastle-loop
```

You only need the clone to read the code. Exports and installs fetch from GitHub themselves.
