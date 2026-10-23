import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { McClient } from '../mc-client.js';

type ToolResponse = ReturnType<ToolFactory['createResponse']>;

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
    "Take a screenshot from the real Minecraft client. Unlike take-screenshot, this shows exactly what a player would see: resource packs, holograms, custom models, and open GUI screens included. layer gui, tooltip or gui+tooltip returns the open menu and/or the hovered item's tooltip on a transparent background instead (split: two images). Launches the camera client on first use, which can take up to a minute.",
    {
      clean: z.boolean().optional().describe("Hide the HUD before capturing (default: false)"),
      layer: z.enum(['world', 'gui', 'tooltip', 'gui+tooltip']).optional().describe("world (default) or a transparent GUI layer"),
      split: z.boolean().optional().describe("With gui+tooltip: the menu and the tooltip as two images"),
      guiScale: z.coerce.number().int().min(1).max(8).optional().describe("GUI scale for this capture only"),
      trim: z.boolean().optional().describe("Crop a transparent layer to its pixels plus 8 px (default: true)")
    },
    async ({ clean = false, layer, split, guiScale, trim }: { clean?: boolean; layer?: string; split?: boolean; guiScale?: number; trim?: boolean }) => {
      const extra: Record<string, unknown> = {
        ...(layer ? { layer } : {}),
        ...(split !== undefined ? { split } : {}),
        ...(guiScale !== undefined ? { gui_scale: guiScale } : {}),
        ...(trim !== undefined ? { trim } : {})
      };
      const result = Object.keys(extra).length > 0 ? await mcClient.captureScreenshot(clean, extra) : await mcClient.captureScreenshot(clean);
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      const buffers = result.buffers ?? [result.buffer];
      return {
        content: buffers.map((b) => ({ type: "image", data: b.toString('base64'), mimeType: "image/png" }))
      } as unknown as ToolResponse;
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-gui",
    "The open screen as data, and actions on it. read (default): widgets, container slots with each item's name, lore and the tooltip this client draws, the hovered slot. hover / click / right_click / shift_click {slot or x,y}, button {text}: clicks the first active button whose label contains it, close.",
    {
      action: z.enum(['read', 'hover', 'click', 'right_click', 'shift_click', 'button', 'close']).optional().describe("Default: read"),
      slot: z.coerce.number().int().optional().describe("Container slot index"),
      x: z.coerce.number().optional().describe("GUI x, with y, instead of slot"),
      y: z.coerce.number().optional().describe("GUI y"),
      text: z.string().optional().describe("Part of the button label, for action button"),
      includeEmpty: z.boolean().optional().describe("read: include empty slots (default: true)")
    },
    async ({ action = 'read', slot, x, y, text, includeEmpty }: { action?: string; slot?: number; x?: number; y?: number; text?: string; includeEmpty?: boolean }) => {
      const result = await mcClient.request('gui', {
        action,
        ...(slot !== undefined ? { slot } : {}),
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(includeEmpty !== undefined ? { include_empty: includeEmpty } : {})
      });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-events",
    "What happened in the client, in order: chat, system, title, subtitle, actionbar, screen_open, screen_close, agent (this tool's commands), packets (counts per second), player (positions while recording), record_start/stop. Pass the returned next as since to get only new events. packets turns packet logging off, summary or all.",
    {
      since: z.coerce.number().int().optional().describe("Cursor from the last call (default 0)"),
      types: z.array(z.string()).optional().describe("Only these event types"),
      limit: z.coerce.number().int().optional().describe("At most this many (default 200)"),
      packets: z.enum(['off', 'summary', 'all']).optional().describe("Set packet logging instead of reading")
    },
    async ({ since, types, limit, packets }: { since?: number; types?: string[]; limit?: number; packets?: string }) => {
      const params = packets
        ? { action: 'packets', mode: packets }
        : { action: 'read', ...(since !== undefined ? { since } : {}), ...(types ? { types } : {}), ...(limit !== undefined ? { limit } : {}) };
      const result = await mcClient.request('events', params);
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-record",
    "Record video with the game's sound inside the client (not a window grab). action start|stop|status. path: absolute .mp4, or .mov/.webm with a transparent layer (gui, tooltip, gui+tooltip). preset max|high|balanced|light; priority smooth (60 fps) or light (30 fps). camera: a move (orbit, path, follow, attach, shot) that starts with the first frame. An events log is written next to the video (eventsPath).",
    {
      action: z.enum(['start', 'stop', 'status']).describe("start, stop or status"),
      path: z.string().optional().describe("Absolute output path, for start"),
      preset: z.enum(['max', 'high', 'balanced', 'light']).optional(),
      priority: z.enum(['smooth', 'light']).optional().describe("smooth = 60 fps, light = 30 fps"),
      layer: z.enum(['world', 'gui', 'tooltip', 'gui+tooltip']).optional(),
      camera: z.record(z.string(), z.unknown()).optional().describe("Camera move object, as in client-camera move"),
      durationMs: z.coerce.number().optional().describe("Stop after this long"),
      wait: z.boolean().optional().describe("Return when the file is written (needs durationMs or a timed camera move)"),
      audio: z.boolean().optional().describe("Record the game's sound (default: true)"),
      hud: z.boolean().optional().describe("Keep the HUD (default: false)")
    },
    async ({ action, path: savePath, preset, priority, layer, camera, durationMs, wait, audio, hud }: {
      action: string; path?: string; preset?: string; priority?: string; layer?: string; camera?: Record<string, unknown>;
      durationMs?: number; wait?: boolean; audio?: boolean; hud?: boolean;
    }) => {
      const params: Record<string, unknown> = {
        action,
        ...(savePath ? { path: savePath } : {}),
        ...(preset ? { preset } : {}),
        ...(priority ? { priority } : {}),
        ...(layer ? { layer } : {}),
        ...(camera ? { camera } : {}),
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        ...(wait !== undefined ? { wait } : {}),
        ...(audio !== undefined ? { audio } : {}),
        ...(hud !== undefined ? { hud } : {})
      };
      const result = await mcClient.request('record', params, { timeoutMs: wait ? 660_000 : 30_000 });
      if (!result.ok) {
        return factory.createErrorResponse(result.error);
      }
      return factory.createResponse(JSON.stringify(result.data));
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "client-target",
    "Choose which game the client-* tools drive: camera (the workshop's hidden camera client, the default) or own (the player's own Minecraft with mc-cli installed, signed in with their own account). Only switch to own after the player said yes in this conversation; their game shows a consent screen and an F8 pause key, and live servers stay read-only. Returns what the player allows.",
    {
      target: z.enum(['camera', 'own']).describe("camera or own"),
      port: z.coerce.number().int().optional().describe("The game's mc-cli port (default: found in ~/.mccli/instances.json)"),
      host: z.string().optional().describe("Default 127.0.0.1"),
      token: z.string().optional().describe("Default: the token file the game registered")
    },
    async ({ target, port, host, token }: { target: 'camera' | 'own'; port?: number; host?: string; token?: string }) => {
      let chosenPort = port;
      if (chosenPort === undefined) {
        const instances = await mcClient.listInstances();
        const pick = target === 'own'
          ? instances.find((i) => i.headless !== true && typeof i.port === 'number')
          : instances.find((i) => i.headless === true && typeof i.port === 'number');
        chosenPort = (pick?.port as number | undefined) ?? (target === 'camera' ? 25580 : undefined);
      }
      if (chosenPort === undefined) {
        return factory.createErrorResponse("No game of the player is running with mc-cli. Ask them to start their Minecraft with the mc-cli mod installed (Fabric or NeoForge), then try again.");
      }
      mcClient.setTarget({ name: target, host: host ?? '127.0.0.1', port: chosenPort, token });
      const control = await mcClient.request('control', {});
      if (!control.ok) {
        return factory.createErrorResponse(`Switched to ${target} on port ${chosenPort}, but it did not answer: ${control.error}`);
      }
      return factory.createResponse(`Now driving ${target} (port ${chosenPort}). The player allows: ${JSON.stringify(control.data)}`);
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
    "Turn the player (yaw, pitch), or move a render-only camera that does not move the player (move): {action: set|look_at|frame_area|frame_entity|orbit|path|follow|attach|shot|fov|reset|status, ...}. follow keeps a moving entity in frame (entity, distance, angle 180 = behind, smoothingMs); attach rides with the player's own view; shot builds promo moves (push_in, pull_out, crane_up, crane_down, reveal, dolly_zoom) toward target {x,y,z}; path keyframes may carry fov.",
    {
      yaw: z.coerce.number().optional().describe("Horizontal rotation, -180 to 180 (turns the player)"),
      pitch: z.coerce.number().optional().describe("Vertical rotation, -90 to 90 (turns the player)"),
      move: z.record(z.string(), z.unknown()).optional().describe("Render-only camera action object")
    },
    async ({ yaw, pitch, move }: { yaw?: number; pitch?: number; move?: Record<string, unknown> }) => {
      if (!move && (yaw === undefined || pitch === undefined)) {
        return factory.createErrorResponse("Give yaw and pitch, or a move object");
      }
      const result = await mcClient.request('camera', move ?? { yaw, pitch });
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
