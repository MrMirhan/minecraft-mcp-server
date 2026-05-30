import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { BotConnection } from '../bot-connection.js';

export function registerConnectionTools(factory: ToolFactory, connection: BotConnection): void {
  factory.registerTool(
    "connect-to-server",
    "Connect the bot to a Minecraft server, switching from any current connection",
    {
      host: z.string().describe("Server host or IP address"),
      port: z.coerce.number().optional().describe("Server port (default: 25565)"),
      username: z.string().optional().describe("Bot username (default: LLMBot)"),
      version: z.string().optional().describe("Minecraft version to use (default: auto-detect)")
    },
    async ({ host, port = 25565, username = 'LLMBot', version }: { host: string; port?: number; username?: string; version?: string }) => {
      const info = await connection.connectTo({ host, port, username, ...(version ? { version } : {}) });
      return factory.createResponse(
        `Connected to ${info.host}:${info.port} as ${info.username} (version ${info.version}). ` +
        `Spawned at (${info.position.x}, ${info.position.y}, ${info.position.z}).`
      );
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "disconnect",
    "Disconnect the bot from the current Minecraft server",
    {},
    async () => {
      connection.disconnect();
      return factory.createResponse("Disconnected from the Minecraft server.");
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "get-connection-status",
    "Get the current connection status of the bot",
    {},
    async () => {
      const info = connection.getConnectionInfo();
      if (!info.host) {
        return factory.createResponse("Not connected to any Minecraft server. Use the connect-to-server tool to join one.");
      }
      return factory.createResponse(
        `State: ${info.state}\n` +
        `Connected: ${info.connected}\n` +
        `Server: ${info.host}:${info.port}\n` +
        `Username: ${info.username}\n` +
        `Version: ${info.version ?? 'unknown'}`
      );
    },
    { skipConnectionCheck: true }
  );
}
