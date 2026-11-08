# node:sqlite requires Node 22.5+; node:20 would crash on import.
FROM node:22-bookworm-slim AS builder

# pnpm as the package manager (must match packageManager field in package.json).
RUN npm install -g pnpm@12.16.1

WORKDIR /app

# Copy workspace manifests first so the layer is cached across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Install all workspace dependencies (including shared).
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source after install so code changes don't bust the install cache.
COPY shared/ ./shared/
COPY server/ ./server/

# Build shared types first, then the server.
RUN pnpm --filter @instagram-agent/shared build
RUN pnpm --filter server build

# ── Runtime image ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN npm install -g pnpm@12.16.1

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Production-only install (no dev deps).
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Copy the compiled output from the builder stage.
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist

EXPOSE 3001
# Bind to 0.0.0.0 inside the container so the port mapping works.
ENV BIND_HOST=0.0.0.0
CMD ["pnpm", "--filter", "server", "start"]
