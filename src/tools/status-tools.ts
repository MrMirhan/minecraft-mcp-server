import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

const VITALS_SCALE_MAX = 20;
const INVENTORY_SUMMARY_LIMIT = 8;
const NEARBY_PLAYERS_LIMIT = 5;

function summarizeInventory(bot: mineflayer.Bot): string {
  const items = bot.inventory.items();

  if (items.length === 0) {
    return 'empty';
  }

  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }

  const entries = [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const shown = entries.slice(0, INVENTORY_SUMMARY_LIMIT);
  const shownText = shown.map((entry) => `${entry.name} x${entry.count}`).join(', ');
  const remaining = entries.length - shown.length;
  const remainingText = remaining > 0 ? `, +${remaining} more type(s)` : '';

  return `${shownText}${remainingText} (${bot.inventory.emptySlotCount()} free slots)`;
}

function summarizeNearbyPlayers(bot: mineflayer.Bot): string {
  const selfPos = bot.entity.position;

  const others = Object.values(bot.players)
    .filter((player) => player.username !== bot.username && player.entity)
    .map((player) => ({
      username: player.username,
      distance: selfPos.distanceTo(player.entity.position)
    }))
    .sort((a, b) => a.distance - b.distance);

  if (others.length === 0) {
    return 'none';
  }

  const shown = others.slice(0, NEARBY_PLAYERS_LIMIT);
  const shownText = shown.map((entry) => `${entry.username} (${entry.distance.toFixed(1)}m)`).join(', ');
  const remaining = others.length - shown.length;
  const remainingText = remaining > 0 ? `, +${remaining} more` : '';

  return `${shownText}${remainingText}`;
}

function describeBiome(bot: mineflayer.Bot): string {
  const block = bot.blockAt(bot.entity.position);
  if (!block) {
    return 'unknown';
  }
  return block.biome.displayName || block.biome.name || 'unknown';
}

function describeWeather(bot: mineflayer.Bot): string {
  if (bot.thunderState > 0) {
    return 'thunder';
  }
  return bot.isRaining ? 'rain' : 'clear';
}

function describeHeldItem(bot: mineflayer.Bot): string {
  return bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : 'none';
}

export function registerStatusTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-status",
    "Get a single compact summary of everything needed to orient: position, vitals, environment, held item, inventory and nearby players",
    {},
    async () => {
      const bot = getBot();
      const pos = bot.entity.position;

      const lines = [
        `Position: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}) | Dimension: ${bot.game.dimension} | Biome: ${describeBiome(bot)}`,
        `Health: ${bot.health}/${VITALS_SCALE_MAX} | Food: ${bot.food}/${VITALS_SCALE_MAX} | Oxygen: ${bot.oxygenLevel}/${VITALS_SCALE_MAX}`,
        `Gamemode: ${bot.game.gameMode} | Time: ${bot.time.timeOfDay} (${bot.time.isDay ? 'day' : 'night'}) | Weather: ${describeWeather(bot)}`,
        `Held item: ${describeHeldItem(bot)}`,
        `Inventory: ${summarizeInventory(bot)}`,
        `Nearby players: ${summarizeNearbyPlayers(bot)}`
      ];

      return factory.createResponse(lines.join('\n'));
    }
  );
}
