import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { BedrockClient, query } from '../bedrock-client.js';

// The real Bedrock client (mcpelauncher, through mc-cli's `mccli bedrock`) and what mc-cli's bridge sees of
// its game. They do not need the Java bot, so they skip its connection check.

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function registerBedrockClientTools(factory: ToolFactory, client: BedrockClient): void {
  const skip = { skipConnectionCheck: true };
  const json = (o: unknown) => factory.createResponse(JSON.stringify(o, null, 1));
  const withShot = async (text: string) => {
    const shot = await client.screenshot();
    const content: Content[] = [
      { type: "text", text: `${text}\nScreenshot ${shot.width} x ${shot.height}; click takes these pixels.` },
      { type: "image", data: shot.png.toString('base64'), mimeType: "image/png" }
    ];
    return { content } as unknown as ReturnType<typeof factory.createResponse>;
  };

  factory.registerTool(
    "bedrock-client-launch",
    "Start the real Bedrock client (mcpelauncher, from licensed game files) and wait for its window; it opens on the title screen. Then bedrock-client-join joins the bridge's LAN world.",
    {
      version: z.string().optional().describe("Game version (default: the newest there are files for)"),
      width: z.number().int().optional().describe("Window width (default 1280; bedrock-client-join needs 1280 x 720)"),
      height: z.number().int().optional().describe("Window height (default 720)")
    },
    async ({ version, width, height }: { version?: string; width?: number; height?: number }) => {
      const args = ['launch'];
      if (version) args.push('--version', version);
      if (width) args.push('--width', String(width));
      if (height) args.push('--height', String(height));
      return json(await client.mccli(args, 150_000));
    },
    skip
  );

  factory.registerTool(
    "bedrock-client-status",
    "Whether the real Bedrock client runs, its window and size, and the game versions there are files for.",
    {},
    async () => json(await client.mccli(['status'])),
    skip
  );

  factory.registerTool(
    "bedrock-client-screenshot",
    "A picture of the real Bedrock client's window, as the player sees it: menus, the world with its resource packs, forms, chat.",
    {},
    async () => withShot('The Bedrock client.'),
    skip
  );

  factory.registerTool(
    "bedrock-client-click",
    "Click at x, y of the client's window, in the screenshot's pixels. The client takes a click only after the pointer rested on it; this does that. capture returns a screenshot after.",
    {
      x: z.number().int(), y: z.number().int(),
      button: z.enum(['left', 'middle', 'right']).optional(),
      double: z.boolean().optional(),
      capture: z.boolean().optional().describe("Screenshot after (default true)")
    },
    async ({ x, y, button = 'left', double, capture = true }: { x: number; y: number; button?: string; double?: boolean; capture?: boolean }) => {
      const args = ['click', String(x), String(y), '--button', button];
      if (double) args.push('--double');
      await client.mccli(args);
      return capture ? withShot(`Clicked ${x}, ${y} (${button}).`) : factory.createResponse(`Clicked ${x}, ${y} (${button}).`);
    },
    skip
  );

  factory.registerTool(
    "bedrock-client-key",
    "Press keys in the client, each held for a moment (xdotool names: Escape, Return, Tab, w, space, ctrl+a, F1). A slow client (software rendering) can miss one: check with a screenshot.",
    { keys: z.array(z.string()).min(1), capture: z.boolean().optional().describe("Screenshot after (default false)") },
    async ({ keys, capture }: { keys: string[]; capture?: boolean }) => {
      await client.mccli(['key', ...keys]);
      return capture ? withShot(`Pressed ${keys.join(' ')}.`) : factory.createResponse(`Pressed ${keys.join(' ')}.`);
    },
    skip
  );

  factory.registerTool(
    "bedrock-client-type",
    "Type text into the client's focused text box (chat, a sign, a form's input, a server address).",
    { text: z.string().min(1) },
    async ({ text }: { text: string }) => factory.createResponse(JSON.stringify(await client.mccli(['type', text]))),
    skip
  );

  factory.registerTool(
    "bedrock-client-scroll",
    "Turn the mouse wheel in the client (lists, the hotbar in game).",
    { direction: z.enum(['up', 'down']), amount: z.number().int().min(1).max(20).optional() },
    async ({ direction, amount = 3 }: { direction: string; amount?: number }) => factory.createResponse(JSON.stringify(await client.mccli(['scroll', direction, '--amount', String(amount)]))),
    skip
  );

  factory.registerTool(
    "bedrock-client-chat",
    "Say a message in the client's chat, or run a /command, from the game view (no screen open).",
    { message: z.string().min(1) },
    async ({ message }: { message: string }) => factory.createResponse(JSON.stringify(await client.mccli(['chat', message]))),
    skip
  );

  factory.registerTool(
    "bedrock-client-join",
    "From the title screen: Play, then the LAN world the bridge shows (index 0 is the first). The bridge joins it to the server, offline or signed in with Microsoft. Needs the default 1280 x 720 window. Answers a screenshot; bedrock-client-state says when the game started.",
    { index: z.number().int().min(0).optional() },
    async ({ index = 0 }: { index?: number }) => {
      await client.mccli(['join-lan', '--index', String(index)], 120_000);
      return withShot(`Joined LAN world ${index}.`);
    },
    skip
  );

  factory.registerTool(
    "bedrock-client-logs",
    "The client's log, newest last.",
    { lines: z.number().int().min(1).max(500).optional() },
    async ({ lines = 50 }: { lines?: number }) => factory.createResponse(((await client.mccli(['logs', '--lines', String(lines)])).lines as string[] ?? []).join('\n') || '(empty)'),
    skip
  );

  factory.registerTool(
    "bedrock-client-quit",
    "Stop the real Bedrock client.",
    {},
    async () => json(await client.mccli(['quit'])),
    skip
  );

  factory.registerTool(
    "bedrock-bridge-status",
    "mc-cli's bridge: listening or not, the server it relays to, auth (offline or microsoft and the account), a sign-in code when it waits for one, and the clients it carries.",
    {},
    async () => json(await client.bridge('/status')),
    skip
  );

  factory.registerTool(
    "bedrock-client-state",
    "What the bridge sees of the real client's game: world, position, dimension, game mode, health, inventory (item names and counts), the last title, the tab list, nearby players and open forms. player picks a client (default: the newest online one).",
    { player: z.string().optional() },
    async ({ player }: { player?: string }) => json(await client.bridge(`/state${query({ player })}`)),
    skip
  );

  factory.registerTool(
    "bedrock-client-chat-log",
    "The chat, system and translated messages the real client received, from the bridge. since takes the last id seen.",
    { since: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional(), player: z.string().optional() },
    async ({ since, limit, player }: { since?: number; limit?: number; player?: string }) => {
      const data = await client.bridge(`/chat${query({ since, limit, player })}`);
      const lines = (data.chat as { id: number; type: string; source: string; message: string }[]) ?? [];
      return factory.createResponse(lines.length ? lines.map((l) => `${l.id} [${l.type}] ${l.source ? `${l.source}: ` : ''}${l.message}`).join('\n') : 'No messages yet.');
    },
    skip
  );

  factory.registerTool(
    "bedrock-client-forms",
    "The forms the server opened for the real client (Floodgate/Cumulus forms and Geyser's own forms; a Java chest menu is an inventory, not a form): a simple form (buttons), a modal (two buttons) or a custom form (inputs).",
    { player: z.string().optional() },
    async ({ player }: { player?: string }) => {
      const data = await client.bridge(`/forms${query({ player })}`);
      const forms = (data.forms as unknown[]) ?? [];
      return factory.createResponse(forms.length ? JSON.stringify(forms, null, 1) : 'No open forms.');
    },
    skip
  );

  factory.registerTool(
    "bedrock-client-form-respond",
    "Answer a form for the real client, through the bridge: a button's index, true or false for a modal, or a custom form's values; nothing closes it. The bridge asks the client to close the form too. Clicking it in a screenshot works as well.",
    {
      id: z.number().int(),
      response: z.union([z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))]).optional(),
      player: z.string().optional()
    },
    async ({ id, response, player }: { id: number; response?: unknown; player?: string }) => json(await client.bridge('/form', { id, response: response ?? null, player })),
    skip
  );
}
