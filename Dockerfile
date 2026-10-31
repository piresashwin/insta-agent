FROM node:20-bookworm-slim

# pnpm as the package manager
RUN npm install -g pnpm@12.16.1

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# Install all workspace dependencies with pnpm
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy the rest of the application
COPY . .

# V1: backend + DB only. React dev server mounted at runtime via volume.
# EXPOSE 3001
CMD ["pnpm", "--filter", "server", "start"]
