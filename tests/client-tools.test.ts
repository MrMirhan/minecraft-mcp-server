import test from 'ava';
import sinon from 'sinon';
import { registerClientTools } from '../src/tools/client-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type { McClient, McClientStatus, McCommandResult } from '../src/mc-client.js';

const TOOL_NAMES = [
  'client-status', 'client-set-username', 'client-capture', 'client-use-item', 'client-close-screen',
  'client-inventory', 'client-item', 'client-block', 'client-entity',
  'client-teleport', 'client-camera', 'client-gamemode', 'client-spectate',
  'client-connect', 'client-disconnect', 'client-execute',
  'client-slots', 'client-hover', 'client-click', 'client-slot-click', 'client-key', 'client-type', 'client-interact'
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
    username: 'LLMBotClient',
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
    setUsername: sinon.stub().resolves({ ok: true, data: { username: 'NewName', uuid: 'fake-uuid', restarted: false } } as McCommandResult),
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
              : name === 'client-set-username'
                ? { username: 'NewName' }
                : name === 'client-hover'
                  ? { slot: 0, capture: false }
                  : name === 'client-slot-click'
                    ? { slot: 0 }
                    : name === 'client-key'
                      ? { key: 'tab' }
                      : name === 'client-type'
                        ? { text: 'hi' }
                      : name === 'client-interact'
                        ? { target: 'block' }
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

test('client-status reports the current username', async (t) => {
  const { mockServer } = setup({ getStatus: sinon.stub().resolves(baseStatus({ username: 'CustomName' })) });
  const { executor } = getExecutor(mockServer, 'client-status');

  const result = await executor({});

  t.true(result.content[0].text.includes('CustomName'));
});

test('client-set-username forwards the username to McClient.setUsername', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-set-username');

  await executor({ username: 'NewName' });

  t.true((mockClient.setUsername as sinon.SinonStub).calledWith('NewName'));
});

test('client-set-username reports a restart when the client was running', async (t) => {
  const { mockServer } = setup({
    setUsername: sinon.stub().resolves({ ok: true, data: { username: 'NewName', uuid: 'fake-uuid', restarted: true } } as McCommandResult)
  });
  const { executor } = getExecutor(mockServer, 'client-set-username');

  const result = await executor({ username: 'NewName' });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('NewName'));
  t.true(result.content[0].text.includes('restarted'));
});

test('client-set-username reports the value is recorded for next launch when the client was not running', async (t) => {
  const { mockServer } = setup({
    setUsername: sinon.stub().resolves({ ok: true, data: { username: 'NewName', uuid: 'fake-uuid', restarted: false } } as McCommandResult)
  });
  const { executor } = getExecutor(mockServer, 'client-set-username');

  const result = await executor({ username: 'NewName' });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('next launch'));
});

test('client-set-username returns a text error when McClient rejects the username', async (t) => {
  const { mockServer } = setup({
    setUsername: sinon.stub().resolves({ ok: false, error: '"a b" is not a valid Minecraft username (3-16 letters, digits and underscores).' } as McCommandResult)
  });
  const { executor } = getExecutor(mockServer, 'client-set-username');

  const result = await executor({ username: 'a b' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('not a valid Minecraft username'));
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

test('client-teleport runs the server /tp command', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-teleport');

  await executor({ x: 10, y: 64, z: -20 });

  t.true((mockClient.request as sinon.SinonStub).calledWith('execute', { command: 'tp 10 64 -20' }));
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

  const toolsUsingRequest = TOOL_NAMES.filter((name) => name !== 'client-status' && name !== 'client-capture' && name !== 'client-set-username');

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
              : name === 'client-set-username'
                ? { username: 'NewName' }
                : name === 'client-hover'
                  ? { slot: 0, capture: false }
                  : name === 'client-slot-click'
                    ? { slot: 0 }
                    : name === 'client-key'
                      ? { key: 'tab' }
                      : name === 'client-type'
                        ? { text: 'hi' }
                      : name === 'client-interact'
                        ? { target: 'block' }
                        : {};

    const result = await executor(args);
    t.true(result.isError, `${name} must mark isError on failure`);
    t.true(result.content[0].text.includes('ECONNREFUSED'), `${name} must surface the underlying error`);
  }
});

test('client-slots hides empty slots unless asked', async (t) => {
  const slots = [{ index: 0, item: { empty: false, id: 'minecraft:stone' } }, { index: 1, item: { empty: true } }];
  const { mockServer, mockClient } = setup({
    request: sinon.stub().resolves({ ok: true, data: { title: 'Menu', slots } } as McCommandResult)
  });
  const { executor } = getExecutor(mockServer, 'client-slots');

  const filtered = JSON.parse((await executor({})).content[0].text);
  const all = JSON.parse((await executor({ includeEmpty: true })).content[0].text);

  t.true((mockClient.request as sinon.SinonStub).calledWith('input', { action: 'slots' }));
  t.deepEqual(filtered.slots.map((slot: { index: number }) => slot.index), [0]);
  t.is(all.slots.length, 2);
});

test('client-hover moves to the slot and returns text plus a capture', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-hover');

  const result = await executor({ slot: 13, settleMs: 0 });

  t.true((mockClient.request as sinon.SinonStub).calledWith('input', { action: 'mouse_move', slot: 13 }));
  t.true((mockClient.captureScreenshot as sinon.SinonStub).calledOnce);
  t.is(result.content[0].type, 'text');
  t.is(result.content[1].type, 'image');
});

test('client-hover needs a slot or both coordinates', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-hover');

  const result = await executor({ x: 10 });

  t.true(result.isError);
  t.false((mockClient.request as sinon.SinonStub).called);
});

test('client-click sends the button index and the shift modifier', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-click');

  await executor({ slot: 5, button: 'right', shift: true });

  t.true((mockClient.request as sinon.SinonStub).calledWith('input', {
    action: 'mouse_click', slot: 5, button: 1, modifiers: 1, mode: 'click'
  }));
  t.false((mockClient.captureScreenshot as sinon.SinonStub).called);
});

test('client-slot-click sends slot, button and type', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-slot-click');

  await executor({ slot: 3, type: 'quick_move' });

  t.true((mockClient.request as sinon.SinonStub).calledWith('input', { action: 'slot_click', slot: 3, button: 0, type: 'quick_move' }));
});

test('client-key hold presses, captures, then releases in that order', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-key');

  const result = await executor({ key: 'tab', mode: 'hold', holdMs: 0 });

  const request = mockClient.request as sinon.SinonStub;
  const capture = mockClient.captureScreenshot as sinon.SinonStub;
  t.true(request.firstCall.calledWith('input', { action: 'key', key: 'tab', mode: 'press' }));
  t.true(request.secondCall.calledWith('input', { action: 'key', key: 'tab', mode: 'release' }));
  t.true(capture.firstCall.calledAfter(request.firstCall) && capture.firstCall.calledBefore(request.secondCall));
  t.is(result.content[1].type, 'image');
});

test('client-key hold releases the key even when the capture fails', async (t) => {
  const { mockServer, mockClient } = setup({
    captureScreenshot: sinon.stub().resolves({ ok: false, error: 'no screen' })
  });
  const { executor } = getExecutor(mockServer, 'client-key');

  const result = await executor({ key: 'tab', mode: 'hold', holdMs: 0 });

  t.true(result.isError);
  t.true((mockClient.request as sinon.SinonStub).calledWith('input', { action: 'key', key: 'tab', mode: 'release' }));
});

test('client-key sends numeric key codes as numbers', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-key');

  await executor({ key: '258' });

  t.true((mockClient.request as sinon.SinonStub).calledWith('input', { action: 'key', key: 258, mode: 'tap' }));
});

test('client-type sends the text as one type action and presses nothing without enter', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-type');

  await executor({ text: 'wheat' });

  const request = mockClient.request as sinon.SinonStub;
  t.true(request.calledOnceWith('input', { action: 'type', text: 'wheat' }));
  t.false((mockClient.captureScreenshot as sinon.SinonStub).called);
});

test('client-type with enter types first, then taps enter', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-type');

  const result = await executor({ text: '/spawn', enter: true, capture: true });

  const request = mockClient.request as sinon.SinonStub;
  t.true(request.firstCall.calledWith('input', { action: 'type', text: '/spawn' }));
  t.true(request.secondCall.calledWith('input', { action: 'key', key: 'enter', mode: 'tap' }));
  t.is(result.content[1].type, 'image');
});

test('client-type does not press enter when typing fails', async (t) => {
  const { mockServer, mockClient } = setup({
    request: sinon.stub().resolves({ ok: false, error: 'No screen is open to type into' } as McCommandResult)
  });
  const { executor } = getExecutor(mockServer, 'client-type');

  const result = await executor({ text: 'hi', enter: true });

  t.true(result.isError);
  t.true((mockClient.request as sinon.SinonStub).calledOnce);
});

test('client-interact maps block and entity targets to interact actions', async (t) => {
  const { mockServer, mockClient } = setup();
  const { executor } = getExecutor(mockServer, 'client-interact');

  await executor({ target: 'block', x: 1, y: 64, z: -3, face: 'north' });
  await executor({ target: 'entity', entityId: 42 });

  const request = mockClient.request as sinon.SinonStub;
  t.true(request.calledWith('interact', { action: 'use_on_block', x: 1, y: 64, z: -3, face: 'north' }));
  t.true(request.calledWith('interact', { action: 'use_on_entity', entity_id: 42 }));
});
