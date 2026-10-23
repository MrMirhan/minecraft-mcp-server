import mineflayer from 'mineflayer';
import type { Scenario, ScenarioBot, ScenarioWindow } from './runner.js';

/** Window titles and lore arrive as chat JSON; scenarios compare plain text. */
function plain(text: unknown): string {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') return flatten(text);
  try {
    return flatten(JSON.parse(text));
  } catch {
    return text;
  }
}

function flatten(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (node && typeof node === 'object') {
    const o = node as { text?: unknown; translate?: unknown; extra?: unknown[]; value?: unknown };
    return `${typeof o.text === 'string' ? o.text : typeof o.translate === 'string' ? o.translate : ''}${o.extra ? o.extra.map(flatten).join('') : ''}`;
  }
  return String(node);
}

/** A mineflayer bot seen through the small interface scenarios use (offline-mode login). */
export function mineflayerScenarioBot(name: string, server: Scenario['server']): ScenarioBot {
  const bot = mineflayer.createBot({ host: server.host, port: server.port, username: name, auth: 'offline' });
  const view = {
    get username() { return bot.username; },
    get currentWindow(): ScenarioWindow | null {
      const w = bot.currentWindow;
      if (!w) return null;
      return {
        title: plain(w.title),
        slots: w.slots.map((item) => item ? {
          name: item.name,
          displayName: item.customName ? plain(item.customName) : item.displayName,
          lore: (Array.isArray(item.customLore) ? item.customLore : item.customLore ? [item.customLore] : []).map(plain)
        } : null)
      };
    },
    chat: (line: string) => bot.chat(line),
    activateItem: () => bot.activateItem(),
    clickWindow: async (slot: number, button: number, mode: number) => { await bot.clickWindow(slot, button, mode); },
    closeWindow: () => { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); },
    quit: () => bot.quit(),
    on: (event: string, listener: (...args: unknown[]) => void) => bot.on(event as never, listener as never),
    once: (event: string, listener: (...args: unknown[]) => void) => bot.once(event as never, listener as never),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => bot.removeListener(event as never, listener as never)
  };
  return view as ScenarioBot;
}
