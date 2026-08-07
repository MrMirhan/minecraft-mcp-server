import test from 'ava';
import sinon from 'sinon';
import { registerStatusTools } from '../src/tools/status-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

function setup(bot: Partial<mineflayer.Bot>) {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const getBot = () => bot as mineflayer.Bot;

  registerStatusTools(factory, getBot);

  return { mockServer, factory };
}

function getExecutor(mockServer: McpServer, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === name);
  return { call, executor: call!.args[3] };
}

function fullMockBot(): mineflayer.Bot {
  return {
    username: 'LLMBot',
    entity: { position: new Vec3(100, 64, -20) },
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 18,
    food: 16,
    oxygenLevel: 20,
    time: { timeOfDay: 6000, isDay: true },
    isRaining: false,
    thunderState: 0,
    heldItem: { name: 'diamond_pickaxe', count: 1 },
    blockAt: sinon.stub().returns({ biome: { name: 'plains', displayName: 'Plains' } }),
    inventory: {
      items: sinon.stub().returns([
        { name: 'oak_log', count: 12, slot: 0 },
        { name: 'oak_log', count: 4, slot: 1 },
        { name: 'dirt', count: 64, slot: 2 },
        { name: 'cobblestone', count: 32, slot: 3 }
      ]),
      emptySlotCount: sinon.stub().returns(30)
    },
    players: {
      LLMBot: { username: 'LLMBot', entity: { position: new Vec3(100, 64, -20) } },
      Steve: { username: 'Steve', entity: { position: new Vec3(110, 64, -20) } },
      Alex: { username: 'Alex', entity: undefined }
    }
  } as unknown as mineflayer.Bot;
}

test('registerStatusTools registers get-status tool', (t) => {
  const { mockServer } = setup({});
  const { call } = getExecutor(mockServer, 'get-status');

  t.truthy(call);
  t.is(
    call!.args[1],
    "Get a single compact summary of everything needed to orient: position, vitals, environment, held item, inventory and nearby players"
  );
});

test('get-status returns a single compact block covering every required field', async (t) => {
  const bot = fullMockBot();
  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'get-status');

  const result = await executor({});
  const text = result.content[0].text as string;
  t.log(text);

  t.true(text.includes('Position: (100, 64, -20)'));
  t.true(text.includes('Dimension: overworld'));
  t.true(text.includes('Biome: Plains'));
  t.true(text.includes('Health: 18/20'));
  t.true(text.includes('Food: 16/20'));
  t.true(text.includes('Oxygen: 20/20'));
  t.true(text.includes('Gamemode: survival'));
  t.true(text.includes('Time: 6000 (day)'));
  t.true(text.includes('Weather: clear'));
  t.true(text.includes('Held item: diamond_pickaxe x1'));
  t.true(text.includes('dirt x64'));
  t.true(text.includes('cobblestone x32'));
  t.true(text.includes('oak_log x16'));
  t.true(text.includes('30 free slots'));
  t.true(text.includes('Steve (10.0m)'));
  t.false(text.includes('Alex'));
  t.false(text.includes('LLMBot ('));

  const lineCount = text.split('\n').length;
  t.is(lineCount, 6);
});

test('get-status reports empty inventory, no held item and no nearby players', async (t) => {
  const bot = {
    username: 'LLMBot',
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'overworld', gameMode: 'creative' },
    health: 20,
    food: 20,
    oxygenLevel: 20,
    time: { timeOfDay: 0, isDay: true },
    isRaining: false,
    thunderState: 0,
    heldItem: null,
    blockAt: sinon.stub().returns(null),
    inventory: {
      items: sinon.stub().returns([]),
      emptySlotCount: sinon.stub().returns(36)
    },
    players: {
      LLMBot: { username: 'LLMBot', entity: { position: new Vec3(0, 64, 0) } }
    }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'get-status');

  const result = await executor({});
  const text = result.content[0].text as string;

  t.true(text.includes('Biome: unknown'));
  t.true(text.includes('Held item: none'));
  t.true(text.includes('Inventory: empty'));
  t.true(text.includes('Nearby players: none'));
});

test('get-status reports rain and thunder weather', async (t) => {
  const bot = fullMockBot();
  (bot as unknown as { isRaining: boolean }).isRaining = true;
  (bot as unknown as { thunderState: number }).thunderState = 0;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'get-status');

  const rainResult = await executor({});
  t.true((rainResult.content[0].text as string).includes('Weather: rain'));

  (bot as unknown as { thunderState: number }).thunderState = 1;
  const thunderResult = await executor({});
  t.true((thunderResult.content[0].text as string).includes('Weather: thunder'));
});

test('get-status caps the nearby players list and reports the overflow', async (t) => {
  const bot = fullMockBot();
  const players: Record<string, unknown> = {
    LLMBot: { username: 'LLMBot', entity: { position: new Vec3(100, 64, -20) } }
  };
  for (let i = 0; i < 7; i++) {
    players[`Player${i}`] = { username: `Player${i}`, entity: { position: new Vec3(100 + i + 1, 64, -20) } };
  }
  (bot as unknown as { players: Record<string, unknown> }).players = players;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'get-status');

  const result = await executor({});
  const text = result.content[0].text as string;

  t.true(text.includes('+2 more'));
});
