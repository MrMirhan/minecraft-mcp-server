import test from 'ava';
import sinon from 'sinon';
import { registerConnectionTools } from '../src/tools/connection-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

function setup(connectionOverrides: Partial<BotConnection>) {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }),
    ...connectionOverrides
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  registerConnectionTools(factory, mockConnection);
  return { mockServer, mockConnection };
}

function getExecutor(mockServer: McpServer, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === name);
  return { call, executor: call!.args[3] };
}

test('registers connect-to-server, disconnect and get-connection-status tools', (t) => {
  const { mockServer } = setup({});

  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);

  t.true(names.includes('connect-to-server'));
  t.true(names.includes('disconnect'));
  t.true(names.includes('get-connection-status'));
});

test('connect-to-server calls connectTo and returns connection details', async (t) => {
  const connectTo = sinon.stub().resolves({
    host: 'play.example.com',
    port: 25565,
    username: 'LLMBot',
    version: '1.21.11',
    position: { x: 10, y: 64, z: -5 }
  });
  const { mockServer } = setup({ connectTo } as unknown as Partial<BotConnection>);
  const { executor } = getExecutor(mockServer, 'connect-to-server');

  const result = await executor({ host: 'play.example.com' });

  t.true(connectTo.calledOnce);
  t.is(connectTo.firstCall.args[0].host, 'play.example.com');
  t.falsy(result.isError);
  t.true(result.content[0].text.includes('play.example.com:25565'));
  t.true(result.content[0].text.includes('LLMBot'));
  t.true(result.content[0].text.includes('1.21.11'));
  t.true(result.content[0].text.includes('10, 64, -5'));
});

test('connect-to-server passes optional port, username and version through', async (t) => {
  const connectTo = sinon.stub().resolves({
    host: 'h', port: 30000, username: 'Custom', version: '1.20', position: { x: 0, y: 0, z: 0 }
  });
  const { mockServer } = setup({ connectTo } as unknown as Partial<BotConnection>);
  const { executor } = getExecutor(mockServer, 'connect-to-server');

  await executor({ host: 'h', port: 30000, username: 'Custom', version: '1.20' });

  const passed = connectTo.firstCall.args[0];
  t.is(passed.port, 30000);
  t.is(passed.username, 'Custom');
  t.is(passed.version, '1.20');
});

test('connect-to-server returns isError when connectTo rejects', async (t) => {
  const connectTo = sinon.stub().rejects(new Error('Timed out connecting to h:1 after 30000ms'));
  const { mockServer } = setup({ connectTo } as unknown as Partial<BotConnection>);
  const { executor } = getExecutor(mockServer, 'connect-to-server');

  const result = await executor({ host: 'h', port: 1 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Timed out'));
});

test('disconnect calls connection.disconnect', async (t) => {
  const disconnect = sinon.stub();
  const { mockServer } = setup({ disconnect } as unknown as Partial<BotConnection>);
  const { executor } = getExecutor(mockServer, 'disconnect');

  const result = await executor({});

  t.true(disconnect.calledOnce);
  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Disconnected'));
});

test('get-connection-status formats getConnectionInfo when connected', async (t) => {
  const getConnectionInfo = sinon.stub().returns({
    connected: true,
    state: 'connected',
    host: 'play.example.com',
    port: 25565,
    username: 'LLMBot',
    version: '1.21.11'
  });
  const { mockServer } = setup({ getConnectionInfo } as unknown as Partial<BotConnection>);
  const { executor } = getExecutor(mockServer, 'get-connection-status');

  const result = await executor({});

  t.true(getConnectionInfo.calledOnce);
  t.true(result.content[0].text.includes('connected'));
  t.true(result.content[0].text.includes('play.example.com:25565'));
  t.true(result.content[0].text.includes('LLMBot'));
  t.true(result.content[0].text.includes('1.21.11'));
});

test('get-connection-status reports not connected when idle', async (t) => {
  const getConnectionInfo = sinon.stub().returns({
    connected: false,
    state: 'disconnected',
    host: null,
    port: null,
    username: null,
    version: null
  });
  const { mockServer } = setup({ getConnectionInfo } as unknown as Partial<BotConnection>);
  const { executor } = getExecutor(mockServer, 'get-connection-status');

  const result = await executor({});

  t.true(result.content[0].text.includes('Not connected'));
});
