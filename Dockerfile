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
RUN pnpm -C server build

# -------------------------------------------------------------- runtime stage
# Production dependencies are installed fresh rather than copied from the build
# stage: pnpm's node_modules is a tree of symlinks into a virtual store, and
# copying it across stages is fragile.
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY executor/package.json executor/package.json
RUN pnpm install --frozen-lockfile --prod --filter server
COPY --from=build /app/server/dist server/dist

# TODO(Phase 2): once prisma/schema.prisma has models and the server imports
# @prisma/client, this needs a `pnpm -C server exec prisma generate` step — and
# prisma/ must be COPYed in for it.

USER node
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
