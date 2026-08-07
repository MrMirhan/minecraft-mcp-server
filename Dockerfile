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

# tini for PID 1 signal handling; iproute2 for the entrypoint's `ip route`;
# chromium + fontconfig/fonts-dejavu-core for the render-tools screenshot/canvas pipeline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates iproute2 chromium fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Pterodactyl requires a `container` user with home at /home/container.
RUN useradd -m -d /home/container -s /bin/bash container

WORKDIR /app

# Production dependencies only — no dev deps, no TS sources.
# scripts.prepare (tsc, needs devDeps/src not present here) is dropped instead of using
# --ignore-scripts, because canvas's own install script must still run to fetch its native binary.
COPY package*.json ./
RUN npm pkg delete scripts.prepare \
    && npm ci --omit=dev \
    && npm cache clean --force

# prismarine-viewer ships texture sets for every Minecraft version it supports (~197MB).
# Only the modern ones are worth the image size; screenshots on older servers lose their textures.
RUN cd node_modules/prismarine-viewer/public/textures \
    && for entry in *; do \
         case "$entry" in 1.21.4|1.21.4.png|1.21.1|1.21.1.png|1.20.1|1.20.1.png) ;; *) rm -rf "$entry" ;; esac; \
       done

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
