#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server as HttpServer } from "node:http";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { MessageStore } from './message-store.js';
import { createMcpServer } from './server-factory.js';
import { startHttpTransport } from './http-transport.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message)
    }
  );

  if (config.explicitHost) {
    connection.connect();
  }

  let httpServer: HttpServer | undefined;

  const shutdown = (): void => {
    connection.cleanup();
    if (httpServer) {
      httpServer.close();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (config.transport === 'http') {
    httpServer = startHttpTransport({
      port: config.httpPort,
      authToken: config.authToken,
      createServer: () => createMcpServer(connection, messageStore),
      log
    });
    return;
  }

  process.stdin.on('end', () => {
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const server = createMcpServer(connection, messageStore);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
