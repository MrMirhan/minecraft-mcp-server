/**
 * Text components as the server sends them: a string, a JSON string, a component object (1.20.3+ NBT is
 * already turned into one by mineflayer), or a list of them. Readers here see plain text, and the parts
 * a player could click or hover.
 */

export interface ClickAction {
  /** run_command, suggest_command, open_url, copy_to_clipboard, change_page, show_dialog or custom. */
  action: string;
  /** The command, URL, text to copy or page; for custom, the id. */
  value: string;
  /** custom: the payload, as JSON. show_dialog: the dialog. */
  payload?: unknown;
}

export interface TextPart {
  text: string;
  click?: ClickAction;
  /** What the game shows when the mouse is over the part (show_text, show_item or show_entity). */
  hover?: string;
}

function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function strip(id: string): string {
  return id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id;
}

/** The plain text of a component. */
export function componentText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') {
    const parsed = parseJson(node);
    return typeof parsed === 'string' ? parsed : componentText(parsed);
  }
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(componentText).join('');
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    // A component object from prismarine-chat already knows how to render translations.
    if (typeof (o as { toString?: unknown }).toString === 'function' && 'json' in o && typeof (o as { json?: unknown }).json === 'object') {
      return componentText((o as { json: unknown }).json);
    }
    let own = '';
    if (typeof o.text === 'string' || typeof o.text === 'number') own = String(o.text);
    else if (typeof o[''] === 'string') own = o[''] as string;
    else if (typeof o.translate === 'string') {
      const args = (Array.isArray(o.with) ? o.with : []).map(componentText);
      own = args.length > 0 ? `${o.translate} ${args.join(' ')}`.trim() : (typeof o.fallback === 'string' ? o.fallback : o.translate);
    } else if (typeof o.keybind === 'string') own = o.keybind;
    else if (o.score && typeof o.score === 'object') own = String((o.score as { value?: unknown }).value ?? '');
    else if (typeof o.selector === 'string') own = o.selector;
    const extra = Array.isArray(o.extra) ? o.extra.map(componentText).join('') : '';
    return own + extra;
  }
  return String(node);
}

/** The click event of a component node: 1.21.5+ `click_event`, or the older `clickEvent`. */
export function clickOf(o: Record<string, unknown>): ClickAction | undefined {
  const raw = (o.click_event ?? o.clickEvent) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.action !== 'string') return undefined;
  const action = strip(raw.action);
  switch (action) {
    case 'run_command':
    case 'suggest_command':
      return { action, value: String(raw.command ?? raw.value ?? '') };
    case 'open_url':
      return { action, value: String(raw.url ?? raw.value ?? '') };
    case 'change_page':
      return { action, value: String(raw.page ?? raw.value ?? '') };
    case 'show_dialog':
      return { action, value: typeof raw.dialog === 'string' ? raw.dialog : '', payload: raw.dialog };
    case 'custom':
      return { action, value: String(raw.id ?? ''), payload: raw.payload };
    default:
      return { action, value: String(raw.value ?? '') };
  }
}

/** The hover text of a component node: 1.21.5+ `hover_event`, or the older `hoverEvent`. */
export function hoverOf(o: Record<string, unknown>): string | undefined {
  const raw = (o.hover_event ?? o.hoverEvent) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.action !== 'string') return undefined;
  const action = strip(raw.action);
  if (action === 'show_text') return componentText(raw.value ?? raw.contents);
  if (action === 'show_item') {
    const c = (raw.contents ?? raw) as Record<string, unknown>;
    const id = String(c.id ?? (typeof raw.value === 'string' ? raw.value : 'item'));
    const count = c.count ?? c.Count;
    return `[item ${strip(id)}${count !== undefined ? ` x${String(count)}` : ''}]`;
  }
  if (action === 'show_entity') {
    const c = (raw.contents ?? raw) as Record<string, unknown>;
    const name = c.name !== undefined ? componentText(c.name) : '';
    return `[entity ${strip(String(c.id ?? c.type ?? 'entity'))}${name ? ` "${name}"` : ''}]`;
  }
  return undefined;
}

/**
 * The component cut into runs of text, each with the click and hover it carries (a child inherits its
 * parent's events unless it sets its own, as in the game).
 */
export function componentParts(node: unknown): TextPart[] {
  const parts: TextPart[] = [];
  const walk = (n: unknown, click: ClickAction | undefined, hover: string | undefined): void => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') {
      const parsed = parseJson(n);
      if (typeof parsed !== 'string') return walk(parsed, click, hover);
      if (parsed) parts.push({ text: parsed, ...(click ? { click } : {}), ...(hover !== undefined ? { hover } : {}) });
      return;
    }
    if (Array.isArray(n)) {
      n.forEach((child) => walk(child, click, hover));
      return;
    }
    if (typeof n !== 'object') {
      parts.push({ text: String(n), ...(click ? { click } : {}), ...(hover !== undefined ? { hover } : {}) });
      return;
    }
    const o = (('json' in (n as object)) && typeof (n as { json?: unknown }).json === 'object' ? (n as { json: unknown }).json : n) as Record<string, unknown>;
    const ownClick = clickOf(o) ?? click;
    const ownHover = hoverOf(o) ?? hover;
    const own = componentText({ ...o, extra: undefined });
    if (own) parts.push({ text: own, ...(ownClick ? { click: ownClick } : {}), ...(ownHover !== undefined ? { hover: ownHover } : {}) });
    if (Array.isArray(o.extra)) o.extra.forEach((child) => walk(child, ownClick, ownHover));
  };
  walk(node, undefined, undefined);
  // Neighbouring runs with the same events read better as one.
  const merged: TextPart[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && JSON.stringify(last.click) === JSON.stringify(p.click) && last.hover === p.hover) last.text += p.text;
    else merged.push({ ...p });
  }
  return merged;
}

/** Only the parts a player could click or hover. */
export function interactiveParts(node: unknown): TextPart[] {
  return componentParts(node).filter((p) => p.click || p.hover !== undefined);
}
