import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { BEDROCK_VERSION, BedrockBot } from '../bedrock-bot.js';
import { BedrockAuth, describeLogin } from '../bedrock-auth.js';

// The Bedrock bot's tools. They do not need the Java bot, so they skip its connection check.

export function registerBedrockTools(factory: ToolFactory, bot: BedrockBot, auth?: BedrockAuth): void {
  const skip = { skipConnectionCheck: true };

  factory.registerTool(
    "bedrock-connect",
    `Join a Bedrock server (or a Java server through Geyser) with a Bedrock protocol bot. auth "offline" (default) joins as username, and the server must allow offline players; auth "microsoft" joins as the Microsoft account signed in with bedrock-login (its gamertag), for online servers. version defaults to ${BEDROCK_VERSION}. Leaves the server it was on first.`,
    {
      host: z.string().describe("Server host"),
      port: z.number().int().optional().describe("Server port (default: 19132)"),
      username: z.string().optional().describe("The bot's name offline (default: LLMBedrock)"),
      auth: z.enum(['offline', 'microsoft']).optional().describe("offline (default) or microsoft"),
      account: z.string().optional().describe("With auth microsoft: which signed-in account (default: default)"),
      version: z.string().optional().describe(`Bedrock version, like 1.26.60 (default: ${BEDROCK_VERSION})`),
      timeoutMs: z.number().int().optional().describe("How long to wait for the bot to spawn (default: 30000)")
    },
    async ({ host, port = 19132, username = 'LLMBedrock', auth: mode, account, version, timeoutMs }) => {
      const state = await bot.connect({ host, port, username, version, timeoutMs, auth: mode, account });
      return factory.createResponse(`Joined ${state.server} as ${state.username} (Bedrock ${state.version}, ${state.auth}).\n${JSON.stringify(state, null, 1)}`);
    },
    skip
  );

  factory.registerTool(
    "bedrock-disconnect",
    "Leave the Bedrock server.",
    {},
    async () => {
      bot.disconnect();
      return factory.createResponse('The Bedrock bot left the server.');
    },
    skip
  );

  factory.registerTool(
    "bedrock-status",
    "The Bedrock bot's state: connected or not (and why it left), the server, position, dimension, game mode, health, the players in the tab list, and how many forms are open.",
    {},
    async () => factory.createResponse(JSON.stringify(bot.status(), null, 1)),
    skip
  );

  factory.registerTool(
    "bedrock-send-chat",
    "Send a chat message as the Bedrock bot.",
    { message: z.string().describe("The message") },
    async ({ message }) => {
      bot.sendChat(message);
      return factory.createResponse(`Sent: ${message}`);
    },
    skip
  );

  factory.registerTool(
    "bedrock-read-chat",
    "The chat, system and translated messages the Bedrock bot received, oldest first.",
    { count: z.number().int().optional().describe("How many of the newest (default: 20, max: 200)") },
    async ({ count = 20 }) => {
      const lines = bot.recentChat(Math.min(Math.max(count, 1), 200));
      if (lines.length === 0) return factory.createResponse('No messages yet.');
      return factory.createResponse(lines.map((l) => `${new Date(l.at).toISOString()} [${l.type}] ${l.source ? `${l.source}: ` : ''}${l.message}`).join('\n'));
    },
    skip
  );

  factory.registerTool(
    "bedrock-command",
    "Run a command as the Bedrock bot (with or without the slash), and give the server's answer when it sends one. The bot needs the permission for it; some commands, like /say, answer nothing.",
    { command: z.string().describe("The command, like /list") },
    async ({ command }) => {
      const out = await bot.command(command);
      return factory.createResponse(out === null ? `Sent ${command}; the server sent no answer within 2 s.` : out.length ? out.join('\n') : `Sent ${command}; the answer was empty.`);
    },
    skip
  );

  factory.registerTool(
    "bedrock-forms",
    "The forms the server opened for the Bedrock bot and it has not answered: a simple form (buttons), a modal (two buttons) or a custom form (inputs, toggles, sliders, dropdowns). Geyser shows Java menus to Bedrock players as these forms.",
    {},
    async () => {
      const forms = bot.pendingForms();
      return factory.createResponse(forms.length ? JSON.stringify(forms, null, 1) : 'No open forms.');
    },
    skip
  );

  factory.registerTool(
    "bedrock-form-respond",
    "Answer an open form: response is the button's index (a number) for a simple form, true or false for a modal, or the list of values for a custom form. Leave response out to close the form.",
    {
      formId: z.number().int().describe("The form's id, from bedrock-forms"),
      response: z.union([z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))]).optional().describe("The answer; none closes the form")
    },
    async ({ formId, response }) => {
      bot.answerForm(formId, response);
      return factory.createResponse(response === undefined ? `Closed form ${formId}.` : `Answered form ${formId} with ${JSON.stringify(response)}.`);
    },
    skip
  );

  if (!auth) return;

  factory.registerTool(
    "bedrock-login",
    "Sign a Microsoft account in for Bedrock (the bot's auth \"microsoft\", and mc-cli's bridge when it shares the token folder). Answers a code and a link for the person: they open microsoft.com/link, enter the code and sign in with an account that owns Bedrock. The sign-in then finishes by itself; follow it with bedrock-login-status. Once is enough: the tokens renew themselves.",
    { account: z.string().optional().describe("A name for the account, to keep several (default: default)") },
    async ({ account = 'default' }) => factory.createResponse(describeLogin(await auth.login(account))),
    skip
  );

  factory.registerTool(
    "bedrock-login-status",
    "Whether a Microsoft account is signed in for Bedrock, or still waits for the person to enter its code. Never starts a sign-in.",
    { account: z.string().optional().describe("default: default") },
    async ({ account = 'default' }) => factory.createResponse(describeLogin(await auth.status(account))),
    skip
  );

  factory.registerTool(
    "bedrock-logout",
    "Remove a Microsoft account's Bedrock tokens from this server.",
    { account: z.string().optional().describe("default: default") },
    async ({ account = 'default' }) => factory.createResponse(`Removed ${auth.logout(account)} token file(s) of "${account}".`),
    skip
  );
}
