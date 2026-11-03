import type mineflayer from 'mineflayer';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { componentParts, componentText, interactiveParts, type ClickAction, type TextPart } from './text.js';
import { describeDialog, dialogEffect, jsonToNbt, parseDialog, type Dialog, type DialogEffect, type NbtTag } from './dialog.js';

/**
 * Every screen and click a player has, sent with the game's own packets, so plugins see the events a
 * real player makes (InventoryClickEvent with the same ClickType, PrepareAnvilEvent, SignChangeEvent,
 * PlayerEditBookEvent, TradeSelectEvent, PlayerCustomClickEvent, ...). Shared by the MCP tools and the
 * scenario bots.
 */

type Bot = mineflayer.Bot;
// prismarine-item is CommonJS and its types declare an ES default export, so it is loaded with require.
const requireCjs = createRequire(import.meta.url);
const prismarineItem = requireCjs('prismarine-item') as (registry: unknown) => unknown;
const prismarineNbt = requireCjs('prismarine-nbt') as { protos: { big: { createPacketBuffer(type: string, value: unknown): Buffer } } };
const minecraftData = requireCjs('minecraft-data') as (version: string) => { protocol?: { play?: { toServer?: { types?: Record<string, unknown> } } } } | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWindow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyItem = any;

// ---------------------------------------------------------------- clicks

/** The clicks of the vanilla container screen, as (mode, button) of `window_click`. */
export const CLICK_TYPES = {
  left: { mode: 0, button: 0, does: 'pick up or put down the stack (PICKUP)' },
  right: { mode: 0, button: 1, does: 'pick up half, or put down one (PICKUP)' },
  shift: { mode: 1, button: 0, does: 'move the stack to the other part of the screen (QUICK_MOVE)' },
  shift_right: { mode: 1, button: 1, does: 'shift + right click (QUICK_MOVE)' },
  number: { mode: 2, button: -1, does: 'swap with a hotbar slot, as keys 1-9 do (SWAP); needs hotbar' },
  offhand: { mode: 2, button: 40, does: 'swap with the offhand, as F does (SWAP)' },
  middle: { mode: 3, button: 2, does: 'clone the stack to the cursor, creative only (CLONE)' },
  drop: { mode: 4, button: 0, does: 'drop one, as Q does (THROW)' },
  drop_stack: { mode: 4, button: 1, does: 'drop the stack, as Ctrl+Q does (THROW)' },
  pickup_all: { mode: 6, button: 0, does: 'gather the same items onto the cursor (PICKUP_ALL)' },
  double: { mode: 6, button: 0, does: 'a double click: left click, then gather the same items (PICKUP + PICKUP_ALL)' },
  outside_left: { mode: 0, button: 0, does: 'click outside the window: drop the cursor stack (slot -999)' },
  outside_right: { mode: 0, button: 1, does: 'right click outside the window: drop one from the cursor (slot -999)' }
} as const;

export type ClickType = keyof typeof CLICK_TYPES;
export const CLICK_TYPE_NAMES = Object.keys(CLICK_TYPES) as [ClickType, ...ClickType[]];

/** Drag buttons: QUICK_CRAFT start/add/end buttons. */
export const DRAG_BUTTONS = {
  left: { start: 0, add: 1, end: 2, does: 'split the cursor stack evenly over the slots' },
  right: { start: 4, add: 5, end: 6, does: 'put one item in each slot' },
  middle: { start: 8, add: 9, end: 10, does: 'creative: a full stack in each slot' }
} as const;
export type DragButton = keyof typeof DRAG_BUTTONS;

function itemClass(bot: Bot) {
  return prismarineItem(bot.registry as never) as unknown as {
    new (type: number, count: number): AnyItem;
    toNotch(item: AnyItem): unknown;
  };
}

function activeWindow(bot: Bot): AnyWindow {
  return (bot.currentWindow ?? bot.inventory) as AnyWindow;
}

function supportsStateId(bot: Bot): boolean {
  return bot.supportFeature('stateIdUsed' as never) as unknown as boolean;
}

/**
 * Sends one `window_click` as the client does. The stateId is one the server never issued, so it
 * answers with the whole window and mineflayer's copy is exact afterwards, whatever the click did.
 */
function sendClick(bot: Bot, slot: number, button: number, mode: number): void {
  const window = activeWindow(bot);
  const Item = itemClass(bot);
  bot._client.write('window_click', {
    windowId: window.id,
    stateId: -1,
    slot,
    mouseButton: button,
    mode,
    changedSlots: [],
    cursorItem: Item.toNotch(window.selectedItem ?? null)
  });
}

/** Waits for `count` whole-window updates: the server sends one for each click with an unknown stateId. */
function waitForWindowItems(bot: Bot, windowId: number, ms = 1500, count = 1): Promise<boolean> {
  return new Promise((resolve) => {
    const event = `setWindowItems:${windowId}`;
    let left = count;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      bot.removeListener(event as never, onItems as never);
      resolve(ok);
    };
    const onItems = () => { if (--left <= 0) done(true); };
    const timer = setTimeout(() => done(false), ms);
    bot.on(event as never, onItems as never);
  });
}

async function clickRaw(bot: Bot, slot: number, button: number, mode: number): Promise<void> {
  const window = activeWindow(bot);
  if (supportsStateId(bot)) {
    const synced = waitForWindowItems(bot, window.id);
    sendClick(bot, slot, button, mode);
    await synced;
    return;
  }
  // Before 1.17.1 the click carries an action number that mineflayer keeps; its own path predicts the result.
  await bot.clickWindow(slot, button, mode);
}

export interface ClickOptions {
  slot?: number;
  type: ClickType;
  /** For `number`: the hotbar key, 1-9. */
  hotbar?: number;
}

export async function clickSlot(bot: Bot, opts: ClickOptions): Promise<string> {
  const spec = CLICK_TYPES[opts.type];
  if (!spec) throw new Error(`Unknown click type "${opts.type}"`);
  const outside = opts.type === 'outside_left' || opts.type === 'outside_right';
  const slot = outside ? -999 : opts.slot;
  if (slot === undefined) throw new Error(`Click type ${opts.type} needs a slot`);
  const window = activeWindow(bot);
  if (!outside && (slot < 0 || slot >= window.slots.length)) {
    throw new Error(`Slot ${slot} is not in the open window (0-${window.slots.length - 1})`);
  }
  let button: number = spec.button;
  if (opts.type === 'number') {
    if (!opts.hotbar || opts.hotbar < 1 || opts.hotbar > 9) throw new Error('A number-key click needs hotbar 1-9');
    button = opts.hotbar - 1;
  }
  if (opts.type === 'middle' && bot.game.gameMode !== 'creative') {
    // The server ignores it outside creative, as vanilla does; say so instead of failing silently.
    await clickRaw(bot, slot, button, spec.mode);
    return `Middle click sent on slot ${slot}; it only copies in creative mode (game mode: ${bot.game.gameMode}).\n${describeCursor(bot)}`;
  }
  if (opts.type === 'double') await clickRaw(bot, slot, 0, 0);
  await clickRaw(bot, slot, button, spec.mode);
  return `${opts.type} click on ${outside ? 'outside the window' : `slot ${slot}`}.\n${describeCursor(bot)}`;
}

export async function dragSlots(bot: Bot, slots: number[], button: DragButton = 'left'): Promise<string> {
  const spec = DRAG_BUTTONS[button];
  if (!spec) throw new Error(`Unknown drag button "${button}"`);
  if (slots.length === 0) throw new Error('A drag needs at least one slot');
  const window = activeWindow(bot);
  for (const slot of slots) {
    if (slot < 0 || slot >= window.slots.length) throw new Error(`Slot ${slot} is not in the open window`);
  }
  if (!window.selectedItem) throw new Error('The cursor holds nothing to drag; pick a stack up first');
  if (!supportsStateId(bot)) throw new Error('Drags need Minecraft 1.17.1 or newer');
  // Each packet is answered with the whole window; only the answer to the last one shows the drag done.
  const synced = waitForWindowItems(bot, window.id, 3000, slots.length + 2);
  sendClick(bot, -999, spec.start, 5);
  for (const slot of slots) sendClick(bot, slot, spec.add, 5);
  sendClick(bot, -999, spec.end, 5);
  await synced;
  return `Dragged (${button}) over slots ${slots.join(', ')}.\n${describeCursor(bot)}`;
}

// ---------------------------------------------------------------- reading items

export function itemName(item: AnyItem): string {
  if (!item) return 'empty';
  const custom = item.customName ? componentText(item.customName) : '';
  return `${item.name} x${item.count}${custom ? ` "${custom}"` : ''}`;
}

export function loreOf(item: AnyItem): unknown[] {
  const lore = item?.customLore;
  if (!lore) return [];
  return Array.isArray(lore) ? lore : String(lore).split('\n');
}

/** The hover texts inside an item's name and lore (a plugin can put them there). */
export function itemHovers(item: AnyItem): TextPart[] {
  if (!item) return [];
  return [...(item.customName ? interactiveParts(item.customName) : []), ...loreOf(item).flatMap((line) => interactiveParts(line))];
}

export function describeCursor(bot: Bot): string {
  const window = activeWindow(bot);
  return `Cursor (carried): ${itemName(window.selectedItem)}`;
}

// ---------------------------------------------------------------- tracked screens

export interface Trade {
  index: number;
  input1: string;
  input2?: string;
  output: string;
  disabled: boolean;
  uses: number;
  maxUses: number;
  xp: number;
  specialPrice: number;
}

export interface RecipeEntry {
  /** A display id (1.21.2+), or the recipe's resource name before that. */
  id: number | string;
  kind: string;
  category: string;
  output: string;
}

export interface ChatEntry {
  id: number;
  at: number;
  text: string;
  parts: TextPart[];
}

interface GuiState {
  dialog: Dialog | null;
  dialogStack: Dialog[];
  signEditor: { x: number; y: number; z: number; front: boolean } | null;
  bookOpened: number | null;
  properties: Map<number, Map<number, number>>;
  trades: { windowId: number; trades: Trade[]; level: number } | null;
  recipes: Map<number | string, RecipeEntry>;
  chat: ChatEntry[];
  nextChatId: number;
}

const states = new WeakMap<object, GuiState>();
const CHAT_KEEP = 100;

function itemIdName(bot: Bot, id: number | undefined): string {
  if (id === undefined) return '?';
  return (bot.registry.items as Record<number, { name: string }>)[id]?.name ?? `item#${id}`;
}

function slotDisplayName(bot: Bot, display: AnyItem): string {
  if (!display || typeof display !== 'object') return '?';
  const type = String(display.type ?? '');
  const data = display.data;
  if (type === 'item') return itemIdName(bot, Number(data));
  if (type === 'item_stack') {
    const id = data?.itemId ?? data?.id ?? data?.item?.itemId ?? data?.item;
    const count = data?.itemCount ?? data?.count;
    return `${itemIdName(bot, typeof id === 'number' ? id : undefined)}${count && count > 1 ? ` x${count}` : ''}`;
  }
  if (type === 'tag') return `#${String(data)}`;
  if (type === 'with_remainder') return slotDisplayName(bot, data?.input);
  if (type === 'composite' && Array.isArray(data)) return data.map((d: AnyItem) => slotDisplayName(bot, d)).join(' | ');
  return type || '?';
}

/** Listens for the screens mineflayer does not keep: dialogs, sign editors, books, trades, the recipe book, chat events. */
export function attachGuiState(bot: Bot): GuiState {
  const existing = states.get(bot);
  if (existing) return existing;
  const state: GuiState = {
    dialog: null,
    dialogStack: [],
    signEditor: null,
    bookOpened: null,
    properties: new Map(),
    trades: null,
    recipes: new Map(),
    chat: [],
    nextChatId: 1
  };
  states.set(bot, state);
  const client = bot._client as unknown as { on(event: string, listener: (packet: AnyItem) => void): void };
  if (!client || typeof client.on !== 'function') return state;

  client.on('show_dialog', (packet) => {
    state.dialog = parseDialog(packet.dialog);
    state.dialogStack = [];
  });
  client.on('clear_dialog', () => {
    state.dialog = null;
    state.dialogStack = [];
  });
  client.on('open_sign_entity', (packet) => {
    const loc = packet.location ?? {};
    state.signEditor = { x: loc.x, y: loc.y, z: loc.z, front: packet.isFrontText !== false };
  });
  client.on('open_book', (packet) => {
    state.bookOpened = packet.hand === 'off_hand' || packet.hand === 1 ? 1 : 0;
  });
  client.on('craft_progress_bar', (packet) => {
    const windowId = Number(packet.windowId);
    if (!state.properties.has(windowId)) state.properties.set(windowId, new Map());
    state.properties.get(windowId)!.set(packet.property, packet.value);
  });
  client.on('open_window', () => {
    state.properties.clear();
  });
  client.on('trade_list', (packet) => {
    const Item = prismarineItem(bot.registry as never) as unknown as { fromNotch(n: unknown): AnyItem };
    const cost = (c: AnyItem) => (c ? `${itemIdName(bot, c.itemId)} x${c.itemCount}` : undefined);
    state.trades = {
      windowId: Number(packet.windowId),
      level: packet.villagerLevel,
      trades: (packet.trades ?? []).map((t: AnyItem, index: number) => ({
        index,
        input1: cost(t.inputItem1) ?? '?',
        ...(t.inputItem2 ? { input2: cost(t.inputItem2) } : {}),
        output: itemName(Item.fromNotch(t.outputItem)),
        disabled: !!t.tradeDisabled,
        uses: t.nbTradeUses,
        maxUses: t.maximumNbTradeUses,
        xp: t.xp,
        specialPrice: t.specialPrice
      }))
    };
  });
  client.on('recipe_book_add', (packet) => {
    if (packet.replace) state.recipes.clear();
    for (const entry of packet.entries ?? []) {
      const r = entry.recipe ?? entry;
      const display = r.display ?? {};
      state.recipes.set(r.displayId, {
        id: r.displayId,
        kind: String(display.type ?? '?'),
        category: String(r.category ?? '?'),
        output: slotDisplayName(bot, display.data?.result)
      });
    }
  });
  client.on('recipe_book_remove', (packet) => {
    for (const id of packet.recipeIds ?? []) state.recipes.delete(id);
  });
  // Before 1.21.2 the book is a list of recipe names: 0 init, 1 add, 2 remove.
  client.on('unlock_recipes', (packet) => {
    const names: string[] = packet.recipes1 ?? [];
    if (packet.action === 2) {
      for (const name of names) state.recipes.delete(name);
      return;
    }
    if (packet.action === 0) state.recipes.clear();
    for (const name of [...names, ...(Array.isArray(packet.recipes2) ? packet.recipes2 : [])]) {
      state.recipes.set(name, { id: name, kind: 'recipe', category: '-', output: name.replace(/^minecraft:/, '') });
    }
  });

  bot.on('message', (message: unknown) => {
    const json = (message as { json?: unknown }).json ?? message;
    const entry: ChatEntry = { id: state.nextChatId++, at: Date.now(), text: componentText(json), parts: componentParts(json) };
    state.chat.push(entry);
    if (state.chat.length > CHAT_KEEP) state.chat.splice(0, state.chat.length - CHAT_KEEP);
  });
  bot.on('windowClose' as never, (() => { state.trades = null; }) as never);
  return state;
}

export function guiState(bot: Bot): GuiState {
  return attachGuiState(bot);
}

export function windowProperties(bot: Bot): Map<number, number> {
  const window = activeWindow(bot);
  return guiState(bot).properties.get(window.id) ?? new Map();
}

// ---------------------------------------------------------------- the open window, as data

function windowType(window: AnyWindow): string {
  return String(window?.type ?? 'minecraft:inventory');
}

/** Names for window properties of the screens that have them. */
function propertyLabels(type: string): Record<number, string> {
  if (type.includes('enchant')) {
    return { 0: 'level cost (top)', 1: 'level cost (middle)', 2: 'level cost (bottom)', 3: 'enchantment seed', 4: 'enchantment id (top)', 5: 'enchantment id (middle)', 6: 'enchantment id (bottom)', 7: 'enchantment level (top)', 8: 'enchantment level (middle)', 9: 'enchantment level (bottom)' };
  }
  if (type.includes('beacon')) return { 0: 'power level', 1: 'primary effect', 2: 'secondary effect' };
  if (type.includes('anvil')) return { 0: 'repair cost (levels)' };
  if (type.includes('lectern')) return { 0: 'page' };
  if (type.includes('stonecutter')) return { 0: 'selected recipe' };
  if (type.includes('loom')) return { 0: 'selected pattern' };
  if (type.includes('furnace') || type.includes('smoker')) return { 0: 'fuel left', 1: 'max fuel', 2: 'progress', 3: 'max progress' };
  if (type.includes('brewing')) return { 0: 'brew time', 1: 'fuel' };
  return {};
}

export function describeWindow(bot: Bot, includeEmpty = false): string {
  const window = activeWindow(bot);
  const type = windowType(window);
  const title = window === bot.inventory ? 'Player inventory' : componentText(window.title);
  let out = `Window "${title}" (id ${window.id}, ${type}, ${window.slots.length} slots; container slots 0-${(window.inventoryStart ?? window.slots.length) - 1})\n`;
  out += `${describeCursor(bot)}\n`;
  const props = windowProperties(bot);
  if (props.size > 0) {
    const labels = propertyLabels(type);
    out += `Properties: ${[...props.entries()].map(([k, v]) => `${labels[k] ?? `#${k}`}=${v}`).join(', ')}\n`;
  }
  out += '\n';
  for (let slot = 0; slot < window.slots.length; slot++) {
    const item = window.slots[slot];
    if (!item) {
      if (includeEmpty) out += `Slot ${slot}: empty\n`;
      continue;
    }
    out += `Slot ${slot}: ${itemName(item)}\n`;
    const lore = loreOf(item).map(componentText);
    if (lore.length > 0) out += `  Lore: ${lore.join(' | ')}\n`;
    if (item.customModel !== null && item.customModel !== undefined) out += `  CustomModelData: ${item.customModel}\n`;
    for (const h of itemHovers(item)) out += `  Hover on "${h.text}": ${h.hover ?? ''}${h.click ? ` (click: ${h.click.action} ${h.click.value})` : ''}\n`;
  }
  return out.trim();
}

// ---------------------------------------------------------------- anvil

export async function anvilRename(bot: Bot, name: string, take = false): Promise<string> {
  const window = bot.currentWindow as AnyWindow;
  if (!window || !/anvil/.test(windowType(window))) throw new Error('No anvil is open; open one first (right-click it)');
  if (name.length > 50) throw new Error('Anvil names are at most 50 characters');
  if (!window.slots[0]) throw new Error('Put the item to rename in the anvil\'s first slot (slot 0) first');
  bot._client.write('name_item', { name });
  await new Promise((r) => setTimeout(r, 300));
  const result = window.slots[2];
  const cost = windowProperties(bot).get(0);
  let out = `Anvil name set to "${name}". Result slot 2: ${itemName(result)}${cost !== undefined ? `, cost ${cost} levels` : ''}.`;
  if (take) {
    if (!result) return `${out} Nothing to take: the server made no result (not enough levels, or the plugin refused).`;
    await clickRaw(bot, 2, 0, 1);
    out += ` Took it (shift click). ${describeCursor(bot)}`;
  }
  return out;
}

// ---------------------------------------------------------------- signs

export function writeSign(bot: Bot, lines: string[], opts: { x?: number; y?: number; z?: number; back?: boolean } = {}): string {
  if (lines.length > 4) throw new Error('A sign has 4 lines');
  const editor = guiState(bot).signEditor;
  const hasPos = opts.x !== undefined && opts.y !== undefined && opts.z !== undefined;
  const pos = hasPos ? new Vec3(opts.x!, opts.y!, opts.z!) : editor ? new Vec3(editor.x, editor.y, editor.z) : null;
  if (!pos) throw new Error('No sign editor is open and no position was given: give x, y, z, or open the sign first');
  const back = opts.back ?? (editor && !hasPos ? !editor.front : false);
  const text = [...lines, '', '', '', ''].slice(0, 4);
  bot._client.write('update_sign', {
    location: pos,
    isFrontText: !back,
    text1: text[0], text2: text[1], text3: text[2], text4: text[3]
  });
  guiState(bot).signEditor = null;
  const note = editor ? '' : ' No sign editor was open: vanilla accepts a sign only from the player it opened the editor for (on placing it or right-clicking it), so check it with sign-read.';
  return `Wrote the ${back ? 'back' : 'front'} of the sign at ${pos.x} ${pos.y} ${pos.z}: ${text.map((l) => `"${l}"`).join(', ')}.${note}`;
}

export function readSign(bot: Bot, x: number, y: number, z: number): string {
  const block = bot.blockAt(new Vec3(x, y, z)) as AnyItem;
  if (!block) throw new Error(`The block at ${x} ${y} ${z} is not loaded`);
  if (!/sign/.test(block.name)) throw new Error(`The block at ${x} ${y} ${z} is ${block.name}, not a sign`);
  const text = typeof block.getSignText === 'function' ? block.getSignText() : [];
  const [front, back] = Array.isArray(text) ? text : [String(text), ''];
  return `Sign at ${x} ${y} ${z} (${block.name}):\nFront: ${front || '(empty)'}\nBack: ${back || '(empty)'}`;
}

// ---------------------------------------------------------------- books

function componentOf(bot: Bot, item: AnyItem, type: string): AnyItem {
  return (item?.components ?? []).find((c: AnyItem) => c.type === type)?.data;
}

function pageText(page: unknown): string {
  if (page && typeof page === 'object' && 'content' in (page as object)) {
    const content = (page as { content: unknown }).content;
    return componentText(content && typeof content === 'object' && 'type' in (content as object) && 'value' in (content as object) ? simplifyNbt(content) : content);
  }
  return componentText(page);
}

function simplifyNbt(tag: unknown): unknown {
  // A text component sent as NBT inside an item component.
  const t = tag as { type: string; value: AnyItem };
  if (t.type === 'compound') return Object.fromEntries(Object.entries(t.value).map(([k, v]) => [k, simplifyNbt(v)]));
  if (t.type === 'list') return (t.value.value ?? []).map((v: unknown) => simplifyNbt({ type: t.value.type, value: v }));
  return t.value;
}

export interface BookPages {
  title?: string;
  author?: string;
  pages: string[];
  signed: boolean;
}

export function bookPages(bot: Bot, item: AnyItem): BookPages {
  if (!item) throw new Error('No book there');
  const written = componentOf(bot, item, 'written_book_content');
  if (written) {
    // 1.21.11 sends the title as a plain string; other versions as { content, filteredContent }.
    const raw = written.rawTitle ?? written.title;
    const title = typeof raw === 'string' ? raw : raw?.content ?? raw;
    return { title: componentText(title), author: written.author, pages: (written.pages ?? []).map(pageText), signed: true };
  }
  const writable = componentOf(bot, item, 'writable_book_content');
  if (writable) return { pages: (writable.pages ?? []).map(pageText), signed: false };
  const nbt = item.nbt?.value;
  if (nbt?.pages) {
    const pages = (nbt.pages.value?.value ?? []).map((p: string) => componentText(p));
    return { title: nbt.title?.value, author: nbt.author?.value, pages, signed: item.name === 'written_book' };
  }
  if (!/book/.test(item.name)) throw new Error(`${item.name} is not a book`);
  return { pages: [], signed: item.name === 'written_book' };
}

export function readBook(bot: Bot, opts: { slot?: number; page?: number } = {}): string {
  const state = guiState(bot);
  const window = bot.currentWindow as AnyWindow;
  let item: AnyItem;
  let where: string;
  if (opts.slot !== undefined) {
    item = activeWindow(bot).slots[opts.slot];
    where = `slot ${opts.slot}`;
  } else if (window && /lectern/.test(windowType(window))) {
    item = window.slots[0];
    where = 'the lectern';
  } else {
    const hand = state.bookOpened ?? 0;
    item = hand === 1 ? bot.inventory.slots[45] : bot.heldItem;
    where = hand === 1 ? 'the offhand' : 'the main hand';
  }
  const book = bookPages(bot, item);
  const lecternPage = window && /lectern/.test(windowType(window)) ? windowProperties(bot).get(0) : undefined;
  let out = `Book in ${where}: ${item.name}${book.title ? ` "${book.title}"` : ''}${book.author ? ` by ${book.author}` : ''}, ${book.pages.length} page(s)${lecternPage !== undefined ? `, the lectern shows page ${lecternPage + 1}` : ''}\n`;
  const pages = opts.page !== undefined ? [opts.page] : book.pages.map((_, i) => i + 1);
  for (const n of pages) {
    if (n < 1 || n > book.pages.length) throw new Error(`The book has pages 1-${book.pages.length}`);
    out += `\n--- Page ${n} ---\n${book.pages[n - 1]}\n`;
  }
  return out.trim();
}

export async function writeBook(bot: Bot, pages: string[], opts: { slot?: number; title?: string } = {}): Promise<string> {
  if (pages.length === 0 || pages.length > 100) throw new Error('A book has 1-100 pages');
  for (const p of pages) if (p.length > 1024) throw new Error('A page has at most 1024 characters');
  if (opts.title !== undefined && opts.title.length > 32) throw new Error('A title has at most 32 characters');
  let slot = opts.slot;
  if (slot === undefined) {
    const found = bot.inventory.slots.findIndex((it: AnyItem) => it && it.name === 'writable_book');
    if (found < 0) throw new Error('No book and quill in the inventory');
    slot = found;
  }
  if (opts.title !== undefined) {
    await (bot as Bot & { signBook(slot: number, pages: string[], author: string, title: string): Promise<void> }).signBook(slot, pages, bot.username, opts.title);
    return `Wrote ${pages.length} page(s) and signed the book "${opts.title}".`;
  }
  await bot.writeBook(slot, pages);
  return `Wrote ${pages.length} page(s) in the book (not signed).`;
}

// ---------------------------------------------------------------- container buttons

/** `enchant_item` (container_button_click): enchanting table 0-2, stonecutter and loom index, lectern 1-3 and 100+page. */
export async function pressButton(bot: Bot, button: number): Promise<string> {
  const window = bot.currentWindow as AnyWindow;
  if (!window) throw new Error('No screen is open');
  if (!Number.isInteger(button) || button < 0) throw new Error('A button id is a whole number from 0');
  const synced = waitForWindowItems(bot, window.id, 800);
  bot._client.write('enchant_item', { windowId: window.id, enchantment: button });
  await Promise.race([synced, new Promise((r) => setTimeout(r, 400))]);
  return `Pressed button ${button} in ${windowType(window)}.\n${describeWindow(bot)}`;
}

// ---------------------------------------------------------------- villagers

export function listTrades(bot: Bot): string {
  const trades = guiState(bot).trades;
  const window = bot.currentWindow as AnyWindow;
  if (!window || !/merchant|villager/.test(windowType(window)) || !trades) throw new Error('No trading screen is open; right-click a villager or wandering trader first');
  let out = `Trades (villager level ${trades.level}):\n`;
  for (const t of trades.trades) {
    out += `  ${t.index}: ${t.input1}${t.input2 ? ` + ${t.input2}` : ''} -> ${t.output}  uses ${t.uses}/${t.maxUses}${t.specialPrice ? `, price ${t.specialPrice > 0 ? '+' : ''}${t.specialPrice}` : ''}${t.disabled ? ' [out of stock]' : ''}\n`;
  }
  return out.trim();
}

/** Puts the cursor stack into the player-inventory part of the open window: onto the same item, else an empty slot. */
async function stowCursor(bot: Bot): Promise<void> {
  const window = activeWindow(bot);
  for (let tries = 0; tries < 3 && window.selectedItem; tries++) {
    const carried = window.selectedItem;
    const from = window.inventoryStart ?? 0;
    let target = -1;
    for (let slot = from; slot < window.slots.length; slot++) {
      const it = window.slots[slot];
      if (it && it.name === carried.name && it.count < (it.stackSize ?? 64)) { target = slot; break; }
    }
    if (target < 0) target = window.slots.findIndex((it: AnyItem, slot: number) => slot >= from && !it);
    if (target < 0) return;
    await clickRaw(bot, target, 0, 0);
  }
}

/**
 * Trades as the screen does: selecting the offer makes the server move the payment into slots 0 and 1, and
 * a click on the result takes one trade. `all` shift-clicks the result, which vanilla repeats while the
 * payment lasts.
 */
export async function trade(bot: Bot, index: number, times = 1, all = false): Promise<string> {
  const trades = guiState(bot).trades;
  const window = bot.currentWindow as AnyWindow;
  if (!window || !trades) throw new Error('No trading screen is open');
  const offer = trades.trades[index];
  if (!offer) throw new Error(`There is no trade ${index} (0-${trades.trades.length - 1})`);
  if (offer.disabled) throw new Error(`Trade ${index} is out of stock`);
  const label = `Trade ${index} (${offer.input1}${offer.input2 ? ` + ${offer.input2}` : ''} -> ${offer.output})`;
  const select = async () => {
    bot._client.write('select_trade', { slot: index });
    await new Promise((r) => setTimeout(r, 350));
  };
  if (all) {
    await select();
    if (!window.slots[2]) return `${label}: no result appeared (not enough payment, or out of stock).`;
    await clickRaw(bot, 2, 0, 1);
    return `${label}: took as many as the payment allows (shift click).`;
  }
  let done = 0;
  for (let i = 0; i < times; i++) {
    await select();
    const result = window.slots[2];
    if (!result) break;
    const cursor = window.selectedItem;
    if (cursor && (cursor.name !== result.name || cursor.count + result.count > (cursor.stackSize ?? 64))) {
      await stowCursor(bot);
      if (window.selectedItem) break;
    }
    await clickRaw(bot, 2, 0, 0);
    done++;
  }
  await stowCursor(bot);
  return `${label} done ${done} of ${times} time(s).${done < times ? ' It stopped: no result appeared (not enough payment, or out of stock).' : ''}`;
}

// ---------------------------------------------------------------- beacon

function effectId(bot: Bot, name: string): number {
  const wanted = name.replace(/^minecraft:/, '').replace(/[_\s]/g, '').toLowerCase();
  const effects = (bot.registry as unknown as { effectsArray: Array<{ id: number; name: string; displayName: string }> }).effectsArray;
  const found = effects.find((e) => e.name.replace(/[_\s]/g, '').toLowerCase() === wanted || e.displayName.replace(/[_\s]/g, '').toLowerCase() === wanted);
  if (!found) throw new Error(`Unknown effect "${name}"`);
  return found.id;
}

export function setBeaconEffect(bot: Bot, primary: string, secondary?: string): string {
  const window = bot.currentWindow as AnyWindow;
  if (!window || !/beacon/.test(windowType(window))) throw new Error('No beacon is open');
  if (!window.slots[0]) throw new Error('Put the payment (iron, gold, emerald, diamond or netherite ingot) in the beacon slot (slot 0) first');
  const p = effectId(bot, primary);
  const s = secondary ? effectId(bot, secondary) : undefined;
  bot._client.write('set_beacon_effect', { primary_effect: p, secondary_effect: s });
  // The vanilla screen closes itself after Done; the server has taken the payment by then.
  bot.closeWindow(window);
  return `Beacon set: primary ${primary}${secondary ? `, secondary ${secondary}` : ''}. The payment is used and the screen closed. The server keeps an effect only if the pyramid's level allows it (window property "power level").`;
}

// ---------------------------------------------------------------- recipe book

function atLeast(bot: Bot, version: string): boolean {
  const v = (bot.registry as unknown as { version?: { ['>=']?: (other: string) => boolean } }).version;
  return typeof v?.['>='] === 'function' ? v['>='](version) : true;
}

/** 1.21.2 numbered the recipe book (display ids); before it, recipes are sent by name. */
function newRecipeBook(bot: Bot): boolean {
  return atLeast(bot, '1.21.2');
}

export function listRecipes(bot: Bot, filter?: string): string {
  const recipes = [...guiState(bot).recipes.values()];
  const wanted = filter?.toLowerCase();
  const shown = wanted ? recipes.filter((r) => r.output.toLowerCase().includes(wanted)) : recipes;
  if (recipes.length === 0) return 'The recipe book is empty: the server has sent no recipes yet (they arrive at join and as they unlock).';
  const lines = shown.slice(0, 100).map((r) => `  ${r.id}: ${r.output} (${r.kind}, ${r.category})`);
  return `Recipe book: ${shown.length} of ${recipes.length} recipe(s)${wanted ? ` matching "${filter}"` : ''}${shown.length > 100 ? ', first 100' : ''}:\n${lines.join('\n')}`;
}

export async function placeRecipe(bot: Bot, recipe: number | string, all = false): Promise<string> {
  const window = activeWindow(bot);
  const byName = !newRecipeBook(bot);
  let id: number | string;
  if (typeof recipe === 'number') {
    if (byName) throw new Error('Before Minecraft 1.21.2 recipes are named, e.g. "minecraft:stick"');
    id = recipe;
  } else {
    const wanted = recipe.toLowerCase().replace(/^minecraft:/, '');
    const found = [...guiState(bot).recipes.values()].find((r) => r.output.toLowerCase().split(' ')[0] === wanted || String(r.id).toLowerCase() === recipe.toLowerCase());
    if (found) id = found.id;
    else if (byName) id = recipe.includes(':') ? recipe : `minecraft:${recipe}`;
    else throw new Error(`No recipe for "${recipe}" in the recipe book`);
  }
  const synced = waitForWindowItems(bot, window.id, 1000);
  bot._client.write('craft_recipe_request', byName
    ? { windowId: window.id, recipe: String(id), makeAll: all }
    : { windowId: window.id, recipeId: id, makeAll: all });
  await Promise.race([synced, new Promise((r) => setTimeout(r, 600))]);
  return `Placed recipe ${id}${all ? ' (as many as possible)' : ''} from the recipe book.\n${describeWindow(bot)}`;
}

// ---------------------------------------------------------------- creative

export async function creativeSetSlot(bot: Bot, slot: number, item: string | null, count = 1): Promise<string> {
  if (bot.game.gameMode !== 'creative') throw new Error(`Creative inventory needs creative mode (game mode: ${bot.game.gameMode})`);
  if (slot < 0 || slot > 44) throw new Error('Creative slots are the player inventory: 0-44 (5-8 armor, 9-35 main, 36-44 hotbar)');
  if (item === null) {
    await bot.creative.setInventorySlot(slot, null);
    return `Cleared slot ${slot}.`;
  }
  const def = bot.registry.itemsByName[item.replace(/^minecraft:/, '')];
  if (!def) throw new Error(`Unknown item "${item}"`);
  const Item = itemClass(bot);
  await bot.creative.setInventorySlot(slot, new Item(def.id, Math.max(1, Math.min(count, def.stackSize ?? 64))));
  return `Slot ${slot} now holds ${def.name} x${Math.max(1, Math.min(count, def.stackSize ?? 64))} (creative).`;
}

// ---------------------------------------------------------------- dialogs

export function readDialog(bot: Bot): string {
  const dialog = guiState(bot).dialog;
  if (!dialog) return 'No dialog is open.';
  return describeDialog(dialog);
}

export function currentDialog(bot: Bot): Dialog | null {
  return guiState(bot).dialog;
}

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

/**
 * The body of `custom_click_action`: the id, then the payload as network NBT prefixed by its length (an
 * empty payload is one TAG_End). minecraft-data describes the payload as an optional NBT without the length,
 * which a vanilla 1.21.11 server cannot decode, so the packet is written raw.
 */
export function customClickBody(id: string, nbt?: NbtTag): Buffer {
  const name = Buffer.from(id, 'utf8');
  const payload = nbt ? prismarineNbt.protos.big.createPacketBuffer('anonymousNbt', nbt) : Buffer.from([0]);
  if (payload.length > 65536) throw new Error('A custom click payload is at most 65536 bytes');
  return Buffer.concat([varint(name.length), name, varint(payload.length), payload]);
}

function packetId(bot: Bot, name: string): number {
  const packet = minecraftData(bot.version)?.protocol?.play?.toServer?.types?.packet as unknown as
    [string, Array<{ type: [string, { mappings: Record<string, string> }] }>] | undefined;
  const mappings = packet?.[1]?.[0]?.type?.[1]?.mappings ?? {};
  const hex = Object.entries(mappings).find(([, n]) => n === name)?.[0];
  if (hex === undefined) throw new Error(`Minecraft ${bot.version} has no ${name} packet`);
  return Number(hex);
}

function sendCustomClick(bot: Bot, id: string, nbt?: NbtTag): void {
  if (!atLeast(bot, '1.21.6')) throw new Error('Custom click actions need Minecraft 1.21.6 or newer');
  const client = bot._client as unknown as { writeRaw(buffer: Buffer): void };
  client.writeRaw(Buffer.concat([varint(packetId(bot, 'custom_click_action')), customClickBody(id, nbt)]));
}

async function applyEffect(bot: Bot, effect: DialogEffect, closeAfter: boolean): Promise<string> {
  const state = guiState(bot);
  switch (effect.kind) {
    case 'command':
      bot.chat(effect.command.startsWith('/') ? effect.command : `/${effect.command}`);
      if (closeAfter) state.dialog = null;
      return `Ran ${effect.command.startsWith('/') ? effect.command : `/${effect.command}`}`;
    case 'custom':
      sendCustomClick(bot, effect.id, effect.nbt);
      if (closeAfter) state.dialog = null;
      return `Sent custom click ${effect.id}${effect.nbt ? ` with ${JSON.stringify(simplifyNbt(effect.nbt))}` : ''}`;
    case 'dialog':
      if (state.dialog) state.dialogStack.push(state.dialog);
      state.dialog = parseDialog(effect.dialog);
      return `Opened the dialog "${state.dialog.title}"`;
    case 'info':
      if (closeAfter) state.dialog = null;
      return `The button does ${effect.action}: ${effect.value} (a client-side action; the server is told nothing)`;
    case 'close':
      state.dialog = state.dialogStack.pop() ?? null;
      return 'Closed the dialog';
  }
}

export async function respondDialog(bot: Bot, opts: { button?: number | string; inputs?: Record<string, unknown>; exit?: boolean }): Promise<string> {
  const state = guiState(bot);
  const dialog = state.dialog;
  if (!dialog) throw new Error('No dialog is open');
  let button: Dialog['buttons'][number] | undefined;
  if (opts.exit) {
    if (!dialog.exit && !dialog.canCloseWithEscape) throw new Error('This dialog has no exit and cannot be closed with Escape');
    button = dialog.exit ?? { label: 'Escape' };
  } else if (typeof opts.button === 'number') {
    button = dialog.buttons[opts.button];
    if (!button) throw new Error(`The dialog has buttons 0-${dialog.buttons.length - 1}`);
  } else if (typeof opts.button === 'string') {
    const label = opts.button.toLowerCase();
    button = dialog.buttons.find((b) => b.label.toLowerCase() === label) ?? dialog.buttons.find((b) => b.label.toLowerCase().includes(label));
    if (!button) throw new Error(`No button labelled "${opts.button}" (buttons: ${dialog.buttons.map((b) => b.label).join(', ')})`);
  } else {
    throw new Error('Give a button (index or label), or exit: true');
  }
  const effect = dialogEffect(dialog, button, opts.inputs);
  const done = await applyEffect(bot, effect, dialog.afterAction !== 'none');
  const after = state.dialog ? `\n\nNow open:\n${describeDialog(state.dialog)}` : '';
  return `Pressed "${button.label}". ${done}.${dialog.afterAction === 'wait_for_response' && effect.kind !== 'dialog' ? ' The dialog waits for the server\'s answer.' : ''}${after}`;
}

// ---------------------------------------------------------------- clickable chat

export function chatActions(bot: Bot, opts: { limit?: number; contains?: string; all?: boolean } = {}): string {
  const chat = guiState(bot).chat;
  const wanted = opts.contains?.toLowerCase();
  const picked = chat.filter((m) => (opts.all || m.parts.some((p) => p.click || p.hover !== undefined)) && (!wanted || m.text.toLowerCase().includes(wanted)));
  const shown = picked.slice(-(opts.limit ?? 10));
  if (shown.length === 0) return wanted ? `No recent message with clickable or hover text contains "${opts.contains}".` : 'No recent message has clickable or hover text.';
  let out = '';
  for (const m of shown) {
    out += `Message ${m.id}: ${m.text}\n`;
    m.parts.forEach((p, i) => {
      if (!p.click && p.hover === undefined) return;
      out += `  part ${i}: "${p.text}"${p.click ? ` click: ${p.click.action} ${p.click.value}` : ''}${p.hover !== undefined ? ` hover: ${p.hover}` : ''}\n`;
    });
  }
  return out.trim();
}

function findChatPart(bot: Bot, opts: { message?: number; part?: number; contains?: string }): { entry: ChatEntry; part: TextPart } {
  const chat = guiState(bot).chat;
  let entry: ChatEntry | undefined;
  if (opts.message !== undefined) entry = chat.find((m) => m.id === opts.message);
  else {
    const wanted = opts.contains?.toLowerCase();
    entry = [...chat].reverse().find((m) => m.parts.some((p) => p.click && (!wanted || p.text.toLowerCase().includes(wanted) || m.text.toLowerCase().includes(wanted))));
  }
  if (!entry) throw new Error(opts.message !== undefined ? `No message ${opts.message} in the last ${CHAT_KEEP}` : 'No recent message has a clickable part' + (opts.contains ? ` matching "${opts.contains}"` : ''));
  let part: TextPart | undefined;
  if (opts.part !== undefined) part = entry.parts[opts.part];
  else {
    const wanted = opts.contains?.toLowerCase();
    part = entry.parts.find((p) => p.click && wanted && p.text.toLowerCase().includes(wanted)) ?? entry.parts.find((p) => p.click);
  }
  if (!part?.click) throw new Error(`That part of message ${entry.id} has no click action`);
  return { entry, part };
}

export async function clickChat(bot: Bot, opts: { message?: number; part?: number; contains?: string; send?: string }): Promise<string> {
  const { entry, part } = findChatPart(bot, opts);
  const click = part.click as ClickAction;
  switch (click.action) {
    case 'run_command': {
      // 1.21.5+ commands need no slash; the game runs them as commands either way.
      const command = click.value.startsWith('/') ? click.value : `/${click.value}`;
      bot.chat(command);
      return `Clicked "${part.text}" in message ${entry.id}: ran ${command}`;
    }
    case 'suggest_command': {
      if (opts.send !== undefined) {
        bot.chat(opts.send);
        return `Clicked "${part.text}": the game would put "${click.value}" in the chat box; sent "${opts.send}"`;
      }
      return `Clicked "${part.text}": the game puts "${click.value}" in the chat box. Nothing was sent; call again with send to send it (edited or not).`;
    }
    case 'custom':
      sendCustomClick(bot, click.value, click.payload === undefined ? undefined : jsonToNbt(click.payload));
      return `Clicked "${part.text}": sent custom click ${click.value}`;
    case 'show_dialog': {
      const state = guiState(bot);
      state.dialog = parseDialog(click.payload);
      state.dialogStack = [];
      return `Clicked "${part.text}": it opens a dialog.\n\n${describeDialog(state.dialog)}`;
    }
    default:
      return `Clicked "${part.text}": ${click.action} ${click.value} (a client-side action; the server is told nothing)`;
  }
}
