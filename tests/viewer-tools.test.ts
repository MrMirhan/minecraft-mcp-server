import test from 'ava';
import sinon from 'sinon';
import { registerViewerTools } from '../src/tools/viewer-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type { WebViewer } from '../src/web-viewer.js';

function setup(webViewerOverrides: Partial<WebViewer>) {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockWebViewer = {
    start: sinon.stub().resolves('http://localhost:3007/'),
    stop: sinon.stub(),
    getUrl: sinon.stub().returns(null),
    getVersionWarning: sinon.stub().returns(null),
    ...webViewerOverrides
  } as unknown as WebViewer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }),
    getBot: sinon.stub().returns(null),
    getWebViewer: sinon.stub().returns(mockWebViewer)
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  registerViewerTools(factory, mockConnection);
  return { mockServer, mockConnection, mockWebViewer };
}

function getExecutor(mockServer: McpServer, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === name);
  return { call, executor: call!.args[3] };
}

test('registers start-viewer, stop-viewer and get-viewer-url tools', (t) => {
  const { mockServer } = setup({});

  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);

  t.true(names.includes('start-viewer'));
  t.true(names.includes('stop-viewer'));
  t.true(names.includes('get-viewer-url'));
});

test('start-viewer starts the web viewer with the current bot and returns the url', async (t) => {
  const { mockServer, mockConnection, mockWebViewer } = setup({});
  const { executor } = getExecutor(mockServer, 'start-viewer');

  const result = await executor({});

  t.true((mockWebViewer.start as sinon.SinonStub).calledOnce);
  t.true((mockWebViewer.start as sinon.SinonStub).calledWith((mockConnection.getBot as sinon.SinonStub)()));
  t.falsy(result.isError);
  t.true(result.content[0].text.includes('http://localhost:3007/'));
});

test('start-viewer appends a version warning when the web viewer reports one', async (t) => {
  const { mockServer } = setup({ getVersionWarning: sinon.stub().returns('rendering with 1.21.4 assets') });
  const { executor } = getExecutor(mockServer, 'start-viewer');

  const result = await executor({});

  t.true(result.content[0].text.includes('rendering with 1.21.4 assets'));
});

test('stop-viewer stops the web viewer', async (t) => {
  const { mockServer, mockWebViewer } = setup({});
  const { executor } = getExecutor(mockServer, 'stop-viewer');

  const result = await executor({});

  t.true((mockWebViewer.stop as sinon.SinonStub).calledOnce);
  t.falsy(result.isError);
  t.true(result.content[0].text.includes('stopped'));
});

test('get-viewer-url reports when the viewer is not running', async (t) => {
  const { mockServer } = setup({ getUrl: sinon.stub().returns(null) });
  const { executor } = getExecutor(mockServer, 'get-viewer-url');

  const result = await executor({});

  t.true(result.content[0].text.includes('not running'));
});

test('get-viewer-url returns the url when the viewer is running', async (t) => {
  const { mockServer } = setup({ getUrl: sinon.stub().returns('http://localhost:3007/') });
  const { executor } = getExecutor(mockServer, 'get-viewer-url');

  const result = await executor({});

  t.true(result.content[0].text.includes('http://localhost:3007/'));
});
