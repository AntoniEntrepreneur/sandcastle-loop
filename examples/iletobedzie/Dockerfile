# syntax=docker/dockerfile:1
FROM node:26-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  make \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Headless Chromium for screenshots of a visual change. Debian's package, not
# Playwright's download, because Playwright's bundled build has had arm64 gaps
# and the host is Apple Silicon. The fonts cover Polish diacritics.
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  fonts-dejavu-core \
  fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Railway CLI, unauthenticated: there so `railway <command> --help` answers what
# flags a script for Railway may use, instead of the agent guessing them.
RUN npm install -g @railway/cli

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install uv: `make test` runs pytest through it, `make lint` runs black.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

# Bake in the interpreter pyproject.toml demands. The base image ships Python
# 3.11, requires-python is >=3.14, so without this every container's first
# `uv sync` downloads and unpacks a 29MB standalone CPython before it can
# install anything — paid once per sandbox, and `make test` runs through uv.
RUN uv python install 3.14

# Project dependencies, installed outside the worktree so a sandbox's setup is a
# top-up rather than a 25-53s cold install. The orchestrator builds this image
# from a context holding only the manifests and lockfiles below, and labels it
# with a hash of them (see lib/imageHash.mts) so it rebuilds when they change.
# The setup command links these trees into the worktree; `npm install` and
# `uv sync` there then install only what an agent changed mid-issue.
ENV UV_PROJECT_ENVIRONMENT=/home/agent/deps/venv
WORKDIR /home/agent/deps-build
COPY --chown=${AGENT_UID}:${AGENT_GID} package.json package-lock.json ./
COPY --chown=${AGENT_UID}:${AGENT_GID} frontend/package.json frontend/package-lock.json ./frontend/
COPY --chown=${AGENT_UID}:${AGENT_GID} pyproject.toml uv.lock ./
# BuildKit cache mounts keep npm's and uv's download caches across rebuilds, so a
# lockfile change downloads only the packages that are new. uv must copy rather
# than hardlink, because the cache and the venv are on different filesystems.
ENV UV_LINK_MODE=copy
RUN --mount=type=cache,target=/home/agent/.npm,uid=${AGENT_UID},gid=${AGENT_GID} \
  --mount=type=cache,target=/home/agent/.cache/uv,uid=${AGENT_UID},gid=${AGENT_GID} \
  npm ci && npm ci --prefix frontend \
  && mkdir -p /home/agent/deps \
  && mv node_modules /home/agent/deps/node_modules \
  && mv frontend/node_modules /home/agent/deps/frontend-node_modules \
  && uv sync --frozen --no-install-project \
  && cd /home/agent && rm -rf deps-build

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
