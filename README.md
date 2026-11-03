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
> The bot supports Minecraft Java up to 26.1.2 (mineflayer 4.39, minecraft-data 3.119). It was checked against a vanilla 26.1.2 server in offline mode. minecraft-data has no 26.2 data yet: to join a 26.2 server, the server (or its proxy) needs ViaBackwards. Node.js 22 or later is required; the Bedrock tools need Node.js 24 (bedrock-protocol), and the Docker image runs 24.

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

## Cinematic camera client (26.2 image)

The `mc26.2` image runs mc-cli 1.8.0 and bakes in Sodium, Iris, Flashback and ReplayMod at pinned versions, each checked
against Modrinth's sha512. `client-record` takes `render: true`, a frame-exact recording that is slower than real time
but never choppy. Use it when there is no GPU or when shaders are on. `motionBlur` blends frames into each output frame.

| Variable | Effect |
|---|---|
| `MC_GPU` | `auto` (default) draws on `/dev/dri/renderD128` through VirtualGL when the device is passed into the container. `off` forces software. |
| `MC_GPU_DEVICE` | Another render node. |
| `MC_CLIENT_MEMORY` | The game's heap (default `2G`). |
| `POENA_AGENT_SECRET` | Written to `config/poena-agent.secret` for proxies that admit agents only. |
| `MC_EXTRA_MODS` | Space-separated `file.jar=https://...` mods fetched at launch, for mods that may not be in a public image. |
| `MC_EXTRA_MODS_TOKEN` | Bearer token for those URLs. GitHub release asset API URLs are supported. |
| `MC_SHADERPACKS` | `modrinth:<project>:<version>` shaderpacks fetched at launch. They are never baked in, because of their licences. |

To give the client a GPU, pass the device in. A Swarm service cannot do this, so use compose:
`devices: ["/dev/dri:/dev/dri"]`, plus `group_add` for the host's `render` group.

## Live view

`GET /live?fps=10&width=640` streams the camera client's screen as MJPEG (multipart/x-mixed-replace), behind the same
bearer token. An `<img>` can show it, so a workshop on another machine can watch the camera. ffmpeg grabs the Xvfb
screen only while someone watches, with at most three viewers. The reply is 503 when the client is not running.

## Recordings over HTTP

`client-record` with a bare file name (`path: "shot-1.mp4"`) saves the video in the recordings folder (`MC_RECORDINGS_DIR`,
default `<tmp>/mcp-recordings`), and its result carries `download: "/files/shot-1.mp4"`. A caller on another machine fetches
it with `GET /files/<name>` and removes it with `DELETE /files/<name>`. Both use the same bearer token as `/mcp`. Only
plain names inside that folder are served.

## Tool sets

The server offers eight groups of tools. `--toolsets` (or `MC_TOOLSETS`) takes a comma-separated list; without it, the server offers all of them.

| Tool set | Tools | Needs |
| --- | --- | --- |
| `bot` | The mineflayer bot: movement, blocks, inventory, crafting, chat, entities, UI state, status, automation, control, connection | Nothing extra |
| `render` | `take-screenshot`, `render-window`: pictures drawn without a client | `canvas` |
| `viewer` | The live web viewer | `prismarine-viewer`, `puppeteer-core` |
| `client` | The `client-*` tools: a real client through mc-cli | The real client (see [Real Client](#real-client-1)) |
| `scenario` | `scenario-run`: scripted tests with several bots | Nothing extra |
| `bedrock` | The `bedrock-*` tools: a Bedrock protocol bot and the Microsoft sign-in (see [Bedrock bot](#bedrock-bot)) | `bedrock-protocol`, an optional dependency, and Node.js 24 |
| `actors` | The `actors-*` tools: paper-actors' fake players inside a Paper or Minestom test server, and its metrics (see [Paper actors](#paper-actors)) | paper-actors on the server (the Paper plugin, or minestom-actors in a Minestom server), `PAPER_ACTORS_SECRET` |
| `bedrock-client` | The `bedrock-client-*` tools: the real Bedrock client and mc-cli's bridge (see [Real Bedrock client](#real-bedrock-client)) | mc-cli's `mccli` CLI, mcpelauncher, licensed game files, and the bridge |

For example, an agent that tests a server with protocol bots, and drives its real client by other means, runs `MC_TOOLSETS=bot,scenario`.

## Bedrock bot

The `bedrock-*` tools drive a second bot, separate from the Java bot: a Bedrock player without a client ([bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol), MIT). It joins a Bedrock server, or a Java server through Geyser, and speaks Bedrock 1.26.0 to 1.26.60 (default 1.26.60).

- `bedrock-connect` - Join `host` (port 19132 by default, RakNet). `auth: "offline"` (default) joins as `username`, and the server must allow offline players: `online-mode=false` on a Bedrock Dedicated Server, or Geyser with `auth-type: offline` or Floodgate. `auth: "microsoft"` joins as the Microsoft account signed in with `bedrock-login` (its gamertag), for online servers; `account` picks one of several.
- `bedrock-login`, `bedrock-login-status`, `bedrock-logout` - Microsoft sign-in without a password: `bedrock-login` answers a code and a link, the person enters the code at microsoft.com/link with an account that owns Bedrock, and the sign-in finishes by itself. The tokens renew themselves and live in `BEDROCK_AUTH_DIR` (default `~/.minecraft-mcp/bedrock-auth`, owner-only files). mc-cli's bridge reads the same layout: share the folder and one sign-in serves the bot and the real client.
- `bedrock-disconnect` - Leave the server.
- `bedrock-status` - Connected or not (and why it left), the server, position, dimension, game mode, health, the tab list, and how many forms are open.
- `bedrock-send-chat`, `bedrock-read-chat` - Send chat; read the chat, system and translated messages it received.
- `bedrock-command` - Run a command and get the server's answer. The bot needs the permission, and the server must allow cheats for commands such as `/tp`.
- `bedrock-forms`, `bedrock-form-respond` - The forms the server opened (Floodgate/Cumulus forms and Geyser's own forms; a Java chest menu stays a Bedrock inventory), and answer one: a button index, true or false, or a custom form's values. No answer closes the form.

The bot does not walk and draws nothing: place it with commands on a test server.

**Install.** `bedrock-protocol` is an optional dependency and needs Node.js 24; on older Node, npm leaves it out, the rest of the server works, and the `bedrock-*` tools answer that it is not installed. Its RakNet (`raknet-native`) ships prebuilt binaries, but looked only for the running kernel's folder (`linux-5-x64`) and fell back to building with cmake on Linux 6. Install with `SKIP_BUILD=1 npm install`: the `postinstall` script (`scripts/fix-raknet.cjs`) links the prebuilt binary for the running kernel, so no cmake or compiler is needed. Behind an HTTPS proxy, the Microsoft sign-in needs `NODE_USE_ENV_PROXY=1`.

Checked live against a Bedrock Dedicated Server 1.26.61 (offline mode, cheats on): join and spawn position, game mode, chat both ways, the tab list, `/list` and `/tp` with their answers, and the position after `/tp`. Forms are covered by unit tests only, because a vanilla Bedrock server opens none. `bedrock-login` got a device code from Microsoft; joining an online server signed in was not tested here (it needs an account that owns Bedrock).

## Paper actors

The `actors-*` tools drive [paper-actors](https://github.com/MrMirhan/paper-actors), which puts fake players inside a test server, as a Paper plugin or, from 0.2.0, as `minestom-actors` in a Minestom server (the same API): real server players with no client and no connection. They cost far less than a bot each, so they suit crowds; and every action goes through the server's own packet handlers, so plugins see a real player's events (`PlayerInteractEvent`, `BlockBreakEvent`, `InventoryClickEvent`, `PlayerInteractEntityEvent`, `SignChangeEvent`, ...).

- `actors-spawn` - One actor, or a crowd (`count` + `prefix`, or `names`) that joins a few per tick; `spread` scatters it, `view` sets each one's view distance.
- `actors-act` - One action: walking and `goto` (pathfinding), fighting, `select`/`use`/`use_on`/`place`/`break` (digs for as long as survival takes), `interact` with a player or entity, every container click type and drags, `close`, screen `button`, anvil `rename` (its field is `text`, because `name` is the actor's), villager `trade`, `sign`, `chat` and `command`.
- `actors-actor` - One actor in detail: position, health, inventory, the open screen with its slots and the cursor item.
- `actors-metrics` - TPS, tick times (avg, p95, max), loaded chunks, entities, heap: read before and after a crowd to measure it.
- `actors-state`, `actors-events`, `actors-despawn`, `actors-scene-play`, `actors-scene-stop`.

Set `PAPER_ACTORS_SECRET` (the plugin's secret) and `PAPER_ACTORS_URL` (default `http://127.0.0.1:4331`; the plugin listens on loopback unless its `api.host` says otherwise, with a 32+ character secret). The plugin refuses any server not in its `allowed-servers`: it is for test servers only.

On Minestom, Minestom's own events fire (`PlayerMoveEvent`, `PlayerBlockBreakEvent`, `InventoryPreClickEvent`, `EntityAttackEvent`, ...), Minestom applies no damage itself, and `trade` needs the game's own trade handler. The server's name comes from `ACTORS_SERVER_NAME`; see paper-actors' README.

Checked against Paper 26.2 build 135: breaking in survival, placing, opening a chest, shift click, pickup and right drag, closing, `goto` around a wall, a command, a villager's trade screen, and a crowd of 100 joining in 7 seconds with the metrics before and after.

## Real Bedrock client

The `bedrock-client-*` tools drive the real Bedrock client on Linux (mcpelauncher) through mc-cli's `mccli bedrock`, and read its game from mc-cli's bridge, which joins the client to a server. See mc-cli's [docs/BEDROCK.md](https://github.com/MrMirhan/mc-cli/blob/main/docs/BEDROCK.md).

- `bedrock-client-launch`, `-status`, `-quit`, `-logs` - Start the client from its game files and wait for its window, check it, stop it, read its log.
- `bedrock-client-screenshot`, `-click`, `-key`, `-type`, `-scroll`, `-chat` - See the window, and use it as a player does: a click returns a screenshot after it.
- `bedrock-client-join` - From the title screen, join the LAN world the bridge shows.
- `bedrock-bridge-status` - The bridge: the server it relays to, offline or `microsoft` and the account, a pending sign-in code, its clients.
- `bedrock-client-state`, `-chat-log`, `-forms`, `-form-respond` - What the bridge sees of the client's game: world, position, dimension, game mode, health, inventory by item name, title, tab list, nearby players, chat and open forms; and answering a form.

The bridge joins the server as the Microsoft account signed in into its token folder, or offline when there is none (`--auth auto`, its default); `--offline` / `--auth microsoft` choose explicitly. Sign in once with `bedrock-login` into a folder the bridge shares: with `--auth microsoft` a waiting bridge goes on by itself; in `auto` restart it to pick the sign-in up.

**Docker.** `docker build --build-arg BEDROCK_CLIENT=true .` adds mcpelauncher (from minecraft-linux's apt repository), xdotool, x11-utils, ImageMagick and mc-cli's CLI; the client draws on its own Xvfb display (`BEDROCK_DISPLAY`, default `:98`). The game files are licensed per Google account and never baked in. `docker/bedrock/compose.yml` runs the MCP server with the client next to the bridge (its own image, `docker/bedrock/bridge.Dockerfile`), on one network, with a shared token volume:

```bash
cd docker/bedrock
BEDROCK_SERVER=play.example.net:19132 MCP_AUTH_TOKEN=... BEDROCK_BRIDGE_TOKEN=... docker compose up --build
```

| Variable | Effect |
|---|---|
| `MCCLI_BIN` | The mccli command (default `mccli`) |
| `BEDROCK_BRIDGE_URL`, `BEDROCK_BRIDGE_TOKEN` | The bridge's control API and its token (default `http://127.0.0.1:19150`, no token on loopback) |
| `BEDROCK_AUTH_DIR` | The Microsoft token folder, shared with the bridge's `--auth-dir` |
| `MCCLI_BEDROCK_GAME`, `MCCLI_BEDROCK_CREDENTIALS` | The client's game files and licence files (mc-cli) |
| `BEDROCK_DISPLAY`, `BEDROCK_START_XVFB` | The client's X display, and whether to start Xvfb on it (the image's Bedrock variant does) |

The image changes were not built here (no Docker daemon). The tools, the bridge and its state were checked against a Bedrock Dedicated Server 1.26.61 with a protocol client joining through the bridge; a real mcpelauncher client was not run here.

## Game text is data

Chat, signs, books, item names and lore, titles, scoreboards and kick reasons are written by players and plugins. A player can write instructions there for the model that reads them. So each answer of a tool comes between `<game-data>` and `</game-data>`, and the server's instructions tell the model to read that text as data and never follow it. A `</game-data>` inside the text is broken, so the text cannot end the block itself. This is not a filter: the model still sees the text, and the client's own rules still apply. See [yuniko-software/minecraft-mcp-server#261](https://github.com/yuniko-software/minecraft-mcp-server/issues/261).

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

### Menus and screens
Every click and screen a player uses, sent with the vanilla client's own packets, so plugins see a real player's events.
- `window-state` - The open screen (or the player inventory) as data: type, slots with lore and hover texts, the item on the cursor, and the screen's properties (enchanting costs, anvil cost, lectern page).
- `window-click` - Click a slot: `left`, `right`, `shift`, `shift_right`, `number` (keys 1-9, with `hotbar`), `offhand` (F), `middle` (creative clone), `drop` (Q), `drop_stack` (Ctrl+Q), `double`, `pickup_all`, `outside_left` / `outside_right` (slot -999).
- `window-drag` - Drag the cursor stack over slots: `left` splits it evenly, `right` puts one in each, `middle` a full stack in each (creative).
- `window-button` - A screen button: enchanting table 0-2, stonecutter recipe, loom pattern, lectern previous/next/take/page.
- `anvil-rename` - Type a name in the anvil (search and input menus read it); optional `take`.
- `sign-write`, `sign-read` - Write either side of a sign, or answer the sign editor a plugin opened; read both sides.
- `book-read`, `book-write` - Read a book in a slot, in hand or on a lectern, page by page; write pages and optionally sign it.
- `villager-trades`, `villager-trade` - List the offers of the open trading screen; trade an offer one or more times.
- `beacon-set-effect` - Choose the beacon's primary and secondary effect.
- `recipe-book`, `recipe-place` - List the recipe book and click a recipe so the server fills the grid (optionally as many as possible).
- `creative-set-slot` - Put any item in an inventory slot in creative mode.
- `dialog-read`, `dialog-respond` - Read and answer dialogs (Minecraft 1.21.6+ and Paper's Dialog API): fill text, boolean, option and number inputs; press a button by index or label; exit.
- `chat-actions`, `chat-click` - List chat messages with clickable `[buttons]` and hover text; click one (`run_command`, `custom` and `show_dialog` act; `suggest_command` sends only with `send`).

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
These tools drive a real Minecraft client (see [Real Client](#real-client-1) below), a separate connection from the bot. They work even when the bot is not connected. The client runs a Fabric build of the mod ([why](#real-client-1)); since mc-cli 1.5.0 that build has every backend command the tools below use.
- `client-status` - Check whether the client process is running, whether its socket is reachable, its current username, and what is on screen. Never launches the client.
- `client-set-username` - Change the client's in-game username, deriving the matching offline UUID the way a server would. Restarts the client if it is currently running (the response says so); otherwise the value applies on the next launch.
- `client-capture` - Take a screenshot from the real client, resource packs and all. Optional `clean` hides the HUD. `layer` `gui`, `tooltip` or `gui+tooltip` returns the open menu and/or the hovered tooltip on a transparent background (`split` for two images, `guiScale`, `trim`; needs mc-cli 26.x from the fork). Launches the client on first use.
- `client-gui` - The open screen as data: widgets, slots with each item's lore and the tooltip the client draws, the hovered slot. Actions `hover`, `click`, `right_click`, `shift_click`, `button` (by label text), `close`. Needs mc-cli 26.x from the fork.
- `client-events` - What happened, in order (chat, titles, action bar, screens, this tool's commands, packet counts, positions while recording), read with a cursor (`since`); `packets` turns packet logging off, summary or all.
- `client-record` - Record video with the game's sound inside the client: `.mp4`, or `.mov`/`.webm` with a transparent GUI layer; `preset`, `priority` (`smooth` 60 fps, `light` 30 fps), a `camera` move, `durationMs`, `wait`. An events log (`.events.jsonl`) is written next to the video.
- `client-target` - Drive the hidden camera client (`camera`, default) or the player's own Minecraft with mc-cli installed (`own`), found through `~/.mccli/instances.json`. The player's game asks for consent, shows a badge and pauses with F8.
- `client-use-item` - Right-click with the client's held item, the verb that opens hub menus. Optional `hand`.
- `client-close-screen` - Close any GUI screen open on the client.
- `client-inventory` - List the client's inventory. Optional `section`, `includeEmpty`, `includeNbt`.
- `client-item` - Inspect the client's held item or a specific slot. Optional `action`, `hand`, `slot`, `includeNbt`.
- `client-block` - Probe the targeted block or one at specific coordinates. Optional `action`, `maxDistance`, `x`, `y`, `z`, `includeNbt`.
- `client-entity` - Probe the entity the client is looking at. Optional `maxDistance`, `includeNbt`.
- `client-teleport` - Teleport the client's player with the server's `/tp` (needs that permission on the server; otherwise teleport it from the server console). Takes `x`, `y`, `z`.
- `client-camera` - Set the client's view direction (`yaw`, `pitch`), or move a render-only camera that leaves the player where it is (`move`): `set`, `orbit`, `path` (keyframes with `fov`), `follow` (keep a moving entity in frame), `attach` (ride with the player's own view), `shot` (`push_in`, `pull_out`, `crane_up`, `crane_down`, `reveal`, `dolly_zoom`), `fov`, `reset`.
- `client-gamemode` - Switch the client's own gamemode. Takes `mode`.
- `client-spectate` - Ride another player's view, to capture a screenshot from their viewpoint. Takes optional `player`; call with none to leave spectating.
- `client-connect` / `client-disconnect` - Connect or disconnect the client from a Minecraft server, independently of the bot.
- `client-execute` - Run an arbitrary Minecraft command on the client, as an escape hatch.
- `client-slots` - List the open container's slots: index, GUI position and centre, item. Optional `includeEmpty`.
- `client-hover` - Move the mouse over a slot (`slot`) or a GUI point (`x`, `y`) so the game draws the hover highlight and the tooltip, then capture (default). Optional `capture`, `settleMs`.
- `client-click` - Click like a player on a slot or a GUI point, handled by the screen's own click logic. Optional `button` (left/right/middle), `shift`, `mode` (click/press/release), `capture`, `settleMs`.
- `client-slot-click` - Send a container click for a slot directly: `type` pickup, quick_move, swap (with `button` = hotbar index), clone, throw, quick_craft, pickup_all.
- `client-key` - Press a key (`tab`, `f3`, `escape`, `e`, … or a GLFW code): `mode` tap, press, release, or hold (press, wait `holdMs`, capture, release) for the player list or the debug screen.
- `client-type` - Type `text` into the open screen (chat, sign editor, anvil, book, any text box) as character events. Optional `enter` presses Enter afterwards; optional `capture`.
- `client-interact` - Right-click a block (`x`, `y`, `z`, `face`) or an entity (`entityId`), or whatever the client looks at.

`client-slots`, `client-hover`, `client-click`, `client-slot-click` and `client-key` need mc-cli's `input` command (mouse, keys and slots), which is not in an upstream mc-cli release yet. The image pins the [MrMirhan/mc-cli](https://github.com/MrMirhan/mc-cli/releases/tag/v1.6.0-input.1) fork release 1.6.0-input.1, which adds it (see [GUIDE.md](GUIDE.md)). With an upstream mc-cli jar these five answer `Unknown command: input`, and every other tool keeps working. `client-type` needs the `type` input action from fork release [1.6.0-input.3](https://github.com/MrMirhan/mc-cli/releases/tag/v1.6.0-input.3), which only the `:mc26.2` image pins; on `:latest` it answers `Unknown input action 'type'`.

### Scenario tests
- `scenario-run` - Run a scripted test with several protocol bots and get pass/fail per step. Takes `scenario` (object) or `file`, optional `junit` (report path).

Set `SCENARIO_TEST_SERVERS=127.0.0.1:25565` (comma-separated exact host:port values for approved **test** servers)
before using write steps. The JSON `testServer:true` flag alone does not authorize commands, chat or clicks.
The same runs from a shell for CI: `npm run scenario -- shop.json --junit report.xml` (exit code 0 when every step passed).

```json
{"name": "kit shop", "server": {"host": "127.0.0.1", "port": 25565, "testServer": true},
 "bots": [{"name": "tester1"}],
 "setup": [{"bot": "tester1", "command": "/give @s compass"}],
 "steps": [
   {"bot": "tester1", "use_item": true},
   {"expect_window": {"bot": "tester1", "title_contains": "Kits", "within": 3000}},
   {"expect_slot": {"bot": "tester1", "slot": 13, "name_contains": "Warrior", "lore_contains": "500"}},
   {"bot": "tester1", "click_slot": 13},
   {"expect_message": {"bot": "tester1", "contains": "You bought", "within": 3000}}
 ],
 "cleanup": [{"bot": "tester1", "command": "/clear"}]}
```

Steps: `command`, `chat`, `use_item`, `click_slot` (with `click`: `right`, `shift`, `number` + `hotbar`, `offhand`, `middle`,
`drop`, `drop_stack`, `double`, `outside_left`, ...), `drag` `{slots, button}`, `window_button`, `rename` `{name, take}`, `sign`
`{lines, back, x, y, z}`, `book` `{pages, title}`, `trade` `{index, times}`, `beacon` `{primary, secondary}`, `recipe` `{recipe, all}`,
`creative` `{slot, item, count}`, `dialog` `{button, inputs, exit}`, `chat_click` `{contains, send}`, `close_window`, `wait` (ms);
checks: `expect_message`, `expect_window`, `expect_slot`, `expect_dialog` `{title_contains}`, `expect_cursor` `{name_contains}`
with `within` (default 5000 ms). Every screen step is a write, so it needs an allowlisted test server. A failed step skips the rest; cleanup always runs. `command`, `chat` and
`click_slot`, `use_item` and `close_window` can change server state, so a scenario with them is refused unless
`server.testServer` is true **and** its exact address is in `SCENARIO_TEST_SERVERS`. On a live server a scenario
may only join, wait and read assertions. Bots log in offline-mode.

## Live Web Viewer

The live web viewer shows the bot's 3D world in a browser. It overlays the scoreboard, boss bars, the title and action bar, the tab list, and the open window.

Start the viewer with the `start-viewer` tool. It returns a URL such as `http://localhost:3007/`. Stop it with `stop-viewer`. Check its address with `get-viewer-url`.

The viewer attaches to whatever bot is currently connected. It reattaches after `connect-to-server` runs. If the bot disconnects, the viewer shows an empty view.

Set `WEB_VIEWER_PORT` to change the port (default: `3007`). See [GUIDE.md](GUIDE.md) for a known limit on reverse-proxy setups.

## Real Client

`take-screenshot` renders vanilla assets only — no resource packs, holograms, custom models or GUI screens. The `client-*` tools close that gap by driving an actual Minecraft client ([Th0rgal/mc-cli](https://github.com/Th0rgal/mc-cli), Fabric build) that runs headlessly in the Docker image and exposes a TCP/JSON control socket. It is a second, independent connection to the server — the bot does the automation, the client is the eye.

The client is launched by [HeadlessMC](https://github.com/headlesshq/headlessmc), a real Minecraft launcher, rather than a hand-built classpath — see [GUIDE.md](GUIDE.md) for why.

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

The image also bundles the real Minecraft client the `client-*` tools drive: Java 21, [HeadlessMC](https://github.com/headlesshq/headlessmc) as the launcher, a pinned Fabric Loader build for Minecraft 1.21.11, the pinned `mccli-fabric` and Fabric API mod jars, and Xvfb with Mesa software OpenGL (there is no GPU). It runs offline-mode, since a hosted deployment has no premium Microsoft account. `MCCLI_HOST` and `MCCLI_PORT` point at the client's control socket (default: `127.0.0.1:25580`, already correct for this image). mc-cli 26.x builds from the fork require a token on every request: set `MCCLI_TOKEN` in the container environment, so the game and this server share it. Without it, the server reads the token file the game registered in `~/.mccli/instances.json`.

A second image tag, `ghcr.io/mrmirhan/minecraft-mcp-server:mc26.2`, runs the Minecraft 26.2 client instead: Java 25, Fabric Loader 0.19.5, Fabric API 0.161.0+26.2, the mc-cli fork build `mccli-fabric-26.2-1.8.0`, and GeyserMC [Rainbow](https://github.com/GeyserMC/Rainbow) 0.2.1, a client mod that generates Geyser custom item and block mappings plus a Bedrock resource pack from the items it sees (`/rainbow create`, `/rainbow map`, `/rainbow finish`; the output goes to `.minecraft/rainbow/<name>/`). Use it for 26.2 servers. `:latest` stays on 1.21.11. The build arguments of both variants are in `.github/workflows/docker-publish.yml`.

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
