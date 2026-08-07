import test from 'ava';
import sinon from 'sinon';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../src/server-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import { MessageStore } from '../src/message-store.js';

function makeConnection(): BotConnection {
  return new BotConnection(
    { host: 'localhost', port: 25565, username: 'LLMBot' },
    { onLog: () => undefined, onChatMessage: () => undefined }
  );
}

test.serial('createMcpServer registers all 44 tools', (t) => {
  const toolSpy = sinon.spy(McpServer.prototype, 'tool');
  try {
    createMcpServer(makeConnection(), new MessageStore());
    t.is(toolSpy.callCount, 44);
  } finally {
    toolSpy.restore();
  }
});

test.serial('createMcpServer wires the ui and render tools', (t) => {
  const toolSpy = sinon.spy(McpServer.prototype, 'tool');
  try {
    createMcpServer(makeConnection(), new MessageStore());
    const names = toolSpy.getCalls().map((call) => call.args[0] as string);
    for (const name of ['read-scoreboard', 'read-window', 'read-tablist', 'read-bossbar', 'read-title', 'read-teams', 'get-resource-pack', 'take-screenshot', 'render-window']) {
      t.true(names.includes(name), `${name} must be registered`);
    }
  } finally {
    toolSpy.restore();
  }
});

test.serial('createMcpServer wires the three connection tools', (t) => {
  const toolSpy = sinon.spy(McpServer.prototype, 'tool');
  try {
    createMcpServer(makeConnection(), new MessageStore());
    const names = toolSpy.getCalls().map((call) => call.args[0] as string);
    t.true(names.includes('connect-to-server'));
    t.true(names.includes('disconnect'));
    t.true(names.includes('get-connection-status'));
  } finally {
    toolSpy.restore();
  }
});

test.serial('createMcpServer returns an McpServer instance', (t) => {
  const server = createMcpServer(makeConnection(), new MessageStore());
  t.true(server instanceof McpServer);
});
