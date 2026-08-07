import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
// Shared with the live viewer, and wired at bot creation so events that fire before the
// first tool call (the server sends the resource pack at join time) are not missed.
import { getUiState } from '../web-viewer.js';

// mineflayer's ScoreBoard.setTitle only unwraps a JSON string title. On 1.21.x the title
// arrives as a component object, which falls through as-is and stringifies to [object Object].
function chatToMotd(value: unknown): string {
  if (typeof value === 'string') {
    return extractText(value);
  }
  if (value && typeof value === 'object') {
    const maybeChat = value as { toMotd?: () => string; text?: unknown };
    if (typeof maybeChat.toMotd === 'function') {
      return maybeChat.toMotd();
    }
    if (typeof maybeChat.text === 'string') {
      return maybeChat.text;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function extractText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (parsed && typeof parsed === 'object' && 'text' in parsed && typeof (parsed as { text: unknown }).text === 'string') {
      return (parsed as { text: string }).text;
    }
  } catch {
    // raw is a plain legacy string, not JSON text component — use as-is
  }
  return raw;
}

function loreLines(lore: string | string[] | null): string[] {
  if (!lore) {
    return [];
  }
  const lines = Array.isArray(lore) ? lore : lore.split('\n');
  return lines.map(extractText);
}

export function registerUiTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "read-scoreboard",
    "Read the sidebar, list, and below-name scoreboards",
    {},
    async () => {
      const bot = getBot();
      const positions = [
        { label: 'Sidebar', scoreboard: bot.scoreboard.sidebar },
        { label: 'List', scoreboard: bot.scoreboard.list },
        { label: 'Below name', scoreboard: bot.scoreboard.belowName }
      ];
      const active = positions.filter((position) => position.scoreboard);

      if (active.length === 0) {
        return factory.createResponse("No scoreboard is currently displayed");
      }

      let output = '';
      for (const { label, scoreboard } of active) {
        output += `${label}: ${chatToMotd(scoreboard.title)}\n`;
        for (const item of scoreboard.items) {
          const line = item.displayName ? item.displayName.toMotd() : item.name;
          output += `  ${line}: ${item.value}\n`;
        }
      }

      return factory.createResponse(output.trim());
    }
  );

  factory.registerTool(
    "read-window",
    "Read the currently open GUI window's items",
    {},
    async () => {
      const bot = getBot();
      const window = bot.currentWindow;

      if (!window) {
        return factory.createResponse("No window is currently open");
      }

      let output = `Window "${window.title}":\n\n`;
      let itemCount = 0;

      for (let slot = 0; slot < window.slots.length; slot++) {
        const item = window.slots[slot];
        if (!item) {
          continue;
        }

        itemCount++;
        const displayName = item.customName ? extractText(item.customName) : item.displayName;
        output += `Slot ${slot}: ${item.name} x${item.count}\n`;
        output += `  Display name: ${displayName}\n`;

        const lore = loreLines(item.customLore);
        if (lore.length > 0) {
          output += `  Lore: ${lore.join(' | ')}\n`;
        }

        if (item.customModel !== null) {
          output += `  CustomModelData: ${item.customModel}\n`;
        }
      }

      if (itemCount === 0) {
        return factory.createResponse(`Window "${window.title}" is open but has no items`);
      }

      return factory.createResponse(output.trim());
    }
  );

  factory.registerTool(
    "read-tablist",
    "Read the tab list header and footer",
    {},
    async () => {
      const bot = getBot();
      const header = bot.tablist.header.toMotd();
      const footer = bot.tablist.footer.toMotd();

      if (!header && !footer) {
        return factory.createResponse("No tab list header or footer is set");
      }

      return factory.createResponse(`Header: ${header || '(empty)'}\nFooter: ${footer || '(empty)'}`);
    }
  );

  factory.registerTool(
    "read-bossbar",
    "Read all active boss bars",
    {},
    async () => {
      const bot = getBot() as mineflayer.Bot & { bossBars: mineflayer.BossBar[] };
      const bars = bot.bossBars;

      if (bars.length === 0) {
        return factory.createResponse("No boss bars are currently active");
      }

      let output = `Found ${bars.length} boss bar(s):\n\n`;
      for (const bar of bars) {
        output += `${bar.title.toMotd()} - color: ${bar.color}, progress: ${bar.health}\n`;
      }

      return factory.createResponse(output.trim());
    }
  );

  factory.registerTool(
    "read-title",
    "Read the most recently shown title, subtitle, and action bar",
    {},
    async () => {
      const bot = getBot();
      const state = getUiState(bot).title;

      if (state.title === null && state.subtitle === null && state.actionBar === null) {
        return factory.createResponse("No title, subtitle, or action bar has been shown yet");
      }

      let output = 'Most recent title state:\n\n';
      output += `Title: ${state.title ?? '(none)'}\n`;
      output += `Subtitle: ${state.subtitle ?? '(none)'}\n`;
      output += `Action bar: ${state.actionBar ?? '(none)'}\n`;

      return factory.createResponse(output.trim());
    }
  );

  factory.registerTool(
    "read-teams",
    "Read all scoreboard teams and their members",
    {},
    async () => {
      const bot = getBot();
      const teams = Object.values(bot.teams);

      if (teams.length === 0) {
        return factory.createResponse("No teams are currently registered");
      }

      let output = `Found ${teams.length} team(s):\n\n`;
      for (const team of teams) {
        output += `Team "${team.team}" (color: ${team.color}):\n`;
        output += `  Prefix: ${team.prefix.toMotd()}\n`;
        output += `  Suffix: ${team.suffix.toMotd()}\n`;
        output += `  Members: ${team.members.length > 0 ? team.members.join(', ') : '(none)'}\n\n`;
      }

      return factory.createResponse(output.trim());
    }
  );

  factory.registerTool(
    "get-resource-pack",
    "Get the resource pack sent by the server, if any",
    {},
    async () => {
      const bot = getBot();
      const resourcePack = getUiState(bot).resourcePack;

      if (!resourcePack) {
        return factory.createResponse("No resource pack has been sent by the server");
      }

      return factory.createResponse(`Resource pack URL: ${resourcePack.url}\nHash: ${resourcePack.hash}`);
    }
  );
}
