import test from 'ava';
import sinon from 'sinon';
import { registerClientTools } from '../src/tools/client-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type { McClient, McCommandResult } from '../src/mc-client.js';

function setup(clientOverrides: Partial<McClient> = {}) {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockClient = {
    request: sinon.stub().resolves({ ok: true, data: { done: true } } as McCommandResult),
    captureScreenshot: sinon.stub().resolves({ ok: true, buffer: Buffer.from('png'), buffers: [Buffer.from('png')] }),
    setTarget: sinon.stub(),
    getTarget: sinon.stub().returns({ name: 'camera', host: '127.0.0.1', port: 25580 }),
    listInstances: sinon.stub().resolves([
      { name: 'camera', port: 25580, headless: true, control: 'on' },
      { name: 'minecraft-1', port: 25581, headless: false, control: 'ask', tokenFile: '/x' }
    ]),
    ...clientOverrides
  } as unknown as McClient;
  registerClientTools(factory, mockClient);
  return { mockServer, mockClient };
}

function run(mockServer: McpServer, name: string, args: Record<string, unknown>) {
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((c) => c.args[0] === name);
  if (!call) throw new Error(`${name} not registered`);
  return call.args[3](args);
}

test('client-gui reads the open screen by default', async (t) => {
  const { mockServer, mockClient } = setup();
  await run(mockServer, 'client-gui', {});
  t.true((mockClient.request as sinon.SinonStub).calledWith('gui', { action: 'read' }));
});

test('client-gui forwards a button click by its text', async (t) => {
  const { mockServer, mockClient } = setup();
  await run(mockServer, 'client-gui', { action: 'button', text: 'Buy' });
  t.true((mockClient.request as sinon.SinonStub).calledWith('gui', { action: 'button', text: 'Buy' }));
});

test('client-events reads from a cursor and can turn packet counts on', async (t) => {
  const { mockServer, mockClient } = setup();
  await run(mockServer, 'client-events', { since: 12, types: ['chat'] });
  t.true((mockClient.request as sinon.SinonStub).calledWith('events', { action: 'read', since: 12, types: ['chat'] }));
  await run(mockServer, 'client-events', { packets: 'summary' });
  t.true((mockClient.request as sinon.SinonStub).calledWith('events', { action: 'packets', mode: 'summary' }));
});

test('client-capture passes a transparent layer and returns every image', async (t) => {
  const { mockServer, mockClient } = setup({
    captureScreenshot: sinon.stub().resolves({ ok: true, buffer: Buffer.from('a'), buffers: [Buffer.from('a'), Buffer.from('b')] })
  });
  const result = await run(mockServer, 'client-capture', { layer: 'gui+tooltip', split: true, guiScale: 4 });
  t.true((mockClient.captureScreenshot as sinon.SinonStub).calledWith(false, { layer: 'gui+tooltip', split: true, gui_scale: 4 }));
  t.is(result.content.length, 2);
});

test('client-record starts a video with a camera move and waits long enough', async (t) => {
  const { mockServer, mockClient } = setup();
  const move = { action: 'shot', shot: 'push_in', target: { x: 0, y: 64, z: 0 }, durationMs: 3000 };
  await run(mockServer, 'client-record', { action: 'start', path: '/v/a.mp4', priority: 'smooth', camera: move, wait: true });
  const call = (mockClient.request as sinon.SinonStub).getCall(0);
  t.is(call.args[0], 'record');
  t.deepEqual(call.args[1], { action: 'start', path: '/v/a.mp4', priority: 'smooth', camera: move, wait: true });
  t.true(call.args[2].timeoutMs >= 600_000);
});

test('client-camera sends a move object, or the legacy yaw and pitch', async (t) => {
  const { mockServer, mockClient } = setup();
  await run(mockServer, 'client-camera', { move: { action: 'follow', entity: 'Steve' } });
  t.true((mockClient.request as sinon.SinonStub).calledWith('camera', { action: 'follow', entity: 'Steve' }));
  await run(mockServer, 'client-camera', { yaw: 10, pitch: 5 });
  t.true((mockClient.request as sinon.SinonStub).calledWith('camera', { yaw: 10, pitch: 5 }));
});

test('client-target own picks the windowed game and reports what the player allows', async (t) => {
  const { mockServer, mockClient } = setup({
    request: sinon.stub().resolves({ ok: true, data: { mode: 'ask', allow: ['observe', 'input'] } })
  });
  const result = await run(mockServer, 'client-target', { target: 'own' });
  t.true((mockClient.setTarget as sinon.SinonStub).calledWith({ name: 'own', host: '127.0.0.1', port: 25581, token: undefined }));
  t.true((mockClient.request as sinon.SinonStub).calledWith('control', {}));
  t.true(result.content[0].text.includes('ask'));
});

test('client-target own fails clearly when no game of the player is running', async (t) => {
  const { mockServer } = setup({ listInstances: sinon.stub().resolves([{ name: 'camera', port: 25580, headless: true }]) });
  const result = await run(mockServer, 'client-target', { target: 'own' });
  t.true(result.isError);
  t.true(result.content[0].text.includes('mc-cli'));
});
