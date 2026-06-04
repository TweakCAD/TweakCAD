# syntax=docker/dockerfile:1
# =============================================================================
# Standalone offline CAD image — the TweakCAD editor (@tweakcad/cad), no SaaS,
# no account, no backend. Served at the domain root by an unprivileged nginx
# on port 8080.
#
# Independent, single-repo build: this repo vendors its libs in-tree under lib/
# (incl. cad-tools + the client-safe api-types subset), so there is no separate
# common/ context and no file: deps.
#
# Build context is THIS repo's root:
#   docker build -t tweakcad/cad:<tag> .
# =============================================================================

# ---- builder ---------------------------------------------------------------
FROM node:24-bookworm-slim AS builder
# Asset base path (vite `base`). Default `/` for the standalone image (editor
# at the domain root). The site image builds the `dist` target below with
# CAD_BASE=/cad/ so assets resolve under the embedded /cad route.
ARG CAD_BASE=/
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Non-interactive build: pnpm must never block on a modules-purge TTY prompt.
ENV CI=true
# Pin pnpm to the version in package.json's `packageManager` so the image
# build matches local/CI (Node 24's corepack otherwise resolves a newer pnpm).
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /app

# Manifests + lockfile, then install — cached unless these change.
COPY package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Full source, then build. CAD_BASE controls the asset base (vite.config.ts):
# `/` for the standalone image, `/cad/` for the embedded site build. NODE_ENV=
# production enables prod plugins.
COPY . .
RUN NODE_ENV=production CAD_BASE=$CAD_BASE pnpm exec vite build

# ---- dist ------------------------------------------------------------------
# Artifact-only image: just the built bundle at /dist, nothing else. A host
# site image can consume it via `COPY --from=<cad-embed image> /dist` — built
# with --build-arg CAD_BASE=/cad/ --target dist.
FROM scratch AS dist
COPY --from=builder /app/dist /dist

# ---- runner ----------------------------------------------------------------
# Unprivileged nginx already listens on 8080 as a non-root user.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
