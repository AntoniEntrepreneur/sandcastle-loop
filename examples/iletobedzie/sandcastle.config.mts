// Iletobędzie's facts for the Sandcastle loop. Project-owned: a pack update
// never overwrites this file. The shape is `lib/projectConfig.mts`.

import type { ProjectConfig } from "./lib/projectConfig.mts";

// The agent's feedback loop is `make test` / `make lint`, so all three
// toolchains it reaches for — root node, frontend node, and the Python env uv
// manages — must be present, or the loop fails in a way the agent will read as
// a broken repo.
//
// A reset listed as its own hook entry did not follow the installs: it finished
// first, npm rewrote frontend/package-lock.json behind it, and every sandbox
// handed its agent a worktree that was already dirty. So the reset is the last
// link of this one chain.
//
// The image ships the dependency trees outside the worktree (see Dockerfile);
// the first two steps link them in, so the installs below only top up whatever
// an agent changed. UV_PROJECT_ENVIRONMENT in the image points `uv sync` at the
// prebuilt venv.
const setupCommand = [
  "rm -rf node_modules frontend/node_modules",
  "ln -s /home/agent/deps/node_modules node_modules",
  "ln -s /home/agent/deps/frontend-node_modules frontend/node_modules",
  "npm install",
  "npm install --prefix frontend",
  "uv sync",
  "git checkout -- package-lock.json frontend/package-lock.json",
].join(" && ");

export const config: ProjectConfig = {
  setupCommand,
  checkCommand: "make test && make lint",
  // Exactly what pre-commit's black hook covers.
  formatCommand: "uv run black backend tests",
  imageInputFiles: [
    "package.json",
    "package-lock.json",
    "frontend/package.json",
    "frontend/package-lock.json",
    "pyproject.toml",
    "uv.lock",
    ".sandcastle/Dockerfile",
  ],
  lockfiles: ["package-lock.json", "frontend/package-lock.json", "uv.lock"],
  // npm's cache is content-addressed and uv locks its own, so both are safe to
  // share between concurrent sandboxes.
  cacheMounts: [
    { name: "npm", sandboxPath: "/home/agent/.npm" },
    { name: "uv", sandboxPath: "/home/agent/.cache/uv" },
  ],
  // uv cannot hardlink across the bind mounts, so it is told to copy rather
  // than warn about falling back to it.
  sandboxEnv: { UV_LINK_MODE: "copy" },
  glossaryFile: "GLOSSARY.md",
};
