# Sourced by launch-client.sh before the game starts.
#
# GPU: with /dev/dri passed into the container (an Intel or AMD iGPU) and MC_GPU not "off", the game draws on the GPU
# through VirtualGL's EGL back end while Xvfb stays the window; shaders then work and frames come fast. Without it,
# Mesa's llvmpipe draws in software (slow, no shaders: record frame-exact with `render: true` for smooth video).
VGL=""
if [ "${MC_GPU:-auto}" != "off" ] && [ -e "${MC_GPU_DEVICE:-/dev/dri/renderD128}" ] && command -v vglrun >/dev/null 2>&1; then
  VGL="vglrun -d ${MC_GPU_DEVICE:-/dev/dri/renderD128}"
  unset LIBGL_ALWAYS_SOFTWARE GALLIUM_DRIVER MESA_GL_VERSION_OVERRIDE MESA_GLSL_VERSION_OVERRIDE
  echo "[client-env] drawing on the GPU (${MC_GPU_DEVICE:-/dev/dri/renderD128})"
else
  export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe MESA_GL_VERSION_OVERRIDE=4.5 MESA_GLSL_VERSION_OVERRIDE=450
  echo "[client-env] drawing in software (no GPU device)"
fi

CONFIG_DIR="${MC_CLIENT_DIR}/game/config"
mkdir -p "$CONFIG_DIR" "${MC_CLIENT_DIR}/game/shaderpacks" "${MC_CLIENT_DIR}/game/mods"

# This is the workshop's own hidden camera client: every mc-cli command, no consent screen (that is for a person's own game).
printf '{"remoteControl":"on","allow":["observe","input","world"]}\n' > "$CONFIG_DIR/mccli.json"

# A test proxy that admits agents only (agent-gate) reads this secret through the agent-auth mod.
if [ -n "${POENA_AGENT_SECRET:-}" ]; then
  printf '%s' "$POENA_AGENT_SECRET" > "$CONFIG_DIR/poena-agent.secret"
  chmod 600 "$CONFIG_DIR/poena-agent.secret"
fi

# ReplayMod: no rename dialog, no auto server; Flashback keeps its defaults.
[ -f "$CONFIG_DIR/replaymod.json" ] || printf '{"recording":{"renameDialog":false,"autoStartServer":false}}\n' > "$CONFIG_DIR/replaymod.json"

# Mods that are not baked into a public image (MC_EXTRA_MODS: "file.jar=https://..." entries) and shaderpacks under
# their own licences (MC_SHADERPACKS: "modrinth:<project>:<version>"), fetched once into the game folder.
if [ -n "${MC_EXTRA_MODS:-}" ]; then
  node /app/docker/fetch-mods.mjs "${MC_CLIENT_DIR}/game/mods" $MC_EXTRA_MODS || echo "[client-env] extra mods could not be fetched"
fi
if [ -n "${MC_SHADERPACKS:-}" ]; then
  node /app/docker/fetch-mods.mjs "${MC_CLIENT_DIR}/game/shaderpacks" $MC_SHADERPACKS || echo "[client-env] shaderpacks could not be fetched"
fi
