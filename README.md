# Minecraft MCP Server

<a href="https://github.com/yuniko-software/minecraft-mcp-server/actions">
  <img alt="CI" src="https://github.com/yuniko-software/minecraft-mcp-server/actions/workflows/build.yml/badge.svg">
</a>
<a href="https://github.com/yuniko-software">
  <img alt="Contribution Welcome" src="https://img.shields.io/badge/Contribution-Welcome-blue">
</a>
<a href="https://github.com/yuniko-software/minecraft-mcp-server/releases/latest">
  <img alt="Latest Release" src="https://img.shields.io/github/v/release/yuniko-software/minecraft-mcp-server?label=Latest%20Release">
</a>

<img width="2063" height="757" alt="image" src="https://github.com/user-attachments/assets/3f0f0438-f079-4226-90bd-87b9e1311d19" />

___

> [!IMPORTANT]
> Currently supports Minecraft version 1.21.11. Newer versions may not work with this MCP server, but we will add support as soon as possible.

https://github.com/user-attachments/assets/6f17f329-3991-4bc7-badd-7cde9aacb92f

A Minecraft bot powered by large language models and [Mineflayer API](https://github.com/PrismarineJS/mineflayer). This bot uses the [Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) to enable Claude and other supported models to control a Minecraft character.

<a href="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server/badge" alt="mcp-minecraft MCP server" />
</a>

## Prerequisites

- Git
- Node.js (>= 20.10.0)
- A running Minecraft game (the setup below was tested with Minecraft 1.21.8 Java Edition included in Microsoft Game Pass)
- An MCP-compatible client. Claude Desktop will be used as an example, but other MCP clients are also supported

## Getting started

This bot is designed to be used with Claude Desktop through the Model Context Protocol (MCP).

### Run Minecraft

Create a singleplayer world and open it to LAN (`ESC -> Open to LAN`). Bot will try to connect using port `25565` and hostname `localhost`. These parameters could be configured in `claude_desktop_config.json` on a next step. 

### MCP Configuration

Make sure that [Claude Desktop](https://claude.ai/download) is installed. Open `File -> Settings -> Developer -> Edit Config`. It should open installation directory. Find file with a name `claude_desktop_config.json` and insert the following code:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:yuniko-software/minecraft-mcp-server",
        "--host",
        "localhost",
        "--port",
        "25565",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

Double-check that right `--port` and `--host` parameters were used. Make sure to completely reboot the Claude Desktop application (should be closed in OS tray). 

## Running

Make sure Minecraft game is running and the world is opened to LAN. Then start Claude Desktop application and the bot should join the game. 

**It could take some time for Claude Desktop to boot the MCP server**. The marker that the server has booted successfully:

<img width="885" height="670" alt="image" src="https://github.com/user-attachments/assets/ccbb42f8-6544-462c-8ac1-8af13ddfcddd" />

You can give bot any commands through any active Claude Desktop chat. You can also upload images of buildings and ask bot to build them 😁

Don't forget to mention that bot should do something in Minecraft in your prompt. Because saying this is a trigger to run MCP server. It will ask for your permissions.

Using Claude Sonnet could give you some interesting results. The bot-agent would be really smart 🫡

Example usage: [shared Claude chat](https://claude.ai/share/535d5f69-f102-4cdb-9801-f74ea5709c0b)

## Available Commands

Once connected to a Minecraft server, Claude can use these commands:

### Movement
- `get-position` - Get the current position of the bot
- `move-to-position` - Move to specific coordinates
- `look-at` - Make the bot look at specific coordinates
- `jump` - Make the bot jump
- `move-in-direction` - Move in a specific direction for a duration

### Flight
- `fly-to` - Make the bot fly directly to specific coordinates

### Inventory
- `list-inventory` - List all items in the bot's inventory
- `find-item` - Find a specific item in inventory
- `equip-item` - Equip a specific item

### Block Interaction
- `place-block` - Place a block at specified coordinates
- `dig-block` - Dig a block at specified coordinates
- `get-block-info` - Get information about a block
- `find-blocks` - Find one or more nearby blocks of a specific type

### Furnace
- `smelt-item` - Smelt items using a furnace-like block

### Entity Interaction
- `find-entity` - Find the nearest entity of a specific type

### Communication
- `send-chat` - Send a chat message in-game
- `read-chat` - Get recent chat messages from players

### Game State
- `detect-gamemode` - Detect the gamemode on game

### Crafting
- `list-recipes` - List recipes the bot can craft with the current inventory. Optional `outputItem` filters by name.
- `craft-item` - Craft an item. Takes `outputItem`, and an optional `amount` (default: 1).
- `get-recipe` - Get recipe details for an item. Takes `itemName`.
- `can-craft` - Check whether the bot can craft an item with the current inventory. Takes `itemName`.

### Connection
These tools manage the connection itself. They work even when the bot is not connected.
- `connect-to-server` - Connect to a Minecraft server, switching from any current connection. Takes `host`, and optional `port`, `username`, `version`.
- `disconnect` - Disconnect from the current Minecraft server.
- `get-connection-status` - Get the connection state, host, port, username, and Minecraft version.

### UI State
- `read-scoreboard` - Read the sidebar, list, and below-name scoreboards.
- `read-window` - Read the open GUI window's items: name, count, lore, and CustomModelData.
- `read-tablist` - Read the tab list header and footer.
- `read-bossbar` - Read all active boss bars: title, color, and progress.
- `read-title` - Read the most recent title, subtitle, and action bar text.
- `read-teams` - Read all scoreboard teams, with color, prefix, suffix, and members.
- `get-resource-pack` - Get the resource pack URL and hash sent by the server, if any.

### Rendering
- `take-screenshot` - Render the bot's surroundings as a PNG image. Optional `width`, `height`, and `firstPerson`.
- `render-window` - Render the open inventory or container window as a PNG image styled after the Minecraft GUI.

### Status
- `get-status` - Get one summary: position, vitals, environment, held item, inventory, and nearby players.

### Automation
- `collect-blocks` - Find, path to, and mine blocks of one type. Takes `blockType`, and optional `count`, `maxDistance`, `timeoutMs`.
- `goto-player` - Path to a named player and stop nearby. Takes `username`, and optional `stopDistance`, `timeoutMs`.
- `follow-player` - Follow a named player until the timeout ends or the player leaves range. Takes `username`, and optional `stopDistance`, `timeoutMs`.
- `scan-area` - Summarize nearby block types, notable blocks, entities, and players. Optional `radius`, `timeoutMs`.

### Control
- `stop` - Stop the action the bot is running now.
- `get-current-action` - Get the action the bot is running now, and its running time.

### Web Viewer
These tools manage the live web viewer. They work even when the bot is not connected.
- `start-viewer` - Start the live web viewer and return its URL.
- `stop-viewer` - Stop the live web viewer.
- `get-viewer-url` - Get the live web viewer's URL, if it is running.

### Real Client
These tools drive a real Minecraft client (see [Real Client](#real-client-1) below), a separate connection from the bot. They work even when the bot is not connected. The client runs a Fabric build of the mod ([why](#real-client-1)), which drops several backend commands the previous NeoForge build had. The six tools marked **(not on Fabric)** below call one of those dropped commands and return the mod's own "Unknown command" error instead of succeeding — everything else works normally.
- `client-status` - Check whether the client process is running, whether its socket is reachable, and what is on screen. Never launches the client. The "what is on screen" part needs the dropped `window` command, so it is always omitted now; process/socket status is unaffected.
- `client-capture` - Take a screenshot from the real client, resource packs and all. Optional `clean` hides the HUD. Launches the client on first use.
- `client-use-item` **(not on Fabric)** - Right-click with the client's held item, the verb that opens hub menus. Optional `hand`.
- `client-close-screen` **(not on Fabric)** - Close any GUI screen open on the client.
- `client-inventory` **(not on Fabric)** - List the client's inventory. Optional `section`, `includeEmpty`, `includeNbt`.
- `client-item` **(not on Fabric)** - Inspect the client's held item or a specific slot. Optional `action`, `hand`, `slot`, `includeNbt`.
- `client-block` **(not on Fabric)** - Probe the targeted block or one at specific coordinates. Optional `action`, `maxDistance`, `x`, `y`, `z`, `includeNbt`.
- `client-entity` **(not on Fabric)** - Probe the entity the client is looking at. Optional `maxDistance`, `includeNbt`.
- `client-teleport` - Move the client to coordinates. Takes `x`, `y`, `z`.
- `client-camera` - Set the client's view direction. Takes `yaw`, `pitch`.
- `client-gamemode` - Switch the client's own gamemode. Takes `mode`.
- `client-spectate` - Ride another player's view, to capture a screenshot from their viewpoint. Takes optional `player`; call with none to leave spectating.
- `client-connect` / `client-disconnect` - Connect or disconnect the client from a Minecraft server, independently of the bot.
- `client-execute` - Run an arbitrary Minecraft command on the client, as an escape hatch. GUIs that used to open via `client-use-item` can still be reached this way, by sending the server-side command that opens them.

## Live Web Viewer

The live web viewer shows the bot's 3D world in a browser. It overlays the scoreboard, boss bars, the title and action bar, the tab list, and the open window.

Start the viewer with the `start-viewer` tool. It returns a URL such as `http://localhost:3007/`. Stop it with `stop-viewer`. Check its address with `get-viewer-url`.

The viewer attaches to whatever bot is currently connected. It reattaches after `connect-to-server` runs. If the bot disconnects, the viewer shows an empty view.

Set `WEB_VIEWER_PORT` to change the port (default: `3007`). See [GUIDE.md](GUIDE.md) for a known limit on reverse-proxy setups.

## Real Client

`take-screenshot` renders vanilla assets only — no resource packs, holograms, custom models or GUI screens. The `client-*` tools close that gap by driving an actual Minecraft client ([Th0rgal/mc-cli](https://github.com/Th0rgal/mc-cli), Fabric build) that runs headlessly in the Docker image and exposes a TCP/JSON control socket. It is a second, independent connection to the server — the bot does the automation, the client is the eye.

The client is launched by [HeadlessMC](https://github.com/headlesshq/headlessmc), a real Minecraft launcher, rather than a hand-built classpath — see [GUIDE.md](GUIDE.md) for why. Fabric's mc-cli build has fewer backend commands than the NeoForge build this image used to run; see the tool list above for exactly which `client-*` tools that affects.

The client launches lazily, on the first `client-*` tool call that needs it (`client-status` never launches it). The first call after a fresh container start can take up to a minute while the client boots. If the client is not running, its socket is unreachable, or a command times out, the `client-*` tools return a clear text error; they never hang the server, and every other tool keeps working normally regardless of the client's state.

See [GUIDE.md](GUIDE.md) for how the client's lifecycle and error handling work.

## Running with Docker

The server can also run over an HTTP transport (MCP Streamable HTTP) inside a container, which is useful for remote/hosted setups. stdio mode remains the default for local Claude Desktop usage (`node dist/main.js`).

```bash
docker build -t minecraft-mcp-server .
docker run --rm -p 3000:3000 \
  -e SERVER_PORT=3000 \
  -e MCP_AUTH_TOKEN=your-long-token \
  minecraft-mcp-server
```

The MCP endpoint is then served at `http://HOST:3000/mcp` and protected by the bearer token. `MC_HOST` is left empty by default, so the server starts idle and the agent joins a Minecraft server at runtime via the `connect-to-server` tool.

Two more variables control optional features. `CHROMIUM_PATH` sets the browser used by `take-screenshot` (default: `/usr/bin/chromium`, already set in this image). `WEB_VIEWER_PORT` sets the port for the live web viewer (default: `3007`).

The image also bundles the real Minecraft client the `client-*` tools drive: Java 21, [HeadlessMC](https://github.com/headlesshq/headlessmc) as the launcher, a pinned Fabric Loader build for Minecraft 1.21.11, the pinned `mccli-fabric` and Fabric API mod jars, and Xvfb with Mesa software OpenGL (there is no GPU). It runs offline-mode, since a hosted deployment has no premium Microsoft account. `MCCLI_HOST` and `MCCLI_PORT` point at the client's control socket (default: `127.0.0.1:25580`, already correct for this image).

Point an MCP client that supports the Streamable HTTP URL transport at the endpoint, sending the token as an `Authorization` header:

```json
{
  "mcpServers": {
    "minecraft": {
      "url": "http://HOST:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-long-token"
      }
    }
  }
}
```

## Pterodactyl

The repository ships a Pterodactyl egg at `pterodactyl/egg-minecraft-mcp-server.json`. Import it from the panel (Admin → Nests → Import Egg). The egg pulls the prebuilt image `ghcr.io/mrmirhan/minecraft-mcp-server:latest`.

To deploy:

1. Create a server from the egg and set `MCP_AUTH_TOKEN` (required, min 16 chars).
2. Allocate a port — Wings injects it as `SERVER_PORT`, so no port variable is needed.
3. Start the server. The console reports `Listening on port <PORT> (MCP Streamable HTTP at /mcp)` once ready.

The agent then connects to `http://<pterodactyl-ip>:<port>/mcp` with the bearer token and uses the `connect-to-server` tool to join any Minecraft server. Leave `MC_HOST` empty to start idle, or set `MC_HOST`/`MC_PORT`/`MC_USERNAME` to auto-connect at boot.

> GitHub Packages images default to **private**. Make the GHCR package public (Package settings → Change visibility → Public), or configure Wings node registry credentials, so Wings can pull the image.

## Contributing

Feel free to submit pull requests or open issues for improvements. All refactoring commits, functional and test contributions, issues and discussion are greatly appreciated!

To get started with contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md).

---

⭐ If you find this project useful, please consider giving it a star on GitHub! ⭐

Your support helps make this project more visible to other people who might benefit from it.
