import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BotConnection } from './bot-connection.js';
import { MessageStore } from './message-store.js';
import { ToolFactory } from './tool-factory.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerConnectionTools } from './tools/connection-tools.js';
import { registerUiTools } from './tools/ui-tools.js';
import { registerRenderTools } from './tools/render-tools.js';
import { registerStatusTools } from './tools/status-tools.js';
import { registerCompositeTools } from './tools/composite-tools.js';
import { registerControlTools } from './tools/control-tools.js';
import { registerViewerTools } from './tools/viewer-tools.js';
import { registerClientTools } from './tools/client-tools.js';
import { ActionManager } from './action-manager.js';
import { McClient } from './mc-client.js';

// The HTTP transport builds a fresh McpServer per session, but only one real Minecraft
// client may exist per process: it costs ~2GB and binds a single control port.
let sharedMcClient: McClient | null = null;

const SERVER_NAME = "minecraft-mcp-server";
const SERVER_VERSION = "2.0.4";

const SERVER_INSTRUCTIONS = `Controls a Minecraft bot through mineflayer. The bot reads game state; it does not see the client's screen.

Start of a session:
- Call get-status first. It returns position, health, food, gamemode, dimension, biome, time, weather, held item, inventory and nearby players in one call. Do not chain get-position, detect-gamemode and list-inventory to learn the same things.
- If the bot is not connected, use connect-to-server. host is required; version is optional and auto-detected.

Choosing between overlapping tools:
- read-window returns exact slot contents: item name, count, display name, lore and CustomModelData. render-window returns a picture of the same window. Use read-window to check whether a value is correct, render-window to see the layout.
- Prefer a composite tool over a chain of low-level calls. collect-blocks replaces find-blocks plus move-to-position plus dig-block repeated per block. scan-area replaces many find-blocks calls.
- read-scoreboard, read-tablist, read-bossbar, read-title and read-teams keep the raw section-sign colour codes. The codes are the answer when checking colours, so do not strip them.

Long-running actions:
- move-to-position, move-in-direction, dig-block, place-block, fly-to, craft-item, smelt-item and the composite tools run one at a time. Starting a second one interrupts the first.
- stop cancels whatever is running. get-current-action reports what is running and for how long.
- On timeout these tools report partial progress, for example "collected 4 of 10". Read that as partial success, not failure.
- mineflayer cannot cancel a single dig, place or craft call once it starts. Interruption happens between operations.

What this bot cannot do:
- It cannot confirm that a texture, custom model, font alignment or colour renders correctly on a player's screen. take-screenshot draws the world with vanilla assets and no resource pack; render-window draws vanilla item icons. For anything that depends on how the client actually paints the screen, ask the user for a screenshot instead of claiming it was verified.
- get-resource-pack reports whether the server sent a pack and its URL and hash. It does not report whether the pack loaded correctly on a client.
- take-screenshot renders with the newest assets prismarine-viewer supports. On a newer server it falls back to older assets and says so in the response.

start-viewer opens a live browser view of the bot with a UI overlay, and returns the URL. It follows the bot across reconnects and server switches.`;

export function createMcpServer(connection: BotConnection, messageStore: MessageStore): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;
  const actionManager = new ActionManager();

  registerPositionTools(factory, getBot, actionManager);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot, actionManager);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot, actionManager);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot, actionManager);
  registerFurnaceTools(factory, getBot, actionManager);
  registerConnectionTools(factory, connection);
  registerUiTools(factory, getBot);
  registerRenderTools(factory, getBot);
  registerStatusTools(factory, getBot);
  registerCompositeTools(factory, getBot, actionManager);
  registerControlTools(factory, getBot, actionManager);
  registerViewerTools(factory, connection);
  sharedMcClient ??= new McClient();
  registerClientTools(factory, sharedMcClient);

  return server;
}
