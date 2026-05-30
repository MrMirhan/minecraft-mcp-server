#!/bin/bash
cd /home/container || exit 1

INTERNAL_IP=$(ip route get 1 2>/dev/null | awk '{print $(NF-2);exit}')
export INTERNAL_IP

# Pterodactyl overrides STARTUP from the egg; this default makes plain
# `docker run` work too. The app reads SERVER_PORT, MCP_AUTH_TOKEN and MC_*
# from the environment, so no flags are needed beyond the transport.
STARTUP=${STARTUP:-"node /app/dist/main.js --transport http"}

# Convert Pterodactyl {{VAR}} placeholders to ${VAR} and expand against env.
MODIFIED_STARTUP=$(echo -e "${STARTUP}" | sed -e 's/{{/${/g' -e 's/}}/}/g')

echo ":/home/container$ ${MODIFIED_STARTUP}"
eval ${MODIFIED_STARTUP}
