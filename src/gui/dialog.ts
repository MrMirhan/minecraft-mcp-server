import { componentText } from './text.js';

/**
 * Dialogs (Minecraft 1.21.6+, and Paper's Dialog API on top of them): a screen with a title, body text,
 * inputs and buttons, sent as NBT in `show_dialog`. A button runs an action: a command, a custom click
 * the server handles (`custom_click_action`), a URL to open, and so on.
 */

/** A prismarine-nbt tag: `{ type, value }`. */
export interface NbtTag {
  type: string;
  value: unknown;
}

export interface DialogInput {
  key: string;
  type: 'text' | 'boolean' | 'single_option' | 'number_range' | string;
  label: string;
  initial?: string | number | boolean;
  options?: Array<{ id: string; display: string; initial?: boolean }>;
  start?: number;
  end?: number;
  step?: number;
  maxLength?: number;
  multiline?: boolean;
  onTrue?: string;
  onFalse?: string;
}

export interface DialogAction {
  type: string;
  /** run_command / suggest_command: the command; open_url: the URL; copy_to_clipboard: the text; change_page: the page. */
  value?: string;
  /** dynamic/run_command: the command with $(key) for each input. */
  template?: string;
  /** custom / dynamic/custom: the id the server handles. */
  id?: string;
  /** custom: the payload; dynamic/custom: the fixed additions. */
  nbt?: NbtTag;
  /** show_dialog: the dialog to show. */
  dialog?: unknown;
}

export interface DialogButton {
  label: string;
  tooltip?: string;
  action?: DialogAction;
}

export interface Dialog {
  kind: string;
  title: string;
  externalTitle?: string;
  body: string[];
  inputs: DialogInput[];
  buttons: DialogButton[];
  /** What Escape (or closing) does on dialogs that have one: multi_action, server_links, dialog_list. */
  exit?: DialogButton;
  canCloseWithEscape: boolean;
  /** close (default), none, or wait_for_response: what the game does after a button. */
  afterAction: string;
  /** A dialog the server named from its registry instead of sending in full. */
  registryId?: number | string;
}

/** What answering a dialog comes to, for the caller to send. */
export type DialogEffect =
  | { kind: 'command'; command: string }
  | { kind: 'custom'; id: string; nbt?: NbtTag }
  | { kind: 'dialog'; dialog: unknown }
  | { kind: 'info'; action: string; value: string }
  | { kind: 'close' };

function strip(id: string): string {
  return id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id;
}

function isTag(v: unknown): v is NbtTag {
  return !!v && typeof v === 'object' && typeof (v as NbtTag).type === 'string' && 'value' in (v as object);
}

/** A tag's value as plain JS, as prismarine-nbt's simplify does. */
export function simplify(tag: unknown): unknown {
  if (!isTag(tag)) return tag;
  switch (tag.type) {
    case 'compound': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(tag.value as Record<string, unknown>)) out[k] = simplify(v);
      return out;
    }
    case 'list': {
      const list = tag.value as { type: string; value: unknown[] };
      return (list.value ?? []).map((item) => simplify({ type: list.type, value: item }));
    }
    case 'byteArray':
    case 'intArray':
    case 'longArray':
      return tag.value;
    default:
      return tag.value;
  }
}

function child(tag: NbtTag | undefined, key: string): NbtTag | undefined {
  if (!tag || tag.type !== 'compound') return undefined;
  const v = (tag.value as Record<string, unknown>)[key];
  return isTag(v) ? v : undefined;
}

function items(tag: NbtTag | undefined): NbtTag[] {
  if (!tag) return [];
  if (tag.type !== 'list') return [tag];
  const list = tag.value as { type: string; value: unknown[] };
  return (list.value ?? []).map((value) => ({ type: list.type, value }));
}

function text(tag: NbtTag | undefined): string {
  return tag ? componentText(simplify(tag)) : '';
}

function str(tag: NbtTag | undefined): string | undefined {
  if (!tag) return undefined;
  const v = simplify(tag);
  return v === undefined || v === null ? undefined : String(v);
}

function num(tag: NbtTag | undefined): number | undefined {
  if (!tag) return undefined;
  const v = simplify(tag);
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Array.isArray(v) ? Number(v[1]) : v === undefined ? undefined : Number(v);
}

function bool(tag: NbtTag | undefined): boolean | undefined {
  const v = num(tag);
  if (v !== undefined && !Number.isNaN(v)) return v !== 0;
  const s = str(tag);
  return s === undefined ? undefined : s === 'true';
}

function parseAction(tag: NbtTag | undefined): DialogAction | undefined {
  if (!tag || tag.type !== 'compound') return undefined;
  const type = strip(str(child(tag, 'type')) ?? '');
  if (!type) return undefined;
  const action: DialogAction = { type };
  if (type === 'run_command' || type === 'suggest_command') action.value = str(child(tag, 'command'));
  else if (type === 'open_url') action.value = str(child(tag, 'url'));
  else if (type === 'copy_to_clipboard') action.value = str(child(tag, 'value'));
  else if (type === 'change_page') action.value = str(child(tag, 'page'));
  else if (type === 'show_dialog') action.dialog = child(tag, 'dialog');
  else if (type === 'custom') { action.id = str(child(tag, 'id')); action.nbt = child(tag, 'payload'); }
  else if (type === 'dynamic/run_command') action.template = str(child(tag, 'template'));
  else if (type === 'dynamic/custom') { action.id = str(child(tag, 'id')); action.nbt = child(tag, 'additions'); }
  return action;
}

function parseButton(tag: NbtTag | undefined, fallbackLabel: string): DialogButton | undefined {
  if (!tag) return undefined;
  const label = text(child(tag, 'label')) || fallbackLabel;
  const tooltip = text(child(tag, 'tooltip')) || undefined;
  const action = parseAction(child(tag, 'action'));
  return { label, ...(tooltip ? { tooltip } : {}), ...(action ? { action } : {}) };
}

function parseInput(tag: NbtTag): DialogInput {
  const type = strip(str(child(tag, 'type')) ?? 'text');
  const input: DialogInput = { key: str(child(tag, 'key')) ?? '', type, label: text(child(tag, 'label')) };
  if (type === 'text') {
    input.initial = str(child(tag, 'initial')) ?? '';
    input.maxLength = num(child(tag, 'max_length')) ?? 32;
    input.multiline = !!child(tag, 'multiline');
  } else if (type === 'boolean') {
    input.initial = bool(child(tag, 'initial')) ?? false;
    input.onTrue = str(child(tag, 'on_true')) ?? 'true';
    input.onFalse = str(child(tag, 'on_false')) ?? 'false';
  } else if (type === 'single_option') {
    input.options = items(child(tag, 'options')).map((o) => {
      if (o.type === 'string') return { id: String(o.value), display: String(o.value) };
      const id = str(child(o, 'id')) ?? '';
      const display = text(child(o, 'display')) || id;
      const initial = bool(child(o, 'initial'));
      return { id, display, ...(initial ? { initial } : {}) };
    });
    input.initial = (input.options.find((o) => o.initial) ?? input.options[0])?.id;
  } else if (type === 'number_range') {
    input.start = num(child(tag, 'start'));
    input.end = num(child(tag, 'end'));
    input.step = num(child(tag, 'step'));
    input.initial = num(child(tag, 'initial')) ?? (input.start !== undefined && input.end !== undefined ? (input.start + input.end) / 2 : 0);
    if (!input.label) input.label = text(child(tag, 'label_format')) || input.key;
  }
  return input;
}

/** The dialog in a `show_dialog` packet field (inline NBT, or a registry reference). */
export function parseDialog(source: unknown): Dialog {
  let tag: NbtTag | undefined;
  if (isTag(source)) tag = source;
  else if (source && typeof source === 'object') {
    const o = source as Record<string, unknown>;
    const inner = o.data ?? o.dialog ?? o.value;
    if (isTag(inner)) tag = inner;
    else if (inner && typeof inner === 'object') return parseDialog(inner);
    else {
      const id = Object.values(o).find((v) => typeof v === 'number' || typeof v === 'string') as number | string | undefined;
      return { kind: 'registry', title: `(dialog ${String(id)} from the server's registry)`, body: [], inputs: [], buttons: [], canCloseWithEscape: true, afterAction: 'close', registryId: id };
    }
  } else if (typeof source === 'string' || typeof source === 'number') {
    return { kind: 'registry', title: `(dialog ${String(source)} from the server's registry)`, body: [], inputs: [], buttons: [], canCloseWithEscape: true, afterAction: 'close', registryId: source };
  }
  if (!tag || tag.type !== 'compound') {
    return { kind: 'unknown', title: '(dialog the bot could not read)', body: [], inputs: [], buttons: [], canCloseWithEscape: true, afterAction: 'close' };
  }

  const kind = strip(str(child(tag, 'type')) ?? 'notice');
  const body = items(child(tag, 'body')).map((b) => {
    if (b.type !== 'compound') return text(b);
    const contents = child(b, 'contents');
    if (contents) return text(contents);
    const item = child(b, 'item');
    if (item) {
      const description = text(child(child(b, 'description'), 'contents') ?? child(b, 'description'));
      return `[item ${strip(str(child(item, 'id')) ?? '?')} x${num(child(item, 'count')) ?? 1}]${description ? ` ${description}` : ''}`;
    }
    return text(b);
  }).filter((line) => line !== '');

  const buttons: DialogButton[] = [];
  let exit: DialogButton | undefined;
  if (kind === 'notice') {
    buttons.push(parseButton(child(tag, 'action'), 'OK') ?? { label: 'OK' });
  } else if (kind === 'confirmation') {
    buttons.push(parseButton(child(tag, 'yes'), 'Yes') ?? { label: 'Yes' });
    buttons.push(parseButton(child(tag, 'no'), 'No') ?? { label: 'No' });
  } else if (kind === 'multi_action') {
    for (const b of items(child(tag, 'actions'))) {
      const parsed = parseButton(b, 'Button');
      if (parsed) buttons.push(parsed);
    }
    exit = parseButton(child(tag, 'exit_action'), 'Back');
  } else if (kind === 'dialog_list') {
    for (const d of items(child(tag, 'dialogs'))) {
      const nested = parseDialog(d);
      buttons.push({ label: nested.externalTitle || nested.title, action: { type: 'show_dialog', dialog: d } });
    }
    exit = parseButton(child(tag, 'exit_action'), 'Back');
  } else if (kind === 'server_links') {
    exit = parseButton(child(tag, 'exit_action'), 'Back');
  }

  const externalTitle = text(child(tag, 'external_title')) || undefined;
  return {
    kind,
    title: text(child(tag, 'title')),
    ...(externalTitle ? { externalTitle } : {}),
    body,
    inputs: items(child(tag, 'inputs')).filter((i) => i.type === 'compound').map(parseInput),
    buttons,
    ...(exit ? { exit } : {}),
    canCloseWithEscape: bool(child(tag, 'can_close_with_escape')) ?? true,
    afterAction: strip(str(child(tag, 'after_action')) ?? 'close')
  };
}

/** Each input's value: the caller's, or the dialog's initial one; checked against the input's limits. */
export function resolveInputs(dialog: Dialog, given: Record<string, unknown> = {}): Map<DialogInput, string | number | boolean> {
  const known = new Set(dialog.inputs.map((i) => i.key));
  for (const key of Object.keys(given)) {
    if (!known.has(key)) throw new Error(`The dialog has no input "${key}" (inputs: ${[...known].join(', ') || 'none'})`);
  }
  const values = new Map<DialogInput, string | number | boolean>();
  for (const input of dialog.inputs) {
    const raw = given[input.key] ?? input.initial;
    if (input.type === 'boolean') {
      values.set(input, raw === true || raw === 'true' || raw === 1 || raw === '1');
    } else if (input.type === 'number_range') {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`Input "${input.key}" needs a number`);
      if ((input.start !== undefined && n < Math.min(input.start, input.end ?? n)) || (input.end !== undefined && n > Math.max(input.end, input.start ?? n))) {
        throw new Error(`Input "${input.key}" must be between ${input.start} and ${input.end}`);
      }
      values.set(input, n);
    } else if (input.type === 'single_option') {
      const s = String(raw ?? '');
      const option = input.options?.find((o) => o.id === s) ?? input.options?.find((o) => o.display.toLowerCase() === s.toLowerCase());
      if (!option) throw new Error(`Input "${input.key}" must be one of: ${(input.options ?? []).map((o) => o.id).join(', ')}`);
      values.set(input, option.id);
    } else {
      const s = String(raw ?? '');
      if (input.maxLength !== undefined && s.length > input.maxLength) throw new Error(`Input "${input.key}" is longer than ${input.maxLength} characters`);
      values.set(input, s);
    }
  }
  return values;
}

function inputTag(input: DialogInput, value: string | number | boolean): NbtTag {
  if (input.type === 'boolean') return { type: 'byte', value: value ? 1 : 0 };
  if (input.type === 'number_range') return { type: 'float', value: Number(value) };
  return { type: 'string', value: String(value) };
}

function templateValue(input: DialogInput, value: string | number | boolean): string {
  if (input.type === 'boolean') return value ? (input.onTrue ?? 'true') : (input.onFalse ?? 'false');
  if (input.type === 'number_range') return Number.isInteger(value) ? String(value) : String(Number(value));
  return String(value);
}

/** What pressing `button` comes to, with the inputs filled in. */
export function dialogEffect(dialog: Dialog, button: DialogButton, given: Record<string, unknown> = {}): DialogEffect {
  const action = button.action;
  if (!action) return { kind: 'close' };
  const values = resolveInputs(dialog, given);
  switch (action.type) {
    case 'run_command':
      return { kind: 'command', command: action.value ?? '' };
    case 'dynamic/run_command': {
      let command = action.template ?? '';
      for (const [input, value] of values) command = command.split(`$(${input.key})`).join(templateValue(input, value));
      return { kind: 'command', command };
    }
    case 'custom':
      return { kind: 'custom', id: action.id ?? '', ...(action.nbt ? { nbt: action.nbt } : {}) };
    case 'dynamic/custom': {
      const fields: Record<string, NbtTag> = {};
      if (action.nbt?.type === 'compound') Object.assign(fields, action.nbt.value as Record<string, NbtTag>);
      for (const [input, value] of values) fields[input.key] = inputTag(input, value);
      return { kind: 'custom', id: action.id ?? '', nbt: { type: 'compound', value: fields } };
    }
    case 'show_dialog':
      return { kind: 'dialog', dialog: action.dialog };
    default:
      return { kind: 'info', action: action.type, value: action.value ?? '' };
  }
}

/** JSON (a chat click event's custom payload) as NBT, for sending back. */
export function jsonToNbt(value: unknown): NbtTag {
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'byte', value: value ? 1 : 0 };
  if (typeof value === 'number') return Number.isInteger(value) ? { type: 'int', value } : { type: 'double', value };
  if (Array.isArray(value)) {
    const tags = value.map(jsonToNbt);
    const type = tags[0]?.type ?? 'end';
    return { type: 'list', value: { type, value: tags.map((t) => t.value) } };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, NbtTag> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonToNbt(v);
    return { type: 'compound', value: out };
  }
  return { type: 'string', value: String(value) };
}

/** The dialog for a person or a model to read. */
export function describeDialog(d: Dialog): string {
  let out = `Dialog (${d.kind}): ${d.title || '(no title)'}\n`;
  if (d.registryId !== undefined) {
    out += 'The server named a dialog from its registry; the bot does not keep the registry, so only its id is known.\n';
  }
  if (d.body.length > 0) out += `\n${d.body.join('\n')}\n`;
  if (d.inputs.length > 0) {
    out += '\nInputs:\n';
    for (const i of d.inputs) {
      let extra = '';
      if (i.type === 'single_option') extra = ` options: ${(i.options ?? []).map((o) => (o.display !== o.id ? `${o.id} (${o.display})` : o.id)).join(', ')}`;
      if (i.type === 'number_range') extra = ` range ${i.start}..${i.end}${i.step ? ` step ${i.step}` : ''}`;
      if (i.type === 'text' && i.maxLength) extra = ` max ${i.maxLength} chars${i.multiline ? ', multiline' : ''}`;
      out += `  ${i.key} [${i.type}] "${i.label}" initial: ${JSON.stringify(i.initial)}${extra}\n`;
    }
  }
  if (d.buttons.length > 0) {
    out += '\nButtons:\n';
    d.buttons.forEach((b, i) => {
      out += `  ${i}: ${b.label}${b.tooltip ? ` (${b.tooltip})` : ''} -> ${describeAction(b.action)}\n`;
    });
  }
  if (d.exit) out += `\nExit: ${d.exit.label} -> ${describeAction(d.exit.action)}\n`;
  out += `\nAfter a button: ${d.afterAction}. Escape closes: ${d.canCloseWithEscape ? 'yes' : 'no'}.`;
  return out.trim();
}

function describeAction(a: DialogAction | undefined): string {
  if (!a) return 'close';
  if (a.type === 'dynamic/run_command') return `run_command ${a.template ?? ''}`;
  if (a.type === 'custom' || a.type === 'dynamic/custom') return `${a.type} ${a.id ?? ''}`;
  if (a.type === 'show_dialog') return 'show_dialog';
  return `${a.type} ${a.value ?? ''}`.trim();
}
