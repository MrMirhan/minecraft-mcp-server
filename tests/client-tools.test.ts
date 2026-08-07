import test from 'ava';
import sinon from 'sinon';
import { registerClientTools } from '../src/tools/client-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type { McClient, McClientStatus, McCommandResult } from '../src/mc-client.js';

const TOOL_NAMES = [
  'client-status', 'client-capture', 'client-use-item', 'client-close-screen',
  'client-inventory', 'client-item', 'client-block', 'client-entity',
  'client-teleport', 'client-camera', 'client-gamemode', 'client-spectate',
  'client-connect', 'client-disconnect', 'client-execute'
];

function baseStatus(overrides: Partial<McClientStatus> = {}): McClientStatus {
  return {
    processState: 'not_started',
    pid: null,
    startedAt: null,
    exitCode: null,
    exitSignal: null,
    spawnError: null,
    socketReachable: false,
    lastLogLines: [],
    game: null,
    screen: null,
    ...overrides
  };
}

function setup(clientOverrides: Partial<McClient> = {}, connectionOverrides: Partial<BotConnection> = {}) {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }),
    ...connectionOverrides
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockClient = {
    request: sinon.stub().resolves({ ok: true, data: {} } as McCommandResult),
    getStatus: sinon.stub().resolves(baseStatus()),
    captureScreenshot: sinon.stub().resolves({ ok: true, buffer: Buffer.from('fake-png') }),
    ...clientOverrides
  } as unknown as McClient;
  registerClientTools(factory, mockClient);
  return { mockServer, mockClient, mockConnection };
}

function getExecutor(mockServer: McpServer, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === name);
  if (!call) {
    throw new Error(`tool ${name} was not registered`);
  }
  return { call, executor: call.args[3] };
}

test('registers all client-* tools', (t) => {
  const { mockServer } = setup();
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map((c) => c.args[0]);

  for (const name of TOOL_NAMES) {
    t.true(names.includes(name), `${name} must be registered`);
  }
});

test('client-* tools run even when the mineflayer bot is not connected (skipConnectionCheck)', async (t) => {
  const { mockServer, mockClient } = setup({}, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: false, message: 'Not connected to any Minecraft server.' })
  });

  for (const name of TOOL_NAMES) {
    const { executor } = getExecutor(mockServer, name);
    const args = name === 'client-teleport'
      ? { x: 0, y: 0, z: 0 }
      : name === 'client-camera'
        ? { yaw: 0, pitch: 0 }
        : name === 'client-gamemode'
          ? { mode: 'survival' }
          : name === 'client-connect'
            ? { address: 'h' }
            : name === 'client-execute'
              ? { command: 'say hi' }
              : {};

    const result = await executor(args);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    t.false(text.includes('Not connected to any Minecraft server'), `${name} must not run the bot connection check`);
  }

  t.true((mockClient.getStatus as sinon.SinonStub).called || (mockClient.request as sinon.SinonStub).called || (mockClient.captureScreenshot as sinon.SinonStub).called);
});

test('client-status never calls request, only getStatus', async (t) => {
  const { mockServer, mockClient } = setup({ getStatus: sinon.stub().resolves(baseStatus({ processState: 'running', pid: 99, socketReachable: true })) });
  const { executor } = getExecutor(mockServer, 'client-status');

  const result = await executor({});

  t.true((mockClient.getStatus as sinon.SinonStub).calledOnce);
  t.false((mockClient.request as sinon.SinonStub).called);
  t.falsy(result.isError);
  t.true(result.content[0].text.includes('running'));
  t.true(result.content[0].text.includes('99'));
});

test('client-status reports a launch failure with diagnostics', async (t) => {
  const { mockServer } = setup({
    getStatus: sinon.stub().resolves(baseStatus({
      processState: 'exited',
      exitCode: 1,
      spawnError: null,
      lastLogLines: ['Fatal error: could not initialize GLX']
    }))
  });
  const { executor } = getExecutor(mockServer, 'client-status');

  const result = await executor({});

  t.true(result.content[0].text.includes('exited'));
  t.true(result.content[0].text.includes('could not initialize GLX'));
});

test('client-capture returns a base64 PNG image on success', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-capture');

  const result = await executor({ clean: true });

  t.true((mockClient.captureScreenshot as sinon.SinonStub).calledWith(true));
  t.is(result.content[0].type, 'image');
  t.is(result.content[0].mimeType, 'image/png');
  t.is(Buffer.from(result.content[0].data, 'base64').toString(), 'fake-png');
});

test('client-capture defaults clean to false', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-capture');

  await executor({});

  t.true((mockClient.captureScreenshot as sinon.SinonStub).calledWith(false));
});

test('client-capture returns a text error when the client is unreachable', async (t) => {
  const { mockServer } = setup({
    captureScreenshot: sinon.stub().resolves({ ok: false, error: 'Could not reach the Minecraft client at 127.0.0.1:25580: connect ECONNREFUSED' })
  });
  const { executor } = getExecutor(mockServer, 'client-capture');

  const result = await executor({});

  t.true(result.isError);
  t.is(result.content[0].type, 'text');
  t.true(result.content[0].text.includes('ECONNREFUSED'));
});

test('client-use-item calls interact use and passes hand through', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-use-item');

  await executor({ hand: 'off' });

  t.true((mockClient.request as sinon.SinonStub).calledWith('interact', { action: 'use', hand: 'off' }));
});

test('client-use-item omits hand when not provided', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-use-item');

  await executor({});

  t.true((mockClient.request as sinon.SinonStub).calledWith('interact', { action: 'use' }));
});

test('client-close-screen calls window close_screen', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-close-screen');

  await executor({});

  t.true((mockClient.request as sinon.SinonStub).calledWith('window', { action: 'close_screen' }));
});

test('client-inventory forwards section and flags', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-inventory');

  await executor({ section: 'hotbar', includeEmpty: true, includeNbt: false });

  t.true((mockClient.request as sinon.SinonStub).calledWith('inventory', {
    action: 'list', section: 'hotbar', include_empty: true, include_nbt: false
  }));
});

test('client-item forwards action, hand, slot and includeNbt', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-item');

  await executor({ action: 'slot', slot: 5, includeNbt: true });

  t.true((mockClient.request as sinon.SinonStub).calledWith('item', { action: 'slot', slot: 5, include_nbt: true }));
});

test('client-block forwards action, coordinates and includeNbt', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-block');

  await executor({ action: 'at', x: 1, y: 2, z: 3, includeNbt: true });

  t.true((mockClient.request as sinon.SinonStub).calledWith('block', { action: 'at', x: 1, y: 2, z: 3, include_nbt: true }));
});

test('client-entity always sends action target', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-entity');

  await executor({ maxDistance: 8 });

  t.true((mockClient.request as sinon.SinonStub).calledWith('entity', { action: 'target', max_distance: 8 }));
});

test('client-teleport sends x, y, z', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-teleport');

  await executor({ x: 10, y: 64, z: -20 });

  t.true((mockClient.request as sinon.SinonStub).calledWith('teleport', { x: 10, y: 64, z: -20 }));
});

test('client-camera sends yaw and pitch', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-camera');

  await executor({ yaw: -45, pitch: 15 });

  t.true((mockClient.request as sinon.SinonStub).calledWith('camera', { yaw: -45, pitch: 15 }));
});

test('client-gamemode runs an execute command', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-gamemode');

  const result = await executor({ mode: 'creative' });

  t.true((mockClient.request as sinon.SinonStub).calledWith('execute', { command: 'gamemode creative' }));
  t.true(result.content[0].text.includes('creative'));
});

test('client-spectate spectates a player when one is given', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-spectate');

  const result = await executor({ player: 'LLMBot' });

  t.true((mockClient.request as sinon.SinonStub).calledWith('execute', { command: 'spectate LLMBot' }));
  t.true(result.content[0].text.includes('LLMBot'));
});

test('client-spectate leaves spectator mode with no player', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-spectate');

  const result = await executor({});

  t.true((mockClient.request as sinon.SinonStub).calledWith('execute', { command: 'spectate' }));
  t.true(result.content[0].text.toLowerCase().includes('left'));
});

test('client-connect forwards address, port and resourcepackPolicy', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-connect');

  await executor({ address: 'play.example.com', port: 25566, resourcepackPolicy: 'accept' });

  t.true((mockClient.request as sinon.SinonStub).calledWith('server', {
    action: 'connect', address: 'play.example.com', port: 25566, resourcepack_policy: 'accept'
  }));
});

test('client-disconnect calls server disconnect', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-disconnect');

  await executor({});

  t.true((mockClient.request as sinon.SinonStub).calledWith('server', { action: 'disconnect' }));
});

test('client-execute forwards the raw command', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-execute');

  await executor({ command: 'weather clear' });

  t.true((mockClient.request as sinon.SinonStub).calledWith('execute', { command: 'weather clear' }));
});

test('every client-* tool returns a text error, not a throw, when the client is unreachable', async (t) => {
  const unreachable: McCommandResult = { ok: false, error: 'Could not reach the Minecraft client at 127.0.0.1:25580: connect ECONNREFUSED' };
  const { mockServer } = setup({ request: sinon.stub().resolves(unreachable) });

  const toolsUsingRequest = TOOL_NAMES.filter((name) => name !== 'client-status' && name !== 'client-capture');

  for (const name of toolsUsingRequest) {
    const { executor } = getExecutor(mockServer, name);
    const args = name === 'client-teleport'
      ? { x: 0, y: 0, z: 0 }
      : name === 'client-camera'
        ? { yaw: 0, pitch: 0 }
        : name === 'client-gamemode'
          ? { mode: 'survival' }
          : name === 'client-connect'
            ? { address: 'h' }
            : name === 'client-execute'
              ? { command: 'say hi' }
              : {};

    const result = await executor(args);
    t.true(result.isError, `${name} must mark isError on failure`);
    t.true(result.content[0].text.includes('ECONNREFUSED'), `${name} must surface the underlying error`);
  }
});
