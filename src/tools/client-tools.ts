import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { McClient } from '../mc-client.js';

type ToolResponse = ReturnType<ToolFactory['createResponse']>;

function imageResponse(buffer: Buffer): ToolResponse {
  return {
    content: [{ type: "image", data: buffer.toString('base64'), mimeType: "image/png" }]
  } as unknown as ToolResponse;
}

const MOUSE_BUTTONS = { left: 0, right: 1, middle: 2 } as const;
const GLFW_MOD_SHIFT = 1;
const SLOT_CLICK_TYPES = ['pickup', 'quick_move', 'swap', 'clone', 'throw', 'quick_craft', 'pickup_all'] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pointParams(slot: number | undefined, x: number | undefined, y: number | undefined): Record<string, number> | null {
  if (slot !== undefined) {
    return { slot };
  }
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }
  return null;
}

function formatStatus(status: Awaited<ReturnType<McClient['getStatus']>>): string {
  const lines = [
    `Process: ${status.processState}`,
    `PID: ${status.pid ?? 'none'}`,
    `Username: ${status.username}`,
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
    "client-set-username",
    "Change the real Minecraft client's in-game username, deriving the matching offline UUID the same way a server would. The username is a JVM property fixed at launch, so if the client is currently running this restarts it to apply the change; the tool response says whether a restart happened. If the client is not running, the new value is recorded for the next launch.",
    {
      username: z.string().describe("New in-game username, 3-16 letters, digits and underscores")
    },
    async ({ username }: { username: string }) => {
      const result = await mcClient.setUsername(username);
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      const { uuid, restarted } = result.data as { uuid: string; restarted: boolean };
      const message = restarted
        ? `Username changed to "${username}" (offline UUID ${uuid}). The client was restarted to apply it.`
        : `Username set to "${username}" (offline UUID ${uuid}). The client is not running, so this takes effect on the next launch.`;
      return factory.createResponse(message);
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
    "Teleport the real Minecraft client's player with the server's /tp command (needs the permission on the server; without it, teleport from the server console). A client-side position change is corrected by the server, so this goes through the server.",
    {
      x: z.coerce.number().describe("Target x"),
      y: z.coerce.number().describe("Target y"),
      z: z.coerce.number().describe("Target z")
    },
    async ({ x, y, z }: { x: number; y: number; z: number }) => {
      const result = await mcClient.request('execute', { command: `tp ${x} ${y} ${z}` });
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

  async function captureAfter(settleMs: number, text: string): Promise<ToolResponse> {
    await sleep(settleMs);
    const shot = await mcClient.captureScreenshot(false);
    if (!shot.ok) {
      return factory.createErrorResponse(`${text}\nThe capture failed: ${shot.error}`);
    }
    return {
      content: [
        { type: "text", text },
        { type: "image", data: shot.buffer.toString('base64'), mimeType: "image/png" }
      ]
    } as unknown as ToolResponse;
  }

  factory.registerTool(
    "client-slots",
    "List the slots of the container screen open on the real client (a chest menu, the player inventory, a furnace): each slot's index, GUI position and centre, and item. Use the index with client-hover, client-click or client-slot-click.",
    {
      includeEmpty: z.boolean().optional().describe("Also list empty slots (default: false)")
    },
    async ({ includeEmpty = false }: { includeEmpty?: boolean }) => {
      const result = await mcClient.request('input', { action: 'slots' });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      const data = result.data as Record<string, unknown> & { slots?: Array<{ item?: { empty?: boolean } }> };
      const slots = (data.slots ?? []).filter((slot) => includeEmpty || !slot.item?.empty);
      return factory.createResponse(JSON.stringify({ ...data, slots }));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-hover",
    "Move the real client's mouse over a container slot or a GUI point, so the game draws the slot highlight and the item's tooltip, then capture the screen (default). GUI coordinates are window pixels divided by the GUI scale.",
    {
      slot: z.coerce.number().int().optional().describe("Slot index from client-slots"),
      x: z.coerce.number().optional().describe("GUI x, when no slot is given"),
      y: z.coerce.number().optional().describe("GUI y, when no slot is given"),
      capture: z.boolean().optional().describe("Capture the screen after moving (default: true)"),
      settleMs: z.coerce.number().int().min(0).max(5000).optional().describe("Wait before the capture so the tooltip is drawn (default: 150)")
    },
    async ({ slot, x, y, capture = true, settleMs = 150 }: { slot?: number; x?: number; y?: number; capture?: boolean; settleMs?: number }) => {
      const point = pointParams(slot, x, y);
      if (!point) {
        return factory.createErrorResponse('Give a slot index, or both x and y');
      }
      const result = await mcClient.request('input', { action: 'mouse_move', ...point });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      const text = JSON.stringify(result.data);
      return capture ? captureAfter(settleMs, text) : factory.createResponse(text);
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-click",
    "Click with the real client's mouse the way a player does: on a container slot or a GUI point, handled by the open screen's own click logic (menu buttons, slot pickup, shift-click quick move). Without a slot or point it clicks where the cursor already is.",
    {
      slot: z.coerce.number().int().optional().describe("Slot index from client-slots"),
      x: z.coerce.number().optional().describe("GUI x, when no slot is given"),
      y: z.coerce.number().optional().describe("GUI y, when no slot is given"),
      button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button (default: left)"),
      shift: z.boolean().optional().describe("Hold shift during the click (quick move in containers)"),
      mode: z.enum(['click', 'press', 'release']).optional().describe("click (default), or only press / release for drags"),
      capture: z.boolean().optional().describe("Capture the screen after the click (default: false)"),
      settleMs: z.coerce.number().int().min(0).max(5000).optional().describe("Wait before the capture, for the server to answer (default: 300)")
    },
    async ({ slot, x, y, button = 'left', shift = false, mode = 'click', capture = false, settleMs = 300 }: {
      slot?: number; x?: number; y?: number; button?: 'left' | 'right' | 'middle'; shift?: boolean;
      mode?: 'click' | 'press' | 'release'; capture?: boolean; settleMs?: number;
    }) => {
      const point = pointParams(slot, x, y) ?? {};
      const result = await mcClient.request('input', {
        action: 'mouse_click', ...point, button: MOUSE_BUTTONS[button], modifiers: shift ? GLFW_MOD_SHIFT : 0, mode
      });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      const text = JSON.stringify(result.data);
      return capture ? captureAfter(settleMs, text) : factory.createResponse(text);
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-slot-click",
    "Send a container click for a slot directly (no cursor movement), like the game's own slot click: pickup, quick_move (shift-click), swap with a hotbar key (button = hotbar index 0-8, 40 = offhand), clone, throw, quick_craft or pickup_all. Slot -999 clicks outside the window.",
    {
      slot: z.coerce.number().int().describe("Slot index from client-slots, or -999"),
      button: z.coerce.number().int().min(0).max(40).optional().describe("Mouse button or hotbar index for swap (default: 0)"),
      type: z.enum(SLOT_CLICK_TYPES).optional().describe("Click type (default: pickup)")
    },
    async ({ slot, button = 0, type = 'pickup' }: { slot: number; button?: number; type?: typeof SLOT_CLICK_TYPES[number] }) => {
      const result = await mcClient.request('input', { action: 'slot_click', slot, button, type });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-key",
    "Press a key on the real client like a player: tap it, press or release it, or hold it and capture while it is down (Tab shows the player list, F3 the debug screen, Escape closes a menu, E opens the inventory).",
    {
      key: z.string().describe("Key name (tab, f3, escape, e, enter, space, left.shift, a-z, 0-9) or a GLFW key code"),
      mode: z.enum(['tap', 'press', 'release', 'hold']).optional().describe("tap (default), press, release, or hold: press, wait holdMs, capture, release"),
      holdMs: z.coerce.number().int().min(0).max(10000).optional().describe("How long to hold before the capture in hold mode (default: 300)"),
      capture: z.boolean().optional().describe("Capture the screen afterwards (default: true for hold, false otherwise)")
    },
    async ({ key, mode = 'tap', holdMs = 300, capture }: { key: string; mode?: 'tap' | 'press' | 'release' | 'hold'; holdMs?: number; capture?: boolean }) => {
      const keyParam = /^\d+$/.test(key.trim()) ? Number(key.trim()) : key;
      const shouldCapture = capture ?? mode === 'hold';
      if (mode !== 'hold') {
        const result = await mcClient.request('input', { action: 'key', key: keyParam, mode });
        if (!result.ok) {
          return factory.createErrorResponse(result.error);
        }
        const text = JSON.stringify(result.data);
        return shouldCapture ? captureAfter(150, text) : factory.createResponse(text);
      }
      const pressed = await mcClient.request('input', { action: 'key', key: keyParam, mode: 'press' });
      if (!pressed.ok) {
        return factory.createErrorResponse(pressed.error);
      }
      let response: ToolResponse;
      try {
        const text = JSON.stringify(pressed.data);
        response = shouldCapture ? await captureAfter(holdMs, text) : (await sleep(holdMs), factory.createResponse(text));
      } finally {
        await mcClient.request('input', { action: 'key', key: keyParam, mode: 'release' });
      }
      return response;
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-type",
    "Type text into the real client's open screen like a player: chat (open it with client-key t first), a sign editor, an anvil name field, a book, any text box. Sends one character per code point; use enter to submit chat or move to the next sign line, and client-key for backspace or arrows.",
    {
      text: z.string().describe("Text to type"),
      enter: z.boolean().optional().describe("Press Enter after typing (default: false)"),
      capture: z.boolean().optional().describe("Capture the screen afterwards (default: false)")
    },
    async ({ text, enter = false, capture = false }: { text: string; enter?: boolean; capture?: boolean }) => {
      const typed = await mcClient.request('input', { action: 'type', text });
      if (!typed.ok) {
        return factory.createErrorResponse(typed.error);
      }
      let data: Record<string, unknown> = typed.data;
      if (enter) {
        const pressed = await mcClient.request('input', { action: 'key', key: 'enter', mode: 'tap' });
        if (!pressed.ok) {
          return factory.createErrorResponse(`${JSON.stringify(typed.data)}\nEnter failed: ${pressed.error}`);
        }
        data = { ...typed.data, enter: pressed.data };
      }
      const responseText = JSON.stringify(data);
      return capture ? captureAfter(150, responseText) : factory.createResponse(responseText);
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-interact",
    "Right-click a block or an entity with the real client, like a player: opens a chest or a crafting table, talks to an NPC, uses the held item on the target. Without coordinates or an entity id it uses what the client is looking at.",
    {
      target: z.enum(['block', 'entity']).describe("What to right-click"),
      x: z.coerce.number().int().optional().describe("Block x (block target)"),
      y: z.coerce.number().int().optional().describe("Block y (block target)"),
      z: z.coerce.number().int().optional().describe("Block z (block target)"),
      face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Block face to click (default: up)"),
      entityId: z.coerce.number().int().optional().describe("Entity id (entity target); see client-entity"),
      hand: z.enum(['main', 'off']).optional().describe("Hand to use (default: main)")
    },
    async ({ target, x, y, z: bz, face, entityId, hand }: {
      target: 'block' | 'entity'; x?: number; y?: number; z?: number; face?: string; entityId?: number; hand?: 'main' | 'off';
    }) => {
      const params: Record<string, unknown> = { action: target === 'block' ? 'use_on_block' : 'use_on_entity' };
      if (target === 'block' && x !== undefined && y !== undefined && bz !== undefined) {
        Object.assign(params, { x, y, z: bz });
      }
      if (face) params.face = face;
      if (target === 'entity' && entityId !== undefined) params.entity_id = entityId;
      if (hand) params.hand = hand;
      const result = await mcClient.request('interact', params);
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );
}
