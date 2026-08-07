import test from 'ava';
import sinon from 'sinon';
import minecraftData from 'minecraft-data';
import { registerCompositeTools } from '../src/tools/composite-tools.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { ActionManager } from '../src/action-manager.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

function setup(bot: Partial<mineflayer.Bot>, actionManager: ActionManager = new ActionManager()) {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const getBot = () => bot as mineflayer.Bot;

  registerCompositeTools(factory, getBot, actionManager);

  return { mockServer, factory, actionManager, getBot };
}

function getExecutor(mockServer: McpServer, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === name);
  return { call, executor: call!.args[3] };
}

test('registerCompositeTools registers collect-blocks, goto-player, follow-player and scan-area', (t) => {
  const { mockServer } = setup({});
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map((c) => c.args[0]);

  t.true(names.includes('collect-blocks'));
  t.true(names.includes('goto-player'));
  t.true(names.includes('follow-player'));
  t.true(names.includes('scan-area'));
});

// --- collect-blocks ---

test('collect-blocks collects the requested count and stops the pathfinder afterwards', async (t) => {
  const mcData = minecraftData('1.21');
  const oakLogId = mcData.blocksByName.oak_log.id;

  const pos1 = new Vec3(10, 64, 0);
  const pos2 = new Vec3(11, 64, 0);
  const findBlocksStub = sinon.stub();
  findBlocksStub.onCall(0).returns([pos1]);
  findBlocksStub.onCall(1).returns([pos2]);
  const gotoStub = sinon.stub().resolves();
  const stopStub = sinon.stub();
  const digStub = sinon.stub().resolves();

  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: findBlocksStub,
    blockAt: sinon.stub().returns({ name: 'oak_log' }),
    pathfinder: { goto: gotoStub, stop: stopStub },
    dig: digStub
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'collect-blocks');

  const result = await executor({ blockType: 'oak_log', count: 2 });

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Collected 2 of 2 oak_log');
  t.is(findBlocksStub.callCount, 2);
  t.is(findBlocksStub.firstCall.args[0].matching, oakLogId);
  t.is(gotoStub.callCount, 2);
  t.is(digStub.callCount, 2);
  t.true(stopStub.calledOnce);
});

test('collect-blocks reports unknown block type without touching the pathfinder', async (t) => {
  const stopStub = sinon.stub();
  const bot = {
    version: '1.21',
    pathfinder: { goto: sinon.stub(), stop: stopStub }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'collect-blocks');

  const result = await executor({ blockType: 'not_a_real_block', count: 1 });

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Unknown block type: not_a_real_block');
  t.true(stopStub.notCalled);
});

test('collect-blocks reports partial progress when no more blocks are found', async (t) => {
  const stopStub = sinon.stub();
  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: sinon.stub().returns([]),
    pathfinder: { goto: sinon.stub(), stop: stopStub }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'collect-blocks');

  const result = await executor({ blockType: 'oak_log', count: 5, maxDistance: 20 });

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Collected 0 of 5 oak_log: no more found within 20 blocks');
  t.true(stopStub.calledOnce);
});

test.serial('collect-blocks times out while moving, reports partial progress, and stops the pathfinder', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const stopStub = sinon.stub();
  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: sinon.stub().returns([new Vec3(10, 64, 0)]),
    pathfinder: { goto: sinon.stub().returns(new Promise(() => {})), stop: stopStub }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'collect-blocks');

  const resultPromise = executor({ blockType: 'oak_log', count: 3, timeoutMs: 1000 });
  await clock.tickAsync(1000);
  const result = await resultPromise;

  t.true(result.isError);
  t.true(result.content[0].text.includes('Timed out: collected 0 of 3 oak_log while moving'));
  t.true(stopStub.calledOnce);
});

test('collect-blocks surfaces a real digging failure with partial progress', async (t) => {
  const stopStub = sinon.stub();
  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: sinon.stub().returns([new Vec3(5, 64, 5)]),
    blockAt: sinon.stub().returns({ name: 'oak_log' }),
    pathfinder: { goto: sinon.stub().resolves(), stop: stopStub },
    dig: sinon.stub().rejects(new Error('block disappeared')),
    stopDigging: sinon.stub()
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'collect-blocks');

  const result = await executor({ blockType: 'oak_log', count: 1 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Collected 0 of 1 oak_log'));
  t.true(result.content[0].text.includes('block disappeared'));
  t.true(stopStub.calledOnce);
});

test('move-to-position interrupts a running collect-blocks, obeying the one-action-at-a-time invariant', async (t) => {
  const findBlocksStub = sinon.stub().returns([new Vec3(10, 64, 0)]);
  const stopStub = sinon.stub();
  let releaseFirstGoto: (() => void) | null = null;
  const gotoStub = sinon.stub();
  gotoStub.onCall(0).returns(new Promise((_resolve, reject) => {
    releaseFirstGoto = () => reject(new Error('Path was stopped before it could be completed'));
  }));
  gotoStub.onCall(1).resolves();

  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: findBlocksStub,
    blockAt: sinon.stub().returns({ name: 'oak_log' }),
    pathfinder: { goto: gotoStub, stop: stopStub.callsFake(() => releaseFirstGoto?.()) },
    dig: sinon.stub().resolves()
  } as unknown as mineflayer.Bot;

  const actionManager = new ActionManager();
  const { mockServer, factory, getBot } = setup(bot, actionManager);
  registerPositionTools(factory, getBot, actionManager);

  const { executor: collectExecutor } = getExecutor(mockServer, 'collect-blocks');
  const { executor: moveExecutor } = getExecutor(mockServer, 'move-to-position');

  const collectPromise = collectExecutor({ blockType: 'oak_log', count: 3 });
  await new Promise((resolve) => setImmediate(resolve));

  t.deepEqual(actionManager.getCurrentAction()?.label, 'collect-blocks');

  const movePromise = moveExecutor({ x: 5, y: 64, z: 5 });
  const [collectResult, moveResult] = await Promise.all([collectPromise, movePromise]);

  t.true(stopStub.called);
  t.true(collectResult.isError);
  t.true(collectResult.content[0].text.includes('interrupted by a new action'));
  t.falsy(moveResult.isError);
  t.true(moveResult.content[0].text.includes('Successfully moved'));
  t.is(actionManager.getCurrentAction(), null);
});

// --- goto-player ---

test('goto-player paths to the player and stops the pathfinder on success', async (t) => {
  const gotoStub = sinon.stub().resolves();
  const stopStub = sinon.stub();
  const bot = {
    players: { Steve: { username: 'Steve', entity: { position: new Vec3(20, 64, 5) } } },
    pathfinder: { goto: gotoStub, stop: stopStub }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'goto-player');

  const result = await executor({ username: 'Steve', stopDistance: 2 });

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Reached Steve (within 2 blocks)');
  const goalArg = gotoStub.firstCall.args[0];
  t.is(goalArg.x, 20);
  t.is(goalArg.y, 64);
  t.is(goalArg.z, 5);
  t.true(stopStub.calledOnce);
});

test('goto-player reports when the player is not found', async (t) => {
  const bot = { players: {} } as unknown as mineflayer.Bot;
  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'goto-player');

  const result = await executor({ username: 'Ghost' });

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Cannot path to Ghost: player not found or not in render distance');
});

test.serial('goto-player times out and stops the pathfinder', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const stopStub = sinon.stub();
  const bot = {
    players: { Steve: { username: 'Steve', entity: { position: new Vec3(20, 64, 5) } } },
    pathfinder: { goto: sinon.stub().returns(new Promise(() => {})), stop: stopStub }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'goto-player');

  const resultPromise = executor({ username: 'Steve', timeoutMs: 1000 });
  await clock.tickAsync(1000);
  const result = await resultPromise;

  t.true(result.isError);
  t.true(result.content[0].text.includes('Timed out after 1000ms while pathing to Steve'));
  t.true(stopStub.calledOnce);
});

// --- follow-player ---

test('follow-player reports when the player is not found and never touches the pathfinder', async (t) => {
  const setGoalStub = sinon.stub();
  const bot = {
    players: {},
    pathfinder: { setGoal: setGoalStub, stop: sinon.stub() }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'follow-player');

  const result = await executor({ username: 'Ghost' });

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Cannot follow Ghost: player not found or not in render distance');
  t.true(setGoalStub.notCalled);
});

test.serial('follow-player follows until the timeout elapses, then stops the pathfinder', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const setGoalStub = sinon.stub();
  const stopStub = sinon.stub();
  const playerEntity = { position: new Vec3(5, 64, 5) };
  const bot = {
    players: { Steve: { username: 'Steve', entity: playerEntity } },
    pathfinder: { setGoal: setGoalStub, stop: stopStub }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'follow-player');

  const resultPromise = executor({ username: 'Steve', timeoutMs: 1000 });
  await clock.tickAsync(1000);
  const result = await resultPromise;

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Followed Steve for 1000ms, then stopped (timeout reached)');
  t.is(setGoalStub.callCount, 2);
  t.is(setGoalStub.firstCall.args[0].entity, playerEntity);
  t.is(setGoalStub.firstCall.args[1], true);
  t.is(setGoalStub.secondCall.args[0], null);
  t.true(stopStub.calledOnce);
});

test.serial('follow-player stops early and reports partial progress when the player leaves range', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const setGoalStub = sinon.stub();
  const stopStub = sinon.stub();
  const playerEntity = { position: new Vec3(5, 64, 5) };
  let stillPresent = true;
  setTimeout(() => {
    stillPresent = false;
  }, 300);

  const bot = {
    pathfinder: { setGoal: setGoalStub, stop: stopStub },
    get players() {
      return {
        Steve: { username: 'Steve', entity: stillPresent ? playerEntity : undefined }
      };
    }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'follow-player');

  const resultPromise = executor({ username: 'Steve', timeoutMs: 5000 });
  await clock.tickAsync(5000);
  const result = await resultPromise;

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Stopped following Steve after'));
  t.true(result.content[0].text.includes('no longer in range'));
  t.true(stopStub.calledOnce);
  t.true(setGoalStub.calledWith(null));
});

test.serial('stop (actionManager.interrupt) halts a running follow-player poll loop instead of letting it run to its own timeout', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const setGoalStub = sinon.stub();
  const stopStub = sinon.stub();
  const playerEntity = { position: new Vec3(5, 64, 5) };
  const bot = {
    players: { Steve: { username: 'Steve', entity: playerEntity } },
    pathfinder: { setGoal: setGoalStub, stop: stopStub }
  } as unknown as mineflayer.Bot;

  const actionManager = new ActionManager();
  const { mockServer } = setup(bot, actionManager);
  const { executor } = getExecutor(mockServer, 'follow-player');

  const resultPromise = executor({ username: 'Steve', timeoutMs: 60_000 });
  await clock.tickAsync(0);

  const current = actionManager.getCurrentAction();
  t.truthy(current);
  t.is(current?.label, 'follow-player');

  const stopResultPromise = actionManager.interrupt();
  await clock.tickAsync(250);
  const stopResult = await stopResultPromise;

  t.deepEqual(stopResult, { label: 'follow-player' });

  const result = await resultPromise;

  t.true(result.content[0].text.includes('interrupted by a new action'));
  t.true(stopStub.calledOnce);
  t.true(setGoalStub.calledWith(null));
  t.is(actionManager.getCurrentAction(), null);
});

// --- scan-area ---

test('scan-area summarizes block counts, notable blocks, entities and players', async (t) => {
  const oreVein = new Vec3(1, 64, 0);
  const oreVein2 = new Vec3(2, 64, 0);
  const stoneBlock = new Vec3(3, 64, 0);
  const chestBlock = new Vec3(4, 64, 0);

  const blockAtStub = sinon.stub();
  blockAtStub.withArgs(oreVein).returns({ name: 'iron_ore' });
  blockAtStub.withArgs(oreVein2).returns({ name: 'iron_ore' });
  blockAtStub.withArgs(stoneBlock).returns({ name: 'stone' });
  blockAtStub.withArgs(chestBlock).returns({ name: 'chest' });

  const bot = {
    username: 'LLMBot',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: sinon.stub().returns([oreVein, oreVein2, stoneBlock, chestBlock]),
    blockAt: blockAtStub,
    entities: {
      '1': { id: 1, type: 'mob', name: 'zombie', position: new Vec3(2, 64, 1) },
      '2': { id: 2, type: 'mob', name: 'zombie', position: new Vec3(3, 64, 1) },
      '3': { id: 3, type: 'player', position: new Vec3(5, 64, 5) },
      '4': { id: 4, type: 'object', name: 'item', position: new Vec3(50, 64, 50) }
    },
    players: {
      LLMBot: { username: 'LLMBot', entity: { position: new Vec3(0, 64, 0) } },
      Steve: { username: 'Steve', entity: { position: new Vec3(3, 64, 4) } },
      Far: { username: 'Far', entity: { position: new Vec3(100, 64, 100) } }
    }
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'scan-area');

  const result = await executor({});
  const text = result.content[0].text as string;
  t.log(text);

  t.is(
    text,
    [
      'Scanned radius 8: 4 non-air blocks',
      'Block types: iron_ore x2, stone x1, chest x1',
      'Notable blocks: iron_ore x2, chest x1',
      'Entities: zombie x2',
      'Players: Steve (5.0m)'
    ].join('\n')
  );
});

test('scan-area clamps an oversized radius and reports a capped block scan', async (t) => {
  const findBlocksStub = sinon.stub().returns(new Array(512).fill(new Vec3(1, 64, 0)));
  const bot = {
    username: 'LLMBot',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: findBlocksStub,
    blockAt: sinon.stub().returns({ name: 'stone' }),
    entities: {},
    players: {}
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'scan-area');

  const result = await executor({ radius: 1000 });
  const text = result.content[0].text as string;

  t.is(findBlocksStub.firstCall.args[0].maxDistance, 32);
  t.true(text.includes('Scanned radius 32'));
  t.true(text.includes('Block types: stone x512'));
  t.true(text.includes('Notable blocks: none'));
  t.true(text.includes('Notes: block scan capped at 512 blocks'));
});

test.serial('scan-area skips entity and player phases once the timeout elapses, keeping the block scan', async (t) => {
  const dateNowStub = sinon.stub(Date, 'now');
  t.teardown(() => dateNowStub.restore());
  dateNowStub.onCall(0).returns(1000);
  dateNowStub.onCall(1).returns(5000);
  dateNowStub.onCall(2).returns(5000);

  const dirtBlock1 = new Vec3(1, 64, 0);
  const dirtBlock2 = new Vec3(2, 64, 0);
  const bot = {
    username: 'LLMBot',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: sinon.stub().returns([dirtBlock1, dirtBlock2]),
    blockAt: sinon.stub().returns({ name: 'dirt' }),
    entities: {},
    players: {}
  } as unknown as mineflayer.Bot;

  const { mockServer } = setup(bot);
  const { executor } = getExecutor(mockServer, 'scan-area');

  const result = await executor({ timeoutMs: 100 });
  const text = result.content[0].text as string;

  t.true(text.includes('Block types: dirt x2'));
  t.true(text.includes('Entities: skipped (timed out)'));
  t.true(text.includes('Players: skipped (timed out)'));
  t.true(text.includes('Notes: entity scan skipped: timed out; player scan skipped: timed out'));
});
