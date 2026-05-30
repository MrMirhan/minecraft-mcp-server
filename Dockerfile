# syntax=docker/dockerfile:1

# --- Stage 1: build ---
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# --ignore-scripts skips the package's `prepare` hook (which runs the build);
# sources are copied next and the build is run explicitly below.
COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json eslint.config.mjs ./
COPY src ./src
RUN npm run build

# --- Stage 2: runtime ---
FROM node:22-bookworm-slim

# tini for PID 1 signal handling; iproute2 for the entrypoint's `ip route`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Pterodactyl requires a `container` user with home at /home/container.
RUN useradd -m -d /home/container -s /bin/bash container

WORKDIR /app

# Production dependencies only — no dev deps, no TS sources.
# --ignore-scripts skips the `prepare` build hook (no tsc/dev deps here).
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Wings bind-mounts the server volume over /home/container at runtime, so the
# app lives at /app and is launched via its absolute path.
WORKDIR /home/container
ENV USER=container HOME=/home/container

EXPOSE 3000
STOPSIGNAL SIGINT

USER container

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/entrypoint.sh"]
