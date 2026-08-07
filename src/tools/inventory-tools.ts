import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

interface InventoryItem {
  name: string;
  count: number;
  slot: number;
}

export function registerInventoryTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const items = bot.inventory.items();
      const itemList: InventoryItem[] = items.map((item) => ({
        name: item.name,
        count: item.count,
        slot: item.slot
      }));

      if (items.length === 0) {
        return factory.createResponse("Inventory is empty");
      }

      let inventoryText = `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach(item => {
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}\n`;
      });

      return factory.createResponse(inventoryText);
    }
  );

  factory.registerTool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find")
    },
    async ({ nameOrType }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(nameOrType.toLowerCase())
      );

      if (item) {
        return factory.createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})`);
      } else {
        return factory.createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
      }
    }
  );

  factory.registerTool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(itemName.toLowerCase())
      );

      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      return factory.createResponse(`Equipped ${item.name} to ${destination}`);
    }
  );

  factory.registerTool(
    "use-item",
    "Use the currently held item, the same as right-clicking it. Opens hub menus and other item-triggered GUIs",
    {
      offHand: z.boolean().optional().describe("Use the off-hand item instead of the main hand (default: false)"),
      waitForWindowMs: z.number().optional().describe("How long to wait for a GUI window to open, in ms (default: 1500)")
    },
    async ({ offHand = false, waitForWindowMs = 1500 }) => {
      const bot = getBot();
      const held = offHand ? bot.inventory.slots[45] : bot.heldItem;

      if (!held) {
        return factory.createResponse(`Nothing is held in the ${offHand ? 'off hand' : 'main hand'}. Use equip-item first.`);
      }

      const opened = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          bot.removeListener('windowOpen', onOpen);
          resolve(null);
        }, waitForWindowMs);

        function onOpen(window: { title?: unknown }): void {
          clearTimeout(timer);
          resolve(chatToMotd(window.title));
        }

        bot.once('windowOpen', onOpen);
      });

      bot.activateItem(offHand);
      const title = await opened;

      if (title === null) {
        return factory.createResponse(`Used ${held.name}. No window opened within ${waitForWindowMs}ms.`);
      }

      return factory.createResponse(`Used ${held.name}. Window "${title}" opened — use read-window or render-window to inspect it.`);
    }
  );
}

function chatToMotd(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const maybeChat = value as { toMotd?: () => string; text?: unknown };
    if (typeof maybeChat.toMotd === 'function') {
      return maybeChat.toMotd();
    }
    if (typeof maybeChat.text === 'string') {
      return maybeChat.text;
    }
  }
  return String(value ?? '');
}
