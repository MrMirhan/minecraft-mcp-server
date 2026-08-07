import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { registerUiTools } from '../src/tools/ui-tools.js';
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

function getExecutor(mockServer: McpServer, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === name);
  if (!call) {
    throw new Error(`Tool ${name} was not registered`);
  }
  return call.args[3] as (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

function makeEventBot(): { bot: mineflayer.Bot; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const bot = emitter as unknown as mineflayer.Bot;
  return { bot, emitter };
}

test('registerUiTools registers all seven tools', (t) => {
  const { factory, mockServer } = makeFactory();
  const getBot = () => ({}) as mineflayer.Bot;

  registerUiTools(factory, getBot);

  const names = (mockServer.tool as sinon.SinonStub).getCalls().map((c) => c.args[0]);
  t.deepEqual(names.sort(), [
    'get-resource-pack',
    'read-bossbar',
    'read-scoreboard',
    'read-tablist',
    'read-teams',
    'read-title',
    'read-window'
  ].sort());
});

test('read-scoreboard returns titles and items for active positions', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    scoreboard: {
      sidebar: {
        title: 'Server Stats',
        items: [
          { name: '§aAlice', value: 42 },
          { name: '§cBob', value: 10 }
        ]
      }
    }
  } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-scoreboard');
  const result = await executor({});

  t.true(result.content[0].text.includes('Sidebar: Server Stats'));
  t.true(result.content[0].text.includes('§aAlice: 42'));
  t.true(result.content[0].text.includes('§cBob: 10'));
});

test('read-scoreboard renders a component title instead of [object Object]', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    scoreboard: {
      sidebar: {
        // 1.21.x delivers the title as a component object, not a JSON string
        title: { toMotd: () => '§6CraftRune' },
        items: [
          { name: 'raw_name', displayName: { toMotd: () => '§bKills' }, value: 7 }
        ]
      }
    }
  } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const result = await getExecutor(mockServer, 'read-scoreboard')({});

  t.false(result.content[0].text.includes('[object Object]'));
  t.true(result.content[0].text.includes('Sidebar: §6CraftRune'));
  t.true(result.content[0].text.includes('§bKills: 7'));
});

test('read-scoreboard reports when nothing is displayed', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { scoreboard: {} } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-scoreboard');
  const result = await executor({});

  t.is(result.content[0].text, 'No scoreboard is currently displayed');
});

test('read-window reports item details for non-empty slots', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    currentWindow: {
      title: 'Chest',
      slots: [
        null,
        {
          name: 'diamond_sword',
          count: 1,
          displayName: 'Diamond Sword',
          customName: '{"text":"§bMagic Sword"}',
          customLore: ['{"text":"§7Line one"}', '{"text":"§7Line two"}'],
          customModel: 1234
        }
      ]
    }
  } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-window');
  const result = await executor({});
  const text = result.content[0].text;

  t.true(text.includes('Window "Chest"'));
  t.true(text.includes('Slot 1: diamond_sword x1'));
  t.true(text.includes('Display name: §bMagic Sword'));
  t.true(text.includes('Lore: §7Line one | §7Line two'));
  t.true(text.includes('CustomModelData: 1234'));
});

test('read-window reports when no window is open', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { currentWindow: null } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-window');
  const result = await executor({});

  t.is(result.content[0].text, 'No window is currently open');
});

test('read-tablist returns header and footer text', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    tablist: {
      header: { toMotd: () => '§6Welcome' },
      footer: { toMotd: () => '§7Have fun' }
    }
  } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-tablist');
  const result = await executor({});

  t.is(result.content[0].text, 'Header: §6Welcome\nFooter: §7Have fun');
});

test('read-tablist reports when header and footer are unset', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    tablist: {
      header: { toMotd: () => '' },
      footer: { toMotd: () => '' }
    }
  } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-tablist');
  const result = await executor({});

  t.is(result.content[0].text, 'No tab list header or footer is set');
});

test('read-bossbar returns title, color, and progress', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    bossBars: [
      { title: { toMotd: () => '§4Dragon Fight' }, color: 'purple', health: 0.75 }
    ]
  } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-bossbar');
  const result = await executor({});

  t.true(result.content[0].text.includes('§4Dragon Fight - color: purple, progress: 0.75'));
});

test('read-bossbar reports when no boss bars are active', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { bossBars: [] } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-bossbar');
  const result = await executor({});

  t.is(result.content[0].text, 'No boss bars are currently active');
});

test('read-title returns the last title, subtitle, and action bar', async (t) => {
  const { factory, mockServer } = makeFactory();
  const { bot, emitter } = makeEventBot();
  registerUiTools(factory, () => bot);

  const executor = getExecutor(mockServer, 'read-title');
  await executor({});

  emitter.emit('title', '§6Boss Fight', 'title');
  emitter.emit('title', '§7Survive!', 'subtitle');
  emitter.emit('actionBar', { toMotd: () => '§cLow health' });

  const result = await executor({});
  const text = result.content[0].text;

  t.true(text.includes('Title: §6Boss Fight'));
  t.true(text.includes('Subtitle: §7Survive!'));
  t.true(text.includes('Action bar: §cLow health'));
});

test('read-title reports when nothing has been shown yet', async (t) => {
  const { factory, mockServer } = makeFactory();
  const { bot } = makeEventBot();
  registerUiTools(factory, () => bot);

  const executor = getExecutor(mockServer, 'read-title');
  const result = await executor({});

  t.is(result.content[0].text, 'No title, subtitle, or action bar has been shown yet');
});

test('read-teams returns prefix, suffix, color, and members', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    teams: {
      red: {
        team: 'red',
        color: 'red',
        prefix: { toMotd: () => '§c[RED] ' },
        suffix: { toMotd: () => '' },
        members: ['Alice', 'Bob']
      }
    }
  } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-teams');
  const result = await executor({});
  const text = result.content[0].text;

  t.true(text.includes('Team "red" (color: red)'));
  t.true(text.includes('Prefix: §c[RED] '));
  t.true(text.includes('Members: Alice, Bob'));
});

test('read-teams reports when no teams are registered', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { teams: {} } as unknown as mineflayer.Bot;
  registerUiTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'read-teams');
  const result = await executor({});

  t.is(result.content[0].text, 'No teams are currently registered');
});

test('get-resource-pack returns the url and hash', async (t) => {
  const { factory, mockServer } = makeFactory();
  const { bot, emitter } = makeEventBot();
  registerUiTools(factory, () => bot);

  const executor = getExecutor(mockServer, 'get-resource-pack');
  await executor({});

  emitter.emit('resourcePack', 'https://example.com/pack.zip', 'abc123');

  const result = await executor({});

  t.is(result.content[0].text, 'Resource pack URL: https://example.com/pack.zip\nHash: abc123');
});

test('get-resource-pack normalizes reversed argument order', async (t) => {
  const { factory, mockServer } = makeFactory();
  const { bot, emitter } = makeEventBot();
  registerUiTools(factory, () => bot);

  const executor = getExecutor(mockServer, 'get-resource-pack');
  await executor({});

  emitter.emit('resourcePack', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'https://example.com/pack.zip');

  const result = await executor({});

  t.is(result.content[0].text, 'Resource pack URL: https://example.com/pack.zip\nHash: f47ac10b-58cc-4372-a567-0e02b2c3d479');
});

test('get-resource-pack reports when no pack has been sent', async (t) => {
  const { factory, mockServer } = makeFactory();
  const { bot } = makeEventBot();
  registerUiTools(factory, () => bot);

  const executor = getExecutor(mockServer, 'get-resource-pack');
  const result = await executor({});

  t.is(result.content[0].text, 'No resource pack has been sent by the server');
});
