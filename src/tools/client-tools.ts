import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { McClient } from '../mc-client.js';

type ToolResponse = ReturnType<ToolFactory['createResponse']>;

function imageResponse(buffer: Buffer): ToolResponse {
  return {
    content: [{ type: "image", data: buffer.toString('base64'), mimeType: "image/png" }]
  } as unknown as ToolResponse;
}

function formatStatus(status: Awaited<ReturnType<McClient['getStatus']>>): string {
  const lines = [
    `Process: ${status.processState}`,
    `PID: ${status.pid ?? 'none'}`,
    `Started: ${status.startedAt ?? 'never'}`,
    `Socket reachable: ${status.socketReachable ? 'yes' : 'no'}`
  ];

  if (status.exitCode !== null || status.exitSignal !== null) {
    lines.push(`Exited: code ${status.exitCode ?? 'null'}, signal ${status.exitSignal ?? 'null'}`);
  }
  if (status.spawnError) {
    lines.push(`Spawn error: ${status.spawnError}`);
  }
  if (status.game) {
    lines.push(`Game state: ${JSON.stringify(status.game)}`);
  }
  if (status.screen) {
    lines.push(`Screen: ${JSON.stringify(status.screen)}`);
  }
  if (status.lastLogLines.length > 0) {
    lines.push('Recent log lines:', ...status.lastLogLines.map((line) => `  ${line}`));
  }

  return lines.join('\n');
}

export function registerClientTools(factory: ToolFactory, mcClient: McClient): void {
  factory.registerTool(
    "client-status",
    "Get the real Minecraft client's status: whether the client process is running, whether its command socket is reachable, and what is currently on screen. Never launches the client.",
    {},
    async () => {
      const status = await mcClient.getStatus();
      return factory.createResponse(formatStatus(status));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-capture",
    "Take a screenshot from the real Minecraft client. Unlike take-screenshot, this shows exactly what a player would see: resource packs, holograms, custom models, and open GUI screens included. Launches the client on first use, which can take up to a minute.",
    {
      clean: z.boolean().optional().describe("Hide the HUD before capturing (default: false)")
    },
    async ({ clean = false }: { clean?: boolean }) => {
      const result = await mcClient.captureScreenshot(clean);
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return imageResponse(result.buffer);
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-use-item",
    "Right-click with the client's held item. This is the verb that opens hub menus and other item-triggered GUI screens.",
    {
      hand: z.enum(['main', 'off']).optional().describe("Hand to use (default: main)")
    },
    async ({ hand }: { hand?: 'main' | 'off' }) => {
      const result = await mcClient.request('interact', { action: 'use', ...(hand ? { hand } : {}) });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-close-screen",
    "Close any GUI screen currently open on the client",
    {},
    async () => {
      const result = await mcClient.request('window', { action: 'close_screen' });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-inventory",
    "List the real Minecraft client's inventory contents",
    {
      section: z.enum(['hotbar', 'main', 'armor', 'offhand']).optional().describe("Limit the listing to one section (default: all)"),
      includeEmpty: z.boolean().optional().describe("Include empty slots (default: false)"),
      includeNbt: z.boolean().optional().describe("Include NBT SNBT strings (default: false)")
    },
    async ({ section, includeEmpty, includeNbt }: { section?: string; includeEmpty?: boolean; includeNbt?: boolean }) => {
      const result = await mcClient.request('inventory', {
        action: 'list',
        ...(section ? { section } : {}),
        ...(includeEmpty !== undefined ? { include_empty: includeEmpty } : {}),
        ...(includeNbt !== undefined ? { include_nbt: includeNbt } : {})
      });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-item",
    "Inspect the item in the client's hand or a specific inventory slot",
    {
      action: z.enum(['hand', 'slot']).optional().describe("What to inspect (default: hand)"),
      hand: z.enum(['main', 'off']).optional().describe("Hand to inspect when action is hand (default: main)"),
      slot: z.coerce.number().int().optional().describe("Slot index to inspect when action is slot"),
      includeNbt: z.boolean().optional().describe("Include the NBT SNBT string (default: true)")
    },
    async ({ action, hand, slot, includeNbt }: { action?: 'hand' | 'slot'; hand?: 'main' | 'off'; slot?: number; includeNbt?: boolean }) => {
      const result = await mcClient.request('item', {
        ...(action ? { action } : {}),
        ...(hand ? { hand } : {}),
        ...(slot !== undefined ? { slot } : {}),
        ...(includeNbt !== undefined ? { include_nbt: includeNbt } : {})
      });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-block",
    "Probe the block the client is looking at, or a specific block position",
    {
      action: z.enum(['target', 'at']).optional().describe("target = crosshair block, at = specific coordinates (default: target)"),
      maxDistance: z.coerce.number().optional().describe("Max raycast distance for action=target (default: 5)"),
      x: z.coerce.number().optional().describe("Block x, required for action=at"),
      y: z.coerce.number().optional().describe("Block y, required for action=at"),
      z: z.coerce.number().optional().describe("Block z, required for action=at"),
      includeNbt: z.boolean().optional().describe("Include block entity NBT (default: false)")
    },
    async ({ action, maxDistance, x, y, z, includeNbt }: { action?: 'target' | 'at'; maxDistance?: number; x?: number; y?: number; z?: number; includeNbt?: boolean }) => {
      const result = await mcClient.request('block', {
        ...(action ? { action } : {}),
        ...(maxDistance !== undefined ? { max_distance: maxDistance } : {}),
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(z !== undefined ? { z } : {}),
        ...(includeNbt !== undefined ? { include_nbt: includeNbt } : {})
      });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-entity",
    "Probe the entity the client is looking at",
    {
      maxDistance: z.coerce.number().optional().describe("Max allowed distance (default: 5)"),
      includeNbt: z.boolean().optional().describe("Include entity NBT (default: false)")
    },
    async ({ maxDistance, includeNbt }: { maxDistance?: number; includeNbt?: boolean }) => {
      const result = await mcClient.request('entity', {
        action: 'target',
        ...(maxDistance !== undefined ? { max_distance: maxDistance } : {}),
        ...(includeNbt !== undefined ? { include_nbt: includeNbt } : {})
      });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-teleport",
    "Move the real Minecraft client to specific coordinates",
    {
      x: z.coerce.number().describe("Target x"),
      y: z.coerce.number().describe("Target y"),
      z: z.coerce.number().describe("Target z")
    },
    async ({ x, y, z }: { x: number; y: number; z: number }) => {
      const result = await mcClient.request('teleport', { x, y, z });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-camera",
    "Set the real Minecraft client's view direction",
    {
      yaw: z.coerce.number().describe("Horizontal rotation, -180 to 180"),
      pitch: z.coerce.number().describe("Vertical rotation, -90 to 90")
    },
    async ({ yaw, pitch }: { yaw: number; pitch: number }) => {
      const result = await mcClient.request('camera', { yaw, pitch });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-gamemode",
    "Switch the real Minecraft client's own gamemode",
    {
      mode: z.enum(['survival', 'creative', 'adventure', 'spectator']).describe("Gamemode to switch to")
    },
    async ({ mode }: { mode: string }) => {
      const result = await mcClient.request('execute', { command: `gamemode ${mode}` });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(`Switched the client to ${mode} mode.`);
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-spectate",
    "Ride another player's view in spectator mode, to capture a screenshot from their viewpoint (for example, the bot's). Call with no player to leave spectating.",
    {
      player: z.string().optional().describe("Username to spectate. Omit to leave spectator mode.")
    },
    async ({ player }: { player?: string }) => {
      const result = await mcClient.request('execute', { command: player ? `spectate ${player}` : 'spectate' });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(player ? `Spectating ${player}.` : "Left spectator view.");
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-connect",
    "Connect the real Minecraft client to a server, switching from any current connection",
    {
      address: z.string().describe("Server host or IP address"),
      port: z.coerce.number().optional().describe("Server port (default: 25565)"),
      resourcepackPolicy: z.enum(['prompt', 'accept', 'reject']).optional().describe("How to handle the server's resource pack (default: prompt)")
    },
    async ({ address, port, resourcepackPolicy }: { address: string; port?: number; resourcepackPolicy?: string }) => {
      const result = await mcClient.request('server', {
        action: 'connect',
        address,
        ...(port !== undefined ? { port } : {}),
        ...(resourcepackPolicy ? { resourcepack_policy: resourcepackPolicy } : {})
      });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-disconnect",
    "Disconnect the real Minecraft client from its current server or world",
    {},
    async () => {
      const result = await mcClient.request('server', { action: 'disconnect' });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-execute",
    "Run an arbitrary Minecraft command on the real client, as an escape hatch for anything not covered by the other client-* tools",
    {
      command: z.string().describe("Command to run, without the leading /")
    },
    async ({ command }: { command: string }) => {
      const result = await mcClient.request('execute', { command });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );
}
