# mc-cli's Bedrock bridge: shows a Bedrock server to the real client as a LAN world and relays its game, offline or
# signed in with Microsoft, and serves what it sees on a control API (bedrock-client-state and friends).
FROM node:24-bookworm-slim
ARG MCCLI_REPO=MrMirhan/mc-cli
ARG MCCLI_REF=96c7dbc
ADD https://github.com/${MCCLI_REPO}/archive/${MCCLI_REF}.tar.gz /tmp/mccli.tar.gz
# SKIP_BUILD: raknet-native's prebuilt binary is linked by the package's postinstall; no cmake.
RUN mkdir -p /opt/mccli \
    && tar -xzf /tmp/mccli.tar.gz -C /opt/mccli --strip-components=1 \
    && rm /tmp/mccli.tar.gz \
    && cd /opt/mccli/bedrock \
    && SKIP_BUILD=1 npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
# The same uid as the MCP image's `container` user, so both read the shared token folder (owner-only files).
RUN groupadd -g 1001 container && useradd -u 1001 -g 1001 -m container \
    && mkdir -p /bedrock-auth && chown container:container /bedrock-auth && chmod 700 /bedrock-auth
WORKDIR /opt/mccli/bedrock
USER container
ENTRYPOINT ["node", "bridge.mjs"]
