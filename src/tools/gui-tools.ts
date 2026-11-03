import { z } from 'zod';
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import {
  CLICK_TYPES, CLICK_TYPE_NAMES, DRAG_BUTTONS, anvilRename, chatActions, clickChat, clickSlot, creativeSetSlot,
  describeWindow, dragSlots, listRecipes, listTrades, placeRecipe, pressButton, readBook, readDialog, readSign,
  respondDialog, setBeaconEffect, trade, writeBook, writeSign, type ClickType, type DragButton
} from '../gui/gui-core.js';

const clickHelp = Object.entries(CLICK_TYPES).map(([name, c]) => `${name}: ${c.does}`).join('; ');
const dragHelp = Object.entries(DRAG_BUTTONS).map(([name, d]) => `${name}: ${d.does}`).join('; ');

/**
 * Every screen and click a player has: the click types of the container screen, drags, anvil, sign,
 * book, lectern, villager, enchanting, stonecutter, loom, beacon, recipe book, creative inventory,
 * dialogs and clickable chat. Each is sent with the game's own packets.
 */
export function registerGuiTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    'window-state',
    'The open screen as data: type, every slot with name, lore and hover texts, the item on the cursor, and the screen\'s properties (enchanting costs, anvil cost, lectern page, ...). With no screen open, the player inventory.',
    { includeEmpty: z.boolean().optional().describe('List empty slots too') },
    async ({ includeEmpty }: { includeEmpty?: boolean }) => factory.createResponse(describeWindow(getBot(), includeEmpty ?? false))
  );

  factory.registerTool(
    'window-click',
    `Click a slot of the open screen (or of the player inventory) the way a player does, so plugins see the same click type. Types: ${clickHelp}.`,
    {
      type: z.enum(CLICK_TYPE_NAMES).describe('The click'),
      slot: z.coerce.number().int().optional().describe('The slot (window-state lists them); not for outside_left / outside_right'),
      hotbar: z.coerce.number().int().min(1).max(9).optional().describe('For type number: the key, 1-9')
    },
    async ({ type, slot, hotbar }: { type: ClickType; slot?: number; hotbar?: number }) =>
      factory.createResponse(await clickSlot(getBot(), { type, slot, hotbar }))
  );

  factory.registerTool(
    'window-drag',
    `Drag the cursor stack over slots (QUICK_CRAFT), as holding a mouse button and moving over them does. Buttons: ${dragHelp}.`,
    {
      slots: z.array(z.coerce.number().int()).min(1).describe('The slots, in order'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Default left')
    },
    async ({ slots, button }: { slots: number[]; button?: DragButton }) => factory.createResponse(await dragSlots(getBot(), slots, button ?? 'left'))
  );

  factory.registerTool(
    'window-button',
    'Press a button of the open screen (container_button_click): enchanting table 0-2 (top, middle, bottom), stonecutter recipe index, loom pattern index, lectern 1 previous page, 2 next page, 3 take the book, 100+N go to page N.',
    { button: z.coerce.number().int().min(0).describe('The button id') },
    async ({ button }: { button: number }) => factory.createResponse(await pressButton(getBot(), button))
  );

  factory.registerTool(
    'anvil-rename',
    'Type a name in the open anvil (the item to rename must be in slot 0). Plugins that read the anvil text, such as search and input menus, get it. take: shift-click the result.',
    {
      name: z.string().max(50).describe('The name'),
      take: z.boolean().optional().describe('Take the result (default false)')
    },
    async ({ name, take }: { name: string; take?: boolean }) => factory.createResponse(await anvilRename(getBot(), name, take ?? false))
  );

  factory.registerTool(
    'sign-write',
    'Answer the sign editor the server opened (after placing or right-clicking a sign, or a plugin\'s sign input menu): the side it opened, unless back is given. The server accepts a sign only while it has opened the editor for this player; a position without an open editor is sent but vanilla ignores it.',
    {
      lines: z.array(z.string().max(90)).max(4).describe('Up to 4 lines'),
      back: z.boolean().optional().describe('The back side (default: the side the editor opened, else front)'),
      x: z.coerce.number().int().optional(),
      y: z.coerce.number().int().optional(),
      z: z.coerce.number().int().optional()
    },
    async (args: { lines: string[]; back?: boolean; x?: number; y?: number; z?: number }) => factory.createResponse(writeSign(getBot(), args.lines, args))
  );

  factory.registerTool(
    'sign-read',
    'Read both sides of a sign.',
    { x: z.coerce.number().int(), y: z.coerce.number().int(), z: z.coerce.number().int() },
    async ({ x, y, z: zz }: { x: number; y: number; z: number }) => factory.createResponse(readSign(getBot(), x, y, zz))
  );

  factory.registerTool(
    'book-read',
    'Read a book: in a slot, on the open lectern, or the one in hand (or the one the server opened). page reads one page (from 1). Turn a lectern\'s page with window-button.',
    {
      slot: z.coerce.number().int().optional().describe('A slot of the open window or the inventory'),
      page: z.coerce.number().int().min(1).optional().describe('Only this page')
    },
    async ({ slot, page }: { slot?: number; page?: number }) => factory.createResponse(readBook(getBot(), { slot, page }))
  );

  factory.registerTool(
    'book-write',
    'Write pages in a book and quill; with title, sign it (it becomes a written book).',
    {
      pages: z.array(z.string().max(1024)).min(1).max(100),
      title: z.string().max(32).optional().describe('Sign the book with this title'),
      slot: z.coerce.number().int().optional().describe('The book\'s inventory slot (default: the first book and quill)')
    },
    async ({ pages, title, slot }: { pages: string[]; title?: string; slot?: number }) => factory.createResponse(await writeBook(getBot(), pages, { title, slot }))
  );

  factory.registerTool(
    'villager-trades',
    'List the offers of the open trading screen (villager or wandering trader).',
    {},
    async () => factory.createResponse(listTrades(getBot()))
  );

  factory.registerTool(
    'villager-trade',
    'Trade: select an offer (the server moves the payment from the inventory, as the screen does) and click the result, times times; the items go to the inventory. all: shift-click, as many as the payment allows.',
    {
      index: z.coerce.number().int().min(0).describe('The offer, from villager-trades'),
      times: z.coerce.number().int().min(1).max(64).optional().describe('Default 1'),
      all: z.boolean().optional().describe('Shift-click the result: trade as long as the payment lasts')
    },
    async ({ index, times, all }: { index: number; times?: number; all?: boolean }) => factory.createResponse(await trade(getBot(), index, times ?? 1, all ?? false))
  );

  factory.registerTool(
    'beacon-set-effect',
    'Choose the effects of the open beacon (payment item in slot 0), e.g. speed, haste, resistance, jump_boost, strength; secondary regeneration or the primary again for level II.',
    { primary: z.string(), secondary: z.string().optional() },
    async ({ primary, secondary }: { primary: string; secondary?: string }) => factory.createResponse(setBeaconEffect(getBot(), primary, secondary))
  );

  factory.registerTool(
    'recipe-book',
    'List the recipes the server put in the bot\'s recipe book, with the ids recipe-place takes. filter matches the output item.',
    { filter: z.string().optional() },
    async ({ filter }: { filter?: string }) => factory.createResponse(listRecipes(getBot(), filter))
  );

  factory.registerTool(
    'recipe-place',
    'Click a recipe in the recipe book: the server fills the crafting grid (or furnace) from the inventory. Works in the inventory\'s 2x2 grid, a crafting table or a furnace. all: as many as possible (shift-click).',
    {
      recipe: z.union([z.coerce.number().int(), z.string()]).describe('A recipe id from recipe-book, or an output item name'),
      all: z.boolean().optional()
    },
    async ({ recipe, all }: { recipe: number | string; all?: boolean }) => factory.createResponse(await placeRecipe(getBot(), recipe, all ?? false))
  );

  factory.registerTool(
    'creative-set-slot',
    'Creative inventory: put any item in an inventory slot (0-44; 36-44 hotbar), as taking it from a creative tab does. No item clears the slot. Needs creative mode.',
    {
      slot: z.coerce.number().int().min(0).max(44),
      item: z.string().optional().describe('Item name, e.g. diamond_sword'),
      count: z.coerce.number().int().min(1).max(64).optional()
    },
    async ({ slot, item, count }: { slot: number; item?: string; count?: number }) => factory.createResponse(await creativeSetSlot(getBot(), slot, item ?? null, count ?? 1))
  );

  factory.registerTool(
    'dialog-read',
    'The dialog the server shows (Minecraft 1.21.6+, Paper\'s Dialog API): title, body, inputs with their keys and limits, and the buttons with what each does.',
    {},
    async () => factory.createResponse(readDialog(getBot()))
  );

  factory.registerTool(
    'dialog-respond',
    'Press a dialog button with the inputs filled in: commands run, custom actions go to the server (custom_click_action), a button that opens another dialog opens it. exit: the exit button or Escape.',
    {
      button: z.union([z.coerce.number().int().min(0), z.string()]).optional().describe('Button index or label'),
      inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Input values by key; the rest keep their initial value'),
      exit: z.boolean().optional()
    },
    async (args: { button?: number | string; inputs?: Record<string, unknown>; exit?: boolean }) => factory.createResponse(await respondDialog(getBot(), args))
  );

  factory.registerTool(
    'chat-actions',
    'Recent chat messages with clickable or hover text: each part, its click (run_command, suggest_command, open_url, copy_to_clipboard, show_dialog, custom) and hover text, with the ids chat-click takes.',
    {
      contains: z.string().optional().describe('Only messages containing this'),
      limit: z.coerce.number().int().min(1).max(100).optional().describe('Default 10'),
      all: z.boolean().optional().describe('Messages with no click or hover too')
    },
    async (args: { contains?: string; limit?: number; all?: boolean }) => factory.createResponse(chatActions(getBot(), args))
  );

  factory.registerTool(
    'chat-click',
    'Click a part of a chat message, as a player clicks [Accept] or [Buy]: run_command runs it, custom goes to the server, show_dialog opens the dialog, suggest_command only shows the text unless send is given. Without message, the newest clickable part (matching contains).',
    {
      message: z.coerce.number().int().optional().describe('Message id from chat-actions'),
      part: z.coerce.number().int().optional().describe('Part index from chat-actions'),
      contains: z.string().optional().describe('Pick the part whose text contains this'),
      send: z.string().optional().describe('For suggest_command: the text to send')
    },
    async (args: { message?: number; part?: number; contains?: string; send?: string }) => factory.createResponse(await clickChat(getBot(), args))
  );
}
