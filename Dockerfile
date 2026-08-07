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

# --- Real Minecraft client (HeadlessMC launcher + Th0rgal/mc-cli, Fabric build) ---
# A second eye on the world: mineflayer/prismarine-viewer draw vanilla assets only, so
# holograms, resource packs, custom models and GUI screens are invisible to them. This runs
# an actual Fabric Minecraft client headlessly (Xvfb + Mesa software OpenGL, no GPU) and talks
# to its TCP/JSON control socket. See client-status/client-* tools and src/mc-client.ts.
#
# A previous attempt hand-built the launch command for a NeoForge client (concatenating every
# jar under libraries/ alphabetically, then invoking net.neoforged.fml.startup.Client
# directly). That broke two ways on the live container: (1) the alphabetical classpath put an
# older ASM ahead of the one FML needed, so FML's own bootstrap failed with a
# `NoSuchMethodError` on an ASM method, and (2) FML's early-display splash window tried to open
# a GL context and threw a NullPointerException under llvmpipe, which masked (1) until the
# splash was disabled.
#
# HeadlessMC (https://github.com/headlesshq/headlessmc) is a real launcher: `fabric` below
# resolves the Minecraft + Fabric Loader classpath, natives and JVM args the same way the
# vanilla Mojang launcher would, which is what fixes (1) — confirmed by running this chain in
# a scoped container: the ASM NoSuchMethodError is gone. Switching the mod loader to Fabric
# removes (2) outright, since Fabric has no early-display splash window to crash on. Real
# rendering still happens under Xvfb + llvmpipe (confirmed in the same scoped run: real texture
# atlases were built and a captured screenshot had full pixel variance, not a blank frame) —
# HeadlessMC's own `-lwjgl` flag, which rewrites every LWJGL call to a no-op stub, is never
# passed, and `hmc.assets.dummy` is never used, because real assets are the entire point of
# this feature. HeadlessMC silently falls back to that same `-lwjgl` no-op stub whenever it is
# offline (mandatory here — no premium account) and does not positively detect Xvfb, and that
# detection only runs when `hmc.check.xvfb` is set (default false) — so launch-client.sh below
# sets it explicitly every time, not just relying on Xvfb being up.
#
# Fabric's mc-cli build only ships 10 of the 20 commands the NeoForge build had: `interact`,
# `inventory`, `item`, `block`, `entity`, `window` and `resourcepack` are gone. client-* tools
# whose backend command is missing now surface the mod's own "unknown command" error instead of
# succeeding — see README.md/GUIDE.md for exactly which tools that affects.
#
# Versions are pinned, not "latest" — a moving HeadlessMC/Fabric Loader/mccli/Fabric API
# version breaks reproducible builds. Runs offline-mode (fake username/uuid below): the user
# has no premium account.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb libgl1-mesa-dri libglx-mesa0 x11-xserver-utils procps curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=java21 /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

ARG HEADLESSMC_VERSION=2.10.0
ARG HEADLESSMC_JAR_SHA256=52bd5006f478377b3893011d458562977d38c65ead6d2b31089beb4d614f13cd
ARG MC_VERSION=1.21.11
ARG FABRIC_LOADER_VERSION=0.19.3
ARG MCCLI_VERSION=1.4.0
ARG MCCLI_FABRIC_JAR_SHA256=f321589cdfc70232191705c9b295c63ce0947a2fa58446b4327921d4a3b745f4
ARG FABRIC_API_FILENAME=fabric-api-0.141.6+1.21.11.jar
ARG FABRIC_API_MODRINTH_VERSION=6qAuTtLR
ARG FABRIC_API_JAR_SHA256=bdff7fd7e220085cfad2ff9b1f40dde6534ae0b96cf378f97a374bc54cb9ed0f
ENV MC_CLIENT_DIR=/app/mc-client
ENV MCCLI_LAUNCH_SCRIPT=${MC_CLIENT_DIR}/launch-client.sh
ENV MCCLI_SCREENSHOT_DIR=${MC_CLIENT_DIR}/screenshots

# 1. Fetch the launcher itself, plus the two mods that go in Fabric's mods/ folder: mc-cli's
#    own control-socket mod, and Fabric API. mc-cli's fabric.mod.json does not declare Fabric
#    API as a dependency, but its entrypoint class references Fabric API's ClientTickEvents
#    directly and throws NoClassDefFoundError without it — found by actually launching it in
#    the scoped test container, not by reading the manifest.
RUN mkdir -p "${MC_CLIENT_DIR}/game/mods" "${MCCLI_SCREENSHOT_DIR}" \
    && curl -fsSL -o "${MC_CLIENT_DIR}/headlessmc-launcher.jar" \
         "https://github.com/headlesshq/headlessmc/releases/download/${HEADLESSMC_VERSION}/headlessmc-launcher-${HEADLESSMC_VERSION}.jar" \
    && echo "${HEADLESSMC_JAR_SHA256}  ${MC_CLIENT_DIR}/headlessmc-launcher.jar" | sha256sum -c - \
    && curl -fsSL -o "${MC_CLIENT_DIR}/game/mods/mccli-fabric-${MCCLI_VERSION}.jar" \
         "https://github.com/Th0rgal/mc-cli/releases/download/v${MCCLI_VERSION}/mccli-fabric-${MCCLI_VERSION}.jar" \
    && echo "${MCCLI_FABRIC_JAR_SHA256}  ${MC_CLIENT_DIR}/game/mods/mccli-fabric-${MCCLI_VERSION}.jar" | sha256sum -c - \
    && curl -fsSL -o "${MC_CLIENT_DIR}/game/mods/${FABRIC_API_FILENAME}" \
         "https://cdn.modrinth.com/data/P7dR8mSH/versions/${FABRIC_API_MODRINTH_VERSION}/${FABRIC_API_FILENAME}" \
    && echo "${FABRIC_API_JAR_SHA256}  ${MC_CLIENT_DIR}/game/mods/${FABRIC_API_FILENAME}" | sha256sum -c -

# 2. Install Fabric Loader for MC_VERSION. HeadlessMC always keeps the shared library/version/
#    asset cache at "${user.home}/.minecraft" — `hmc.gamedir` does not relocate it, it only
#    controls the actual `--gameDir` Minecraft receives (mods/saves/config, set in step 1 and
#    launch-client.sh below). `-Duser.home` pins that cache under MC_CLIENT_DIR instead of
#    whichever OS user happens to run the command (root here, `container` at runtime), so both
#    stages agree on one location — confirmed empirically, not from HeadlessMC's own docs.
RUN cd "${MC_CLIENT_DIR}" && java \
      -Duser.home="${MC_CLIENT_DIR}/home" \
      -Dhmc.offline=true \
      -Dhmc.gamedir="${MC_CLIENT_DIR}/game" \
      -Dhmc.java.versions="${JAVA_HOME}/bin/java" \
      -jar headlessmc-launcher.jar \
      --command "fabric ${MC_VERSION} --uid ${FABRIC_LOADER_VERSION}"

# 3. Prefetch every vanilla library and the full real asset set (~450MB) with `-prepare`, which
#    downloads everything `launch` needs without opening a window — so the only network call
#    launch-client.sh makes at container runtime is the actual connection to a Minecraft
#    server. `hmc.assets.dummy` is deliberately never set: real textures are the point.
RUN cd "${MC_CLIENT_DIR}" && java \
      -Duser.home="${MC_CLIENT_DIR}/home" \
      -Dhmc.offline=true \
      -Dhmc.gamedir="${MC_CLIENT_DIR}/game" \
      -Dhmc.java.versions="${JAVA_HOME}/bin/java" \
      -jar headlessmc-launcher.jar \
      --command "launch fabric-loader-${FABRIC_LOADER_VERSION}-${MC_VERSION} -prepare -offline"

# 4. The script mc-client.ts actually spawns: brings up Xvfb (idempotent — reused across
#    relaunches within the same container) with software OpenGL, then launches the Fabric
#    client through HeadlessMC. `-Dhmc.check.xvfb=true` is the load-bearing flag from the
#    comment above: without it HeadlessMC assumes no real display exists whenever offline and
#    silently swaps in the LWJGL no-op stub, even with Xvfb genuinely running. No `-lwjgl`,
#    no `-quit` (would let this script's own process exit while the game keeps running
#    detached, breaking McClient's process-liveness tracking), no `-specifics` (that pulls in
#    hmc-specifics, an unrelated mod with its own command set — mc-cli is the control surface
#    here). `< /dev/null`: matches the previous script's non-interactive safeguard.
#
# guiScale and fullscreen are re-applied to options.txt on every launch rather than seeded once
# at build time: options.txt does not exist until Minecraft's first real run, and re-applying
# on every start (not just the first) means a value never silently reverts, whatever Minecraft
# itself does to the file. fullscreen:true fills the Xvfb screen at its configured 1280x720
# (confirmed live: HeadlessMC's -Dhmc.check.xvfb=true path resizes to the real display, not the
# 854x480 window default) rather than needing separate overrideWidth/overrideHeight keys.
#
# MCCLI_USERNAME/MCCLI_UUID come from the environment McClient.ts sets when it spawns this
# script (see spawnProcess); the fallbacks below only matter for a manual run inside the
# container and must match src/mc-client.ts's own DEFAULT_USERNAME fallback.
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
      echo 'MCCLI_USERNAME="${MCCLI_USERNAME:-LLMBotClient}"'; \
      echo "OPTIONS_FILE=\"${MC_CLIENT_DIR}/game/options.txt\""; \
      echo 'touch "$OPTIONS_FILE"'; \
      echo 'set_mc_option() {'; \
      echo '  if grep -q "^$1:" "$OPTIONS_FILE"; then'; \
      echo '    sed -i "s/^$1:.*/$1:$2/" "$OPTIONS_FILE"'; \
      echo '  else'; \
      echo '    echo "$1:$2" >> "$OPTIONS_FILE"'; \
      echo '  fi'; \
      echo '}'; \
      echo 'set_mc_option guiScale 2'; \
      echo 'set_mc_option fullscreen true'; \
      echo "cd \"${MC_CLIENT_DIR}\""; \
      echo "JAVA_ARGS=(-Duser.home=\"${MC_CLIENT_DIR}/home\" -Dhmc.offline=true -Dhmc.check.xvfb=true -Dhmc.offline.username=\"\$MCCLI_USERNAME\" -Dhmc.gamedir=\"${MC_CLIENT_DIR}/game\" -Dhmc.java.versions=\"${JAVA_HOME}/bin/java\")"; \
      echo 'if [ -n "$MCCLI_UUID" ]; then'; \
      echo '  JAVA_ARGS+=(-Dhmc.offline.uuid="$MCCLI_UUID")'; \
      echo 'fi'; \
      echo "exec java \"\${JAVA_ARGS[@]}\" -jar headlessmc-launcher.jar --command \"launch fabric-loader-${FABRIC_LOADER_VERSION}-${MC_VERSION} -offline --jvm -Xmx1536M\" < /dev/null"; \
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
