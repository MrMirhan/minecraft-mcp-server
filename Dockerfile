# syntax=docker/dockerfile:1

# Debian bookworm's own apt repos only ship OpenJDK 17; the real Minecraft client needs
# Java 21+, so the JRE is copied from Temurin's image instead of adding a third-party apt repo.
FROM eclipse-temurin:21-jre-jammy AS java21

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

# --- Real Minecraft client (Th0rgal/mc-cli, NeoForge build) ---
# A second eye on the world: mineflayer/prismarine-viewer draw vanilla assets only, so
# holograms, resource packs, custom models and GUI screens are invisible to them. This runs
# an actual NeoForge Minecraft client headlessly (Xvfb + Mesa software OpenGL, no GPU) and
# talks to its TCP/JSON control socket. See client-status/client-* tools and src/mc-client.ts.
#
# Versions are pinned, not "latest" — a moving NeoForge/mod version breaks reproducible
# builds. Runs offline-mode (fake username/uuid/token below): the user has no premium account.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb libgl1-mesa-dri libglx-mesa0 jq curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=java21 /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

ARG NEOFORGE_VERSION=21.11.45
ARG NEOFORGE_INSTALLER_SHA256=e54350cc68d7dec6cb0523a0597a6a2fa664c1acd878b456af4564ee126da00a
ARG MCCLI_VERSION=1.4.0
ARG MCCLI_JAR_SHA256=dc9099548595301e25eb6d57fbaf128d4ad348358a957666a4b369d5482a3942
ARG MC_VERSION=1.21.11
ARG NEOFORM_VERSION=20251209.172050
ENV MC_CLIENT_DIR=/app/mc-client
ENV MCCLI_LAUNCH_SCRIPT=${MC_CLIENT_DIR}/launch-client.sh
ENV MCCLI_SCREENSHOT_DIR=${MC_CLIENT_DIR}/screenshots

# 1. Run the NeoForge installer's --install-client mode. It needs a launcher_profiles.json
#    to already exist (normally created by the vanilla Mojang launcher on first run), and it
#    downloads + deobfuscates + patches the Minecraft client jar plus NeoForge's own ~26
#    libraries. It does NOT fetch the ~60 remaining vanilla libraries (guava, gson, netty,
#    LWJGL + its per-OS natives, ...) — that is normally the vanilla launcher's job, done here
#    in step 2 instead, filtered to linux-only via each library's `rules`.
RUN mkdir -p "${MC_CLIENT_DIR}/game" "${MCCLI_SCREENSHOT_DIR}" \
    && echo '{"profiles":{},"selectedProfile":"","clientToken":"","authenticationDatabase":{},"launcherVersion":{"name":"","format":21}}' \
         > "${MC_CLIENT_DIR}/game/launcher_profiles.json" \
    && curl -fsSL -o /tmp/neoforge-installer.jar \
         "https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-installer.jar" \
    && echo "${NEOFORGE_INSTALLER_SHA256}  /tmp/neoforge-installer.jar" | sha256sum -c - \
    && java -jar /tmp/neoforge-installer.jar --install-client "${MC_CLIENT_DIR}/game" \
    && rm -f /tmp/neoforge-installer.jar \
    && mkdir -p "${MC_CLIENT_DIR}/game/mods" \
    && curl -fsSL -o "${MC_CLIENT_DIR}/game/mods/mccli-neoforge-${MCCLI_VERSION}.jar" \
         "https://github.com/Th0rgal/mc-cli/releases/download/v${MCCLI_VERSION}/mccli-neoforge-${MCCLI_VERSION}.jar" \
    && echo "${MCCLI_JAR_SHA256}  ${MC_CLIENT_DIR}/game/mods/mccli-neoforge-${MCCLI_VERSION}.jar" | sha256sum -c -

# 2. Fetch the remaining vanilla libraries the installer skipped, and the asset index (block,
#    item and GUI textures are already inside the patched client jar — only sound objects live
#    in the separate CDN, and those are skipped: they cost ~450MB and add nothing a screenshot
#    can show).
RUN VERSION_JSON="${MC_CLIENT_DIR}/game/versions/${MC_VERSION}/${MC_VERSION}.json" \
    && LIBDIR="${MC_CLIENT_DIR}/game/libraries" \
    && jq -c ' \
         def rule_allows: reduce .[] as $r (false; if ($r.os == null) or ($r.os.name == "linux") then ($r.action == "allow") else . end); \
         .libraries[] | select((.rules == null) or (.rules | rule_allows)) | select(.downloads.artifact.path != null) | {path: .downloads.artifact.path, url: .downloads.artifact.url} \
       ' "$VERSION_JSON" > /tmp/needed-libs.jsonl \
    && while IFS= read -r line; do \
         p=$(echo "$line" | jq -r '.path'); \
         u=$(echo "$line" | jq -r '.url'); \
         dest="$LIBDIR/$p"; \
         if [ ! -f "$dest" ]; then mkdir -p "$(dirname "$dest")" && curl -fsSL -o "$dest" "$u"; fi; \
       done < /tmp/needed-libs.jsonl \
    && rm -f /tmp/needed-libs.jsonl \
    && ASSET_ID=$(jq -r '.assetIndex.id' "$VERSION_JSON") \
    && mkdir -p "${MC_CLIENT_DIR}/game/assets/indexes" \
    && curl -fsSL -o "${MC_CLIENT_DIR}/game/assets/indexes/${ASSET_ID}.json" "$(jq -r '.assetIndex.url' "$VERSION_JSON")"

# 3. Resolve the final classpath once, at build time, and freeze it into a plain launch
#    script. This mirrors what net.neoforged.fml.startup.Client (the mod loader's own entry
#    point) expects from the real launcher: every jar under libraries/, offline auth
#    placeholders, and the --fml.* flags it uses to locate its own patched client jar.
RUN LIBDIR="${MC_CLIENT_DIR}/game/libraries" \
    && VERSION_JSON="${MC_CLIENT_DIR}/game/versions/${MC_VERSION}/${MC_VERSION}.json" \
    && ASSET_ID=$(jq -r '.assetIndex.id' "$VERSION_JSON") \
    && CP=$(find "$LIBDIR" -name '*.jar' | sort | tr '\n' ':') \
    && CP="${CP%:}" \
    && { \
         echo '#!/bin/bash'; \
         echo 'set -e'; \
         echo "NATIVES_DIR=\"${MC_CLIENT_DIR}/game/natives\""; \
         echo 'mkdir -p "$NATIVES_DIR"'; \
         echo 'exec java \'; \
         echo '  -Djava.net.preferIPv6Addresses=system \'; \
         echo "  -DlibraryDirectory=\"${LIBDIR}\" \\"; \
         echo '  --add-opens java.base/java.lang.invoke=ALL-UNNAMED \'; \
         echo '  --add-exports jdk.naming.dns/com.sun.jndi.dns=java.naming \'; \
         echo '  -Djava.library.path="$NATIVES_DIR" \'; \
         echo '  -Djna.tmpdir="$NATIVES_DIR" \'; \
         echo '  -Dorg.lwjgl.system.SharedLibraryExtractPath="$NATIVES_DIR" \'; \
         echo '  -Dio.netty.native.workdir="$NATIVES_DIR" \'; \
         echo '  -Dminecraft.launcher.brand=mc-cli-headless \'; \
         echo '  -Dminecraft.launcher.version=1.0 \'; \
         echo "  -cp \"${CP}\" \\"; \
         echo '  net.neoforged.fml.startup.Client \'; \
         echo "  --username MCPBot --version neoforge-${NEOFORGE_VERSION} \\"; \
         echo "  --gameDir \"${MC_CLIENT_DIR}/game\" --assetsDir \"${MC_CLIENT_DIR}/game/assets\" --assetIndex ${ASSET_ID} \\"; \
         echo '  --uuid 00000000-0000-0000-0000-000000000000 --accessToken 0 \'; \
         echo '  --clientId 0 --xuid 0 --versionType release \'; \
         echo "  --fml.neoForgeVersion ${NEOFORGE_VERSION} --fml.mcVersion ${MC_VERSION} --fml.neoFormVersion ${NEOFORM_VERSION}"; \
       } > "${MC_CLIENT_DIR}/run-neoforge.sh" \
    && chmod +x "${MC_CLIENT_DIR}/run-neoforge.sh"

# 4. The script mc-client.ts actually spawns: brings up Xvfb (idempotent — reused across
#    relaunches within the same container) with software OpenGL, then hands off to the
#    resolved launch command above. Runs offline/non-interactive (< /dev/null): without a
#    real display, NeoForge's early-display error screen falls back to an interactive
#    console prompt that would otherwise spin forever reading a stdin that never answers.
RUN { \
      echo '#!/bin/bash'; \
      echo 'set -e'; \
      echo 'export DISPLAY="${DISPLAY:-:99}"'; \
      echo 'export LIBGL_ALWAYS_SOFTWARE=1'; \
      echo 'export GALLIUM_DRIVER=llvmpipe'; \
      echo 'export MESA_GL_VERSION_OVERRIDE=4.5'; \
      echo 'export MESA_GLSL_VERSION_OVERRIDE=450'; \
      echo 'SOCKET="/tmp/.X11-unix/X${DISPLAY#:}"'; \
      echo 'if [ ! -S "$SOCKET" ]; then'; \
      echo '  Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp &'; \
      echo '  for _ in $(seq 1 50); do'; \
      echo '    [ -S "$SOCKET" ] && break'; \
      echo '    sleep 0.2'; \
      echo '  done'; \
      echo 'fi'; \
      echo "exec \"${MC_CLIENT_DIR}/run-neoforge.sh\" < /dev/null"; \
    } > "${MCCLI_LAUNCH_SCRIPT}" \
    && chmod +x "${MCCLI_LAUNCH_SCRIPT}"

# The client process (and its natives/screenshots/logs/saves) runs as the unprivileged
# `container` user below, same as the MCP server itself.
RUN chown -R container:container "${MC_CLIENT_DIR}"

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
