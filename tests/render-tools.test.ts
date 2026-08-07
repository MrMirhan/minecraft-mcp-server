import test from 'ava';
import sinon from 'sinon';
import { createCanvas } from 'canvas';
import { registerRenderTools, isBlankImage, renderWindowToPng, nearestSupportedVersion, hasBundledTextures } from '../src/tools/render-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';

function setup() {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  return { mockServer, factory };
}

function solidColorPng(width: number, height: number, color: string): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

function checkerboardPng(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const cell = 4;
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      ctx.fillStyle = ((x / cell) + (y / cell)) % 2 === 0 ? '#000000' : '#ffffff';
      ctx.fillRect(x, y, cell, cell);
    }
  }
  return canvas.toBuffer('image/png');
}

function makeWindow(overrides: Partial<{ slots: Array<{ name: string; count: number } | null>; title: string; type: string; inventoryStart: number; hotbarStart: number }> = {}) {
  const slots = overrides.slots ?? new Array(9).fill(null);
  return {
    id: 0,
    type: overrides.type ?? 'minecraft:generic_9x1',
    title: overrides.title ?? 'Chest',
    slots,
    inventoryStart: overrides.inventoryStart ?? slots.length,
    inventoryEnd: slots.length,
    hotbarStart: overrides.hotbarStart ?? slots.length
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test('registerRenderTools registers take-screenshot tool', (t) => {
  const { mockServer, factory } = setup();
  const getBot = () => ({}) as mineflayer.Bot;

  registerRenderTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === 'take-screenshot');

  t.truthy(call);
  t.is(call!.args[1], "Render the bot's surroundings as a PNG image using prismarine-viewer");
});

test('registerRenderTools registers render-window tool', (t) => {
  const { mockServer, factory } = setup();
  const getBot = () => ({}) as mineflayer.Bot;

  registerRenderTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === 'render-window');

  t.truthy(call);
  t.is(call!.args[1], "Render the currently open inventory or container window as a PNG image styled after the Minecraft GUI");
});

test('take-screenshot returns a text error when no older assets exist, without touching puppeteer', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = { version: '0.1' } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerRenderTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const executor = toolCalls.find((c) => c.args[0] === 'take-screenshot')!.args[3];

  const result = await executor({});

  t.is(result.content[0].type, 'text');
  t.true(result.content[0].text.includes('cannot render Minecraft 0.1'));
});

test('hasBundledTextures reports missing texture sets', (t) => {
  t.false(hasBundledTextures('99.99.99'));
  t.true(hasBundledTextures('1.21.4'));
});

test('nearestSupportedVersion falls back to the closest older asset set', (t) => {
  t.is(nearestSupportedVersion('1.21.11'), '1.21.4');
  t.is(nearestSupportedVersion('1.21.5'), '1.21.4');
  t.is(nearestSupportedVersion('0.1'), null);
});

test('render-window returns a text error when no window is open', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = { currentWindow: null } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerRenderTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const executor = toolCalls.find((c) => c.args[0] === 'render-window')!.args[3];

  const result = await executor({});

  t.is(result.content[0].type, 'text');
  t.true(result.content[0].text.includes('No inventory or container window is currently open'));
});

test('render-window returns a base64 PNG image when a window is open', async (t) => {
  const { mockServer, factory } = setup();
  const win = makeWindow({
    slots: [{ name: 'diamond', count: 5 }, null, { name: 'stone', count: 64 }],
    title: 'Chest',
    inventoryStart: 3,
    hotbarStart: 3
  });
  const mockBot = { currentWindow: win } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerRenderTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const executor = toolCalls.find((c) => c.args[0] === 'render-window')!.args[3];

  const result = await executor({});

  t.is(result.content[0].type, 'image');
  t.is(result.content[0].mimeType, 'image/png');
  t.true(typeof result.content[0].data === 'string' && result.content[0].data.length > 0);
  t.false(await isBlankImage(Buffer.from(result.content[0].data, 'base64')));
});

test('renderWindowToPng produces a non-blank PNG for a window with items', async (t) => {
  const win = makeWindow({ slots: [{ name: 'iron_ingot', count: 12 }, null, null] });

  const buffer = renderWindowToPng(win);

  t.true(buffer.length > 0);
  t.false(await isBlankImage(buffer));
});

test('renderWindowToPng draws the real texture for a known item', (t) => {
  const known = renderWindowToPng(makeWindow({ slots: [{ name: 'diamond_sword', count: 1 }, null, null] }));
  const unknown = renderWindowToPng(makeWindow({ slots: [{ name: 'not_a_real_item_xyz', count: 1 }, null, null] }));

  // The flat fallback swatch compresses far smaller than a real 16x16 texture.
  t.true(known.length > unknown.length, 'textured slot must differ from the fallback swatch');
});

test('renderWindowToPng falls back to a swatch for an unknown item', async (t) => {
  const buffer = renderWindowToPng(makeWindow({ slots: [{ name: 'not_a_real_item_xyz', count: 5 }, null, null] }));

  t.true(buffer.length > 0);
  t.false(await isBlankImage(buffer));
});

test('isBlankImage returns true for a single flat color image', async (t) => {
  const buffer = solidColorPng(32, 32, '#8b8b8b');

  t.true(await isBlankImage(buffer));
});

test('isBlankImage returns false for a multi-color image', async (t) => {
  const buffer = checkerboardPng(32, 32);

  t.false(await isBlankImage(buffer));
});
