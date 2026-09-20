# syntax=docker/dockerfile:1

# Build context is the REPO ROOT, not server/. This is a pnpm workspace: the
# lockfile, the workspace manifest, and the allowBuilds approvals all live at the
# root, and `pnpm install --frozen-lockfile` needs all three. A Dockerfile inside
# server/ with server/ as its context cannot see them.
#
# Deploy from the repo root:  fly deploy

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version comes from the root package.json "packageManager" field.
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- build stage
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Both workspace members' manifests, so pnpm can resolve the workspace even
# though --filter installs only server.
COPY server/package.json server/package.json
COPY executor/package.json executor/package.json
RUN pnpm install --frozen-lockfile --filter server
COPY server server
# `build` runs `prisma generate` first; generate never connects, but
# prisma7.config.ts wants a DATABASE_URL present (same dummy trick as CI).
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm -C server build

# -------------------------------------------------------------- runtime stage
# Production dependencies are installed fresh rather than copied from the build
# stage: pnpm's node_modules is a tree of symlinks into a virtual store, and
# copying it across stages is fragile.
FROM base AS runtime
ENV NODE_ENV=production
# node:24-slim ships no openssl binary/headers; without it the prisma CLI
# (release_command) warns and guesses "openssl-1.1.x" for libssl detection.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY executor/package.json executor/package.json
RUN pnpm install --frozen-lockfile --prod --filter server
COPY --from=build /app/server/dist server/dist

# Migrations run at release time (fly.toml [deploy].release_command), so the
# runtime image carries the prisma CLI (a production dependency now), the
# schema + migrations, and the config that reads DATABASE_URL from the env.
# (The generated client itself is compiled into dist/ by the build stage.)
COPY server/prisma7.config.ts server/prisma7.config.ts
COPY server/prisma server/prisma

# Read at boot from /app/policy.json (see server/src/index.ts). chown so PUT
# /policy can rewrite it; on Fly that edit lasts until the next deploy, and
# every accepted policy is recorded in policy_snapshots regardless.
COPY --chown=node:node policy.json policy.json

# Build metadata surfaced by /health. The CI deploy step passes these;
# local `fly deploy` / `docker build` without args falls back to "dev".
ARG GIT_SHA=dev
ARG BUILD_TIME=dev
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

USER node
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
