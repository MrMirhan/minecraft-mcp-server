# Operating Guide

This guide is for someone who runs this server and directs the bot through it. It explains how the parts work together, when to pick one tool over another, and what the server cannot do. For the full command list, see [README.md](README.md).

## How the pieces fit together

**BotConnection** (`src/bot-connection.ts`) owns the mineflayer bot instance. It connects, reconnects on drop, and switches servers on `connect-to-server`. Every tool reads the current bot through this object. A tool always acts on whichever bot is connected right now, even after a reconnect.

**ActionManager** (`src/action-manager.ts`) is a single shared object. It tracks one long-running action at a time. Ten tools run through it: `move-to-position`, `move-in-direction`, `place-block`, `dig-block`, `fly-to`, `craft-item`, `smelt-item`, `collect-blocks`, `goto-player`, and `follow-player`. The `stop` and `get-current-action` tools read and cancel through this same object. See "Long-running actions" below for the exact rules.

**Tool modules** (`src/tools/*.ts`) group the 44 tools by purpose, from movement and blocks to crafting, UI state, and rendering. See [README.md](README.md) for the full list by category. Each module registers its tools on the same MCP server. None of them call each other directly.

**The web viewer** (`src/web-viewer.ts`) is a small HTTP server, separate from the MCP connection. It shows the bot's 3D world with a scoreboard, boss bar, title, tab list, and window overlay. It starts and stops on its own schedule through `start-viewer` and `stop-viewer`, not tied to any single tool call. See "The live viewer" below.

## Choosing between tools that overlap

### `read-window` versus `render-window`

`read-window` returns exact text: slot number, item name, count, the display name, lore lines, and the `CustomModelData` value if the item has one. Use it when an exact value matters, such as checking which `CustomModelData` a crafted item carries, or reading long lore text.

`render-window` returns a PNG image styled like the Minecraft inventory GUI. It draws each item from the bundled vanilla texture set, or a colored square if no texture matches. Use it for a quick visual layout check, such as confirming which slots hold items. It does not show a server's resource pack, a `CustomModelData` model swap, or the real Minecraft font. For exact values, use `read-window` instead.

### `get-status` versus the individual calls

`get-status` returns one summary in a single call:

- position, dimension, and biome
- health, food, and oxygen
- gamemode, time of day, and weather
- the held item
- a top-8 inventory summary
- the five nearest players

Use it to orient at the start of a task, or after a long action, in one round trip.

The individual calls (`get-position`, `detect-gamemode`, `list-inventory`, and so on) return one exact fact each. `list-inventory` lists every slot. `get-status` only summarizes the top 8 item types. Use the individual call when you need the full detail that `get-status` truncates, or when you poll one value on its own.

### A composite tool versus a chain of low-level calls

`collect-blocks`, `goto-player`, `follow-player`, and `scan-area` each run a small loop internally: find a target, path to it, act, and repeat. Each one reports why it stopped: timeout, distance exhausted, or done. Use a composite tool for a well-defined chore with no decisions mid-task, such as mining ten blocks or walking to a player.

A hand-built chain of `find-blocks`, `move-to-position`, and `dig-block` gives more control. Use it when you need to inspect results between steps, react to surprises, or target blocks a composite tool's fixed logic does not fit. `collect-blocks`, for example, always searches outward from the bot's current position, not a fixed area.

## Long-running actions

Ten tools share the `ActionManager`: `move-to-position`, `move-in-direction`, `place-block`, `dig-block`, `fly-to`, `craft-item`, `smelt-item`, `collect-blocks`, `goto-player`, and `follow-player`. For these ten, the following rules apply.

- **One action at a time.** Starting a new one of these ten tools interrupts whichever of the ten is still running.
- **A new action interrupts the old one.** The old call does not fail with a silent error. It resolves with a message that says it was interrupted, after its own cleanup runs (the pathfinder stops, a furnace window closes, and so on).
- **A timeout reports partial progress**, in whatever form fits the action. `craft-item` reports how many items it finished before the timeout. `fly-to` reports the position it reached. `smelt-item` reports what it loaded into the furnace even if no output appeared.
- **`stop` cancels the current one of the ten.** `get-current-action` reports its label and running time. Both tools read the same `ActionManager` state.

`scan-area` is the one composite tool outside the `ActionManager`. It never moves the bot and never waits on the server, so it cannot block another action or be interrupted usefully.

An action that ignores its abort signal cannot wedge the manager. After an interrupt, the manager waits a short grace period for the action to clean up. If the action does not finish, the manager abandons it, frees its caller with a message that says so, and lets the next action start. An abandoned action that settles later cannot resolve its old caller a second time.

The real limit on cancellation is this: mineflayer has no way to cancel `bot.placeBlock()` or `bot.craft()` once the call starts talking to the server. `bot.stopDigging()` can request an early stop of an in-progress dig. `collect-blocks` calls it on a timeout. This is a request, not a guaranteed mid-swing cancel. In practice, you can only interrupt one of these calls before it starts, or after it finishes. Interruption never happens in the middle of one dig, one placement, or one craft.

## The live viewer

`start-viewer` starts an HTTP server that shows the bot's 3D surroundings in a browser tab. The page overlays the scoreboard, boss bars, the title and action bar, the tab list, and the open window. Hold Tab in the browser tab to show the tab list. `stop-viewer` stops the server and frees its port. `get-viewer-url` reports the current URL, or says the viewer is not running.

The viewer's lifecycle follows the bot connection, not the tool calls. It attaches to whichever bot is connected right now. It reattaches after `connect-to-server` switches servers. If the bot disconnects, the viewer shows an empty view. The HTTP server itself keeps running across reconnects. Only `stop-viewer` shuts it down.

If the bot's Minecraft version is newer than prismarine-viewer supports, the viewer falls back to the nearest older version's assets. It does this the same way `take-screenshot` does. See "Screenshot limits" below. `start-viewer` and `get-viewer-url` report this fallback in their reply text.

A known limit affects reverse proxies. prismarine-viewer's bundled browser client requests its live-update channel at the fixed path `/socket.io`. It always requests this exact path at the root of the domain, no matter where its other assets load from. The built-in web viewer already proxies this correctly on its own port.

Some setups place a further reverse proxy in front of the whole web viewer. If that proxy forwards only a subpath, it must also forward the bare `/socket.io` path at the domain root. For example, a proxy that forwards only `https://example.com/bot/` must also forward `https://example.com/socket.io` to the same backend. Without that second rule, the overlay page loads, but the 3D world never streams.

## Screenshot limits

`take-screenshot` renders through prismarine-viewer, which supports Minecraft versions up to 1.21.4. This server connects to 1.21.11 by default. When the bot's version is newer than prismarine-viewer supports, both tools fall back to the nearest older version's textures. They report the fallback in their reply text. Blocks or items added after that version can look wrong or be missing.

The Docker image keeps only three of prismarine-viewer's bundled texture sets: 1.21.4, 1.21.1, and 1.20.1. If the fallback version lands outside that set, `take-screenshot` returns an error naming the missing version. It does not return a blank or wrong image. The error suggests using a newer server, or rebuilding the image with that version's textures kept.

## What this server cannot verify visually

This server cannot show what a resource pack's textures look like when the client draws them. It cannot check font or negative-space alignment inside a textured GUI. It cannot confirm how a color actually looks on screen.

`take-screenshot` and `render-window` draw from prismarine-viewer's bundled vanilla texture set. They never draw the resource pack the server sent. `get-resource-pack` only returns the pack's URL and hash. It does not download or apply the pack. `render-window` ignores `CustomModelData` when it draws an item. It always shows the base vanilla texture, or a colored placeholder square if none exists. Neither tool renders the real Minecraft font.

For all of this, the data tools give an exact value instead of a picture:

- `read-window` returns the real `CustomModelData` integer
- `read-teams` and `read-bossbar` return color as a name
- `read-title` and `read-tablist` return the raw text with its formatting codes

Treat these as ground truth. Treat the rendered images as a rough layout check only.

## Environment variables

| Variable | Default | Affects |
|---|---|---|
| `MC_HOST` | `localhost` | Minecraft server host for stdio mode and Docker auto-connect |
| `MC_PORT` | `25565` | Minecraft server port |
| `MC_USERNAME` | `LLMBot` | Bot username |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `SERVER_PORT` / `PORT` | `3000` | Port for the `http` transport |
| `MCP_AUTH_TOKEN` | none | Bearer token required by the `http` transport |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | Browser executable used by `take-screenshot` |
| `WEB_VIEWER_PORT` | `3007` | Port for the live web viewer |

`WEB_VIEWER_PORT` must not equal the MCP HTTP port. `start-viewer` refuses to start and reports the conflict if the two match.
