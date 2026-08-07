import test from 'ava';
import sinon from 'sinon';
import { registerControlTools } from '../src/tools/control-tools.js';
import { ActionManager } from '../src/action-manager.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';

function makeFactory(): { factory: ToolFactory; mockServer: McpServer } {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  return { factory, mockServer };
}

function getExecutor(mockServer: McpServer, name: string): (args: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === name);
  if (!call) {
    throw new Error(`tool ${name} was not registered`);
  }
  return call.args[3];
}

test('registerControlTools registers stop tool', (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { pathfinder: { stop: sinon.stub() } } as unknown as mineflayer.Bot;
  const actionManager = new ActionManager();

  registerControlTools(factory, () => mockBot, actionManager);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const stopCall = toolCalls.find((call) => call.args[0] === 'stop');
  t.truthy(stopCall);
  t.is(stopCall!.args[1], 'Stop whatever action the bot is currently performing');
});

test('registerControlTools registers get-current-action tool', (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { pathfinder: { stop: sinon.stub() } } as unknown as mineflayer.Bot;
  const actionManager = new ActionManager();

  registerControlTools(factory, () => mockBot, actionManager);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === 'get-current-action');
  t.truthy(call);
  t.is(call!.args[1], 'Get the action the bot is currently performing and how long it has been running');
});

test('get-current-action reports nothing running when idle', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { pathfinder: { stop: sinon.stub() } } as unknown as mineflayer.Bot;
  const actionManager = new ActionManager();

  registerControlTools(factory, () => mockBot, actionManager);
  const executor = getExecutor(mockServer, 'get-current-action');

  const result = await executor({});

  t.true(result.content[0].text.includes('No action is currently running'));
});

test.serial('get-current-action reports the label and elapsed time while an action runs', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const { factory, mockServer } = makeFactory();
  const mockBot = { pathfinder: { stop: sinon.stub() } } as unknown as mineflayer.Bot;
  const actionManager = new ActionManager();

  registerControlTools(factory, () => mockBot, actionManager);
  const executor = getExecutor(mockServer, 'get-current-action');

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runPromise = actionManager.run('move-to-position', undefined, async () => {
    await gate;
    return 'done';
  });

  await clock.tickAsync(750);
  const result = await executor({});

  t.true(result.content[0].text.includes('move-to-position'));
  t.true(result.content[0].text.includes('750ms'));

  release();
  await runPromise;
});

test('stop reports nothing was running and still halts the pathfinder defensively', async (t) => {
  const { factory, mockServer } = makeFactory();
  const stopStub = sinon.stub();
  const mockBot = { pathfinder: { stop: stopStub } } as unknown as mineflayer.Bot;
  const actionManager = new ActionManager();

  registerControlTools(factory, () => mockBot, actionManager);
  const executor = getExecutor(mockServer, 'stop');

  const result = await executor({});

  t.true(result.content[0].text.includes('Nothing was running'));
  t.true(stopStub.calledOnce);
});

test('stop interrupts the running action, halts the pathfinder and clears the current action', async (t) => {
  const { factory, mockServer } = makeFactory();
  const stopStub = sinon.stub();
  const mockBot = { pathfinder: { stop: stopStub } } as unknown as mineflayer.Bot;
  const actionManager = new ActionManager();

  registerControlTools(factory, () => mockBot, actionManager);
  const stopExecutor = getExecutor(mockServer, 'stop');
  const currentActionExecutor = getExecutor(mockServer, 'get-current-action');

  let pathfinderStoppedByAction = false;
  const runPromise = actionManager.run('move-to-position', undefined, async (ctx) => {
    return new Promise<string>((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        pathfinderStoppedByAction = true;
        resolve('stopped mid-flight');
      }, { once: true });
    });
  });

  await new Promise((resolve) => setImmediate(resolve));

  const stopResult = await stopExecutor({});
  await runPromise;

  t.true(pathfinderStoppedByAction);
  t.true(stopStub.calledOnce);
  t.true(stopResult.content[0].text.includes('Stopped "move-to-position"'));

  const currentActionResult = await currentActionExecutor({});
  t.true(currentActionResult.content[0].text.includes('No action is currently running'));
});
