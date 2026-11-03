import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type mineflayer from 'mineflayer';
import { componentParts, componentText, interactiveParts } from '../src/gui/text.js';
import { dialogEffect, parseDialog, type NbtTag } from '../src/gui/dialog.js';
import {
  anvilRename, attachGuiState, chatActions, clickChat, clickSlot, describeWindow, dragSlots, listTrades, pressButton,
  readDialog, respondDialog, setBeaconEffect, trade, writeSign
} from '../src/gui/gui-core.js';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
const Item = require('prismarine-item')(registry);

// ---------------------------------------------------------------- NBT helpers for dialogs

const s = (value: string): NbtTag => ({ type: 'string', value });
const b = (value: number): NbtTag => ({ type: 'byte', value });
const f = (value: number): NbtTag => ({ type: 'float', value });
const compound = (value: Record<string, NbtTag>): NbtTag => ({ type: 'compound', value });
const list = (items: NbtTag[]): NbtTag => ({ type: 'list', value: { type: items[0]?.type ?? 'end', value: items.map((i) => i.value) } });

const shopDialog = compound({
  type: s('minecraft:multi_action'),
  title: s('Shop'),
  body: list([compound({ type: s('minecraft:plain_message'), contents: s('Pick an amount') })]),
  inputs: list([
    compound({ type: s('minecraft:number_range'), key: s('amount'), label: s('Amount'), start: f(1), end: f(64), step: f(1), initial: f(1) }),
    compound({ type: s('minecraft:boolean'), key: s('gift'), label: s('Gift'), on_true: s('yes'), on_false: s('no') }),
    compound({ type: s('minecraft:single_option'), key: s('color'), label: s('Color'), options: list([
      compound({ id: s('red'), display: s('Red') }),
      compound({ id: s('blue'), display: s('Blue'), initial: b(1) })
    ]) })
  ]),
  actions: list([
    compound({ label: s('Buy'), action: compound({ type: s('dynamic/run_command'), template: s('buy $(amount) $(color) $(gift)') }) }),
    compound({ label: s('Confirm'), action: compound({ type: s('dynamic/custom'), id: s('shop:confirm'), additions: compound({ shop: s('main') }) }) }),
    compound({ label: s('Help'), action: compound({ type: s('open_url'), url: s('https://example.com/help') }) })
  ]),
  exit_action: compound({ label: s('Cancel') })
});

// ---------------------------------------------------------------- a fake bot

interface FakeBot extends EventEmitter {
  _client: EventEmitter & { write: sinon.SinonSpy; writeRaw: sinon.SinonSpy };
  version: string;
  registry: unknown;
  inventory: { id: number; type: string; slots: unknown[]; selectedItem: unknown; inventoryStart: number };
  currentWindow: null | { id: number; type: string; title: string; slots: unknown[]; selectedItem: unknown; inventoryStart: number };
  game: { gameMode: string };
  chat: sinon.SinonSpy;
  closeWindow: (window: unknown) => void;
  supportFeature: (name: string) => boolean;
  username: string;
}

function makeBot(): FakeBot {
  const bot = new EventEmitter() as FakeBot;
  const client = new EventEmitter() as FakeBot['_client'];
  client.write = sinon.spy((name: string, packet: { windowId?: number }) => {
    // The server answers a click with the whole window, as it does for a stateId it never issued.
    if (name === 'window_click') setImmediate(() => bot.emit(`setWindowItems:${packet.windowId}`));
  });
  client.writeRaw = sinon.spy();
  bot._client = client;
  bot.version = '1.21.11';
  bot.registry = registry;
  bot.inventory = { id: 0, type: 'minecraft:inventory', slots: new Array(46).fill(null), selectedItem: null, inventoryStart: 9 };
  bot.currentWindow = null;
  bot.game = { gameMode: 'survival' };
  bot.chat = sinon.spy();
  bot.closeWindow = () => { bot.currentWindow = null; };
  bot.supportFeature = (name: string) => name === 'stateIdUsed';
  bot.username = 'Tester';
  attachGuiState(bot as unknown as mineflayer.Bot);
  return bot;
}

const asBot = (bot: FakeBot) => bot as unknown as mineflayer.Bot;
const writes = (bot: FakeBot, name: string) => bot._client.write.getCalls().filter((c) => c.args[0] === name).map((c) => c.args[1]);

/** Reads back the raw custom_click_action packets: packet id, id, then the length-prefixed payload. */
function customClicks(bot: FakeBot): Array<{ packetId: number; id: string; nbt: unknown }> {
  const nbtLib = require('prismarine-nbt');
  return bot._client.writeRaw.getCalls().map((c) => {
    const buf = c.args[0] as Buffer;
    let at = 0;
    const varint = () => { let n = 0; let shift = 0; let b; do { b = buf[at++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return n; };
    const packetId = varint();
    const idLen = varint();
    const id = buf.subarray(at, at + idLen).toString('utf8'); at += idLen;
    const len = varint();
    const payload = buf.subarray(at, at + len);
    t_assert(at + len === buf.length, 'the payload length covers the rest of the packet');
    const nbt = payload.length === 1 && payload[0] === 0 ? undefined : nbtLib.protos.big.parsePacketBuffer('anonymousNbt', payload).data;
    return { packetId, id, nbt };
  });
}
function t_assert(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

// ---------------------------------------------------------------- text

test('component text and the click and hover of each part, in the 1.21.5+ and the older form', (t) => {
  const modern = { text: 'Teleport? ', extra: [
    { text: '[Accept]', click_event: { action: 'run_command', command: '/tpaccept' }, hover_event: { action: 'show_text', value: 'Click to accept' } },
    { text: ' ' },
    { text: '[Site]', click_event: { action: 'open_url', url: 'https://example.com' } }
  ] };
  t.is(componentText(modern), 'Teleport? [Accept] [Site]');
  const parts = interactiveParts(modern);
  t.deepEqual(parts.map((p) => [p.text, p.click?.action, p.click?.value, p.hover]), [
    ['[Accept]', 'run_command', '/tpaccept', 'Click to accept'],
    ['[Site]', 'open_url', 'https://example.com', undefined]
  ]);
  const legacy = JSON.stringify({ text: 'Vote', clickEvent: { action: 'suggest_command', value: '/vote ' }, hoverEvent: { action: 'show_text', contents: { text: 'Vote for us' } } });
  t.deepEqual(componentParts(legacy), [{ text: 'Vote', click: { action: 'suggest_command', value: '/vote ' }, hover: 'Vote for us' }]);
});

// ---------------------------------------------------------------- dialogs

test('a multi-action dialog: body, inputs with limits, buttons and the exit', (t) => {
  const d = parseDialog({ data: shopDialog });
  t.is(d.kind, 'multi_action');
  t.is(d.title, 'Shop');
  t.deepEqual(d.body, ['Pick an amount']);
  t.deepEqual(d.inputs.map((i) => [i.key, i.type, i.initial]), [['amount', 'number_range', 1], ['gift', 'boolean', false], ['color', 'single_option', 'blue']]);
  t.deepEqual(d.buttons.map((x) => x.label), ['Buy', 'Confirm', 'Help']);
  t.is(d.exit?.label, 'Cancel');
});

test('dynamic run_command fills the template; dynamic custom sends the additions and the inputs as NBT', (t) => {
  const d = parseDialog(shopDialog);
  t.deepEqual(dialogEffect(d, d.buttons[0], { amount: 16, gift: true }), { kind: 'command', command: 'buy 16 blue yes' });
  const custom = dialogEffect(d, d.buttons[1], { amount: 2.5, color: 'Red' });
  t.deepEqual(custom, { kind: 'custom', id: 'shop:confirm', nbt: compound({ shop: s('main'), amount: f(2.5), gift: b(0), color: s('red') }) });
  t.deepEqual(dialogEffect(d, d.buttons[2]), { kind: 'info', action: 'open_url', value: 'https://example.com/help' });
  t.throws(() => dialogEffect(d, d.buttons[0], { amount: 100 }), { message: /between 1 and 64/ });
  t.throws(() => dialogEffect(d, d.buttons[0], { size: 1 }), { message: /no input "size"/ });
});

test('a notice and a confirmation have their fixed buttons; a registry dialog is named by id', (t) => {
  t.deepEqual(parseDialog(compound({ type: s('minecraft:notice'), title: s('Hi') })).buttons, [{ label: 'OK' }]);
  const c = parseDialog(compound({ type: s('confirmation'), title: s('Sure?'), yes: compound({ label: s('Yes'), action: compound({ type: s('run_command'), command: s('/confirm') }) }), no: compound({ label: s('No') }) }));
  t.deepEqual(c.buttons.map((x) => [x.label, x.action?.value]), [['Yes', '/confirm'], ['No', undefined]]);
  t.is(parseDialog({ dialogId: 7 }).registryId, 7);
});

test('show_dialog opens a dialog the tools read and answer with custom_click_action', async (t) => {
  const bot = makeBot();
  bot._client.emit('show_dialog', { dialog: { data: shopDialog } });
  t.true(readDialog(asBot(bot)).includes('amount [number_range]'));
  const reply = await respondDialog(asBot(bot), { button: 'confirm', inputs: { amount: 3 } });
  t.true(reply.includes('Sent custom click shop:confirm'));
  const [packet] = customClicks(bot);
  t.is(packet.packetId, 0x41);
  t.is(packet.id, 'shop:confirm');
  t.is((packet.nbt as NbtTag & { value: Record<string, NbtTag> }).value.amount.value, 3);
  t.is(readDialog(asBot(bot)), 'No dialog is open.');

  bot._client.emit('show_dialog', { dialog: { data: shopDialog } });
  await respondDialog(asBot(bot), { button: 0, inputs: { amount: 5 } });
  t.true(bot.chat.calledWith('/buy 5 blue no'));
  bot._client.emit('show_dialog', { dialog: { data: shopDialog } });
  bot._client.emit('clear_dialog', {});
  await t.throwsAsync(respondDialog(asBot(bot), { button: 0 }), { message: 'No dialog is open' });
});

// ---------------------------------------------------------------- clicks

test('each click type is the vanilla mode and button of window_click', async (t) => {
  const bot = makeBot();
  await clickSlot(asBot(bot), { type: 'shift', slot: 10 });
  await clickSlot(asBot(bot), { type: 'number', slot: 10, hotbar: 3 });
  await clickSlot(asBot(bot), { type: 'offhand', slot: 10 });
  await clickSlot(asBot(bot), { type: 'drop_stack', slot: 10 });
  await clickSlot(asBot(bot), { type: 'double', slot: 10 });
  await clickSlot(asBot(bot), { type: 'outside_right' });
  t.deepEqual(writes(bot, 'window_click').map((p) => [p.slot, p.mode, p.mouseButton, p.stateId]), [
    [10, 1, 0, -1], [10, 2, 2, -1], [10, 2, 40, -1], [10, 4, 1, -1], [10, 0, 0, -1], [10, 6, 0, -1], [-999, 0, 1, -1]
  ]);
  await t.throwsAsync(clickSlot(asBot(bot), { type: 'number', slot: 10 }), { message: /hotbar 1-9/ });
  await t.throwsAsync(clickSlot(asBot(bot), { type: 'left', slot: 99 }), { message: /not in the open window/ });
});

test('a drag is start, one add per slot, and end (QUICK_CRAFT)', async (t) => {
  const bot = makeBot();
  await t.throwsAsync(dragSlots(asBot(bot), [9, 10]), { message: /cursor holds nothing/ });
  bot.inventory.selectedItem = new Item(registry.itemsByName.stone.id, 10);
  await dragSlots(asBot(bot), [9, 10], 'right');
  t.deepEqual(writes(bot, 'window_click').map((p) => [p.slot, p.mode, p.mouseButton]), [[-999, 5, 4], [9, 5, 5], [10, 5, 5], [-999, 5, 6]]);
});

test('window state shows the cursor, the screen properties and hover text in lore', (t) => {
  const bot = makeBot();
  bot.currentWindow = { id: 3, type: 'minecraft:enchantment', title: '{"text":"Enchant"}', slots: new Array(38).fill(null), selectedItem: new Item(registry.itemsByName.lapis_lazuli.id, 3), inventoryStart: 2 };
  bot._client.emit('craft_progress_bar', { windowId: 3, property: 0, value: 5 });
  const out = describeWindow(asBot(bot));
  t.true(out.includes('Window "Enchant" (id 3, minecraft:enchantment'));
  t.true(out.includes('Cursor (carried): lapis_lazuli x3'));
  t.true(out.includes('level cost (top)=5'));
});

test('anvil, sign, screen buttons and beacon send their own packets', async (t) => {
  const bot = makeBot();
  bot.currentWindow = { id: 4, type: 'minecraft:anvil', title: 'Repair', slots: new Array(39).fill(null), selectedItem: null, inventoryStart: 3 };
  await t.throwsAsync(anvilRename(asBot(bot), 'Search'), { message: /slot 0/ });
  bot.currentWindow.slots[0] = new Item(registry.itemsByName.paper.id, 1);
  await anvilRename(asBot(bot), 'diamond');
  t.deepEqual(writes(bot, 'name_item'), [{ name: 'diamond' }]);

  bot._client.emit('open_sign_entity', { location: { x: 1, y: 64, z: 2 }, isFrontText: false });
  writeSign(asBot(bot), ['hello', 'world']);
  const [sign] = writes(bot, 'update_sign');
  t.deepEqual([sign.location.x, sign.location.y, sign.location.z, sign.isFrontText, sign.text1, sign.text2, sign.text3], [1, 64, 2, false, 'hello', 'world', '']);
  t.throws(() => writeSign(asBot(bot), ['x']), { message: /No sign editor/ });

  await pressButton(asBot(bot), 2);
  t.deepEqual(writes(bot, 'enchant_item'), [{ windowId: 4, enchantment: 2 }]);

  bot.currentWindow = { id: 5, type: 'minecraft:beacon', title: 'Beacon', slots: new Array(37).fill(null), selectedItem: null, inventoryStart: 1 };
  bot.currentWindow.slots[0] = new Item(registry.itemsByName.iron_ingot.id, 1);
  setBeaconEffect(asBot(bot), 'haste', 'regeneration');
  const [beacon] = writes(bot, 'set_beacon_effect');
  t.is(beacon.primary_effect, registry.effectsByName.Haste.id);
  t.is(beacon.secondary_effect, registry.effectsByName.Regeneration.id);
  t.is(bot.currentWindow, null, 'the screen closes after Done, as in vanilla');
});

test('villager trades are read from trade_list and a trade selects the offer then takes the result', async (t) => {
  const bot = makeBot();
  bot.currentWindow = { id: 6, type: 'minecraft:merchant', title: 'Farmer', slots: new Array(39).fill(null), selectedItem: null, inventoryStart: 3 };
  bot._client.emit('trade_list', {
    windowId: 6, villagerLevel: 2,
    trades: [{ inputItem1: { itemId: registry.itemsByName.wheat.id, itemCount: 20 }, outputItem: Item.toNotch(new Item(registry.itemsByName.emerald.id, 1)), tradeDisabled: false, nbTradeUses: 0, maximumNbTradeUses: 16, xp: 2, specialPrice: 0 }]
  });
  t.true(listTrades(asBot(bot)).includes('0: wheat x20 -> emerald x1  uses 0/16'));
  // The server puts the result in slot 2 on select_trade; a left click takes it onto the cursor.
  const win = bot.currentWindow!;
  bot._client.write = sinon.spy((name: string, packet: { windowId?: number; slot?: number; mode?: number }) => {
    if (name === 'select_trade') win.slots[2] = new Item(registry.itemsByName.emerald.id, 1);
    if (name === 'window_click') {
      if (packet.slot === 2 && packet.mode === 0) {
        const carried = win.selectedItem as { count: number } | null;
        win.selectedItem = new Item(registry.itemsByName.emerald.id, (carried?.count ?? 0) + 1);
        win.slots[2] = null;
      } else if (packet.slot !== undefined && packet.slot >= 3 && packet.mode === 0) {
        win.slots[packet.slot] = win.selectedItem;
        win.selectedItem = null;
      }
      setImmediate(() => bot.emit(`setWindowItems:${packet.windowId}`));
    }
  });
  const out = await trade(asBot(bot), 0, 2);
  t.true(out.includes('done 2 of 2'), out);
  t.deepEqual(writes(bot, 'window_click').map((p) => [p.slot, p.mode, p.mouseButton]), [[2, 0, 0], [2, 0, 0], [3, 0, 0]]);
  t.is((win.slots[3] as { count: number }).count, 2);
  t.is(win.selectedItem, null);
  await trade(asBot(bot), 0, 1, true);
  t.deepEqual(writes(bot, 'window_click').slice(-1).map((p) => [p.slot, p.mode]), [[2, 1]]);
});

// ---------------------------------------------------------------- clickable chat

test('chat buttons: run_command runs, suggest_command sends only when asked, custom goes to the server', async (t) => {
  const bot = makeBot();
  bot.emit('message', { json: { text: 'Duel from Steve ', extra: [
    { text: '[Accept]', click_event: { action: 'run_command', command: 'duel accept Steve' } },
    { text: '[Reply]', click_event: { action: 'suggest_command', command: '/msg Steve ' } },
    { text: '[Claim]', click_event: { action: 'custom', id: 'rewards:claim', payload: { day: 3 } }, hover_event: { action: 'show_text', value: 'Daily reward' } }
  ] } });
  bot.emit('message', { json: { text: 'plain' } });
  const listed = chatActions(asBot(bot));
  t.true(listed.includes('click: run_command duel accept Steve'));
  t.true(listed.includes('hover: Daily reward'));
  t.false(listed.includes('plain'));

  await clickChat(asBot(bot), { contains: 'accept' });
  t.true(bot.chat.calledWith('/duel accept Steve'));
  const suggest = await clickChat(asBot(bot), { contains: 'reply' });
  t.true(suggest.includes('Nothing was sent'));
  t.is(bot.chat.callCount, 1);
  await clickChat(asBot(bot), { contains: 'reply', send: '/msg Steve gg' });
  t.true(bot.chat.calledWith('/msg Steve gg'));
  await clickChat(asBot(bot), { contains: 'claim' });
  const [custom] = customClicks(bot);
  t.is(custom.id, 'rewards:claim');
  t.deepEqual(custom.nbt, { type: 'compound', value: { day: { type: 'int', value: 3 } } });
});

// ---------------------------------------------------------------- the packets as the real protocol encodes them

for (const version of ['1.21.11', '26.1.2']) {
  test(`every screen packet encodes with the ${version} protocol`, async (t) => {
    const { createSerializer, states } = require('minecraft-protocol');
    const serializer = createSerializer({ state: states.PLAY, version, isServer: false });
    const reg = require('prismarine-registry')(version);
    const VItem = require('prismarine-item')(reg);
    const bot = makeBot();
    bot.registry = reg;
    bot.version = version;
    const sent: string[] = [];
    bot._client.write = sinon.spy((name: string, params: { windowId?: number }) => {
      serializer.createPacketBuffer({ name, params }); // throws on a wrong field
      sent.push(name);
      if (name === 'window_click') setImmediate(() => bot.emit(`setWindowItems:${params.windowId}`));
    });
    bot._client.writeRaw = sinon.spy(() => sent.push('custom_click_action (raw)'));
    bot.inventory.selectedItem = new VItem(reg.itemsByName.stone.id, 4);
    await clickSlot(asBot(bot), { type: 'offhand', slot: 12 });
    await dragSlots(asBot(bot), [10, 11], 'left');
    bot.currentWindow = { id: 7, type: 'minecraft:beacon', title: 'Beacon', slots: new Array(37).fill(null), selectedItem: null, inventoryStart: 1 };
    bot.currentWindow.slots[0] = new VItem(reg.itemsByName.iron_ingot.id, 1);
    await pressButton(asBot(bot), 1);
    setBeaconEffect(asBot(bot), 'speed');
    bot.currentWindow = { id: 8, type: 'minecraft:anvil', title: 'Repair', slots: new Array(39).fill(null), selectedItem: null, inventoryStart: 3 };
    bot.currentWindow.slots[0] = new VItem(reg.itemsByName.paper.id, 1);
    await anvilRename(asBot(bot), 'Name');
    writeSign(asBot(bot), ['a', 'b'], { x: 1, y: 2, z: 3, back: true });
    bot._client.emit('show_dialog', { dialog: { data: shopDialog } });
    await respondDialog(asBot(bot), { button: 'Confirm', inputs: { amount: 4, gift: true } });
    t.deepEqual(sent, ['window_click', 'window_click', 'window_click', 'window_click', 'window_click', 'enchant_item', 'set_beacon_effect', 'name_item', 'update_sign', 'custom_click_action (raw)']);
  });
}
