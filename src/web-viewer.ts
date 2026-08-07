import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import mineflayer from 'mineflayer';
import prismarineViewer from 'prismarine-viewer';
import { log } from './logger.js';
import { nearestSupportedVersion } from './tools/render-tools.js';

// prismarine-viewer attaches `.viewer` to the bot at runtime; mineflayer's own types don't know about it.
type ViewerBot = mineflayer.Bot & { viewer?: { close: () => void } };
type AttachViewerFn = (bot: mineflayer.Bot, options: { port: number; firstPerson: boolean; viewDistance: number }) => void;

// Named imports from prismarine-viewer's CJS module.exports fail Node's cjs-module-lexer
// detection for the `supportedVersions` property, so the whole object is default-imported instead.
const attachViewer: AttachViewerFn = prismarineViewer.mineflayer;
const SUPPORTED_VERSIONS: readonly string[] = prismarineViewer.supportedVersions;

const DEFAULT_VIEWER_PORT = 3007;
const DEFAULT_MCP_HTTP_PORT = 3000;
const VIEW_DISTANCE = 4;
const VIEW_PROXY_PREFIX = '/view';
// prismarine-viewer's bundled client connects socket.io at this fixed, origin-absolute path
// regardless of where its own assets were loaded from, so it must be proxied unprefixed too.
const SOCKET_IO_PATH = '/socket.io';
const UI_STATE_PATH = '/ui-state';
const UI_HEARTBEAT_MS = 1000;

function resolveViewerPort(): number {
  const raw = process.env.WEB_VIEWER_PORT;
  if (!raw) return DEFAULT_VIEWER_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_VIEWER_PORT;
}

function resolveMcpHttpPort(): number {
  const raw = process.env.SERVER_PORT ?? process.env.PORT;
  if (!raw) return DEFAULT_MCP_HTTP_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_HTTP_PORT;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not allocate a free port for the web viewer')));
      }
    });
  });
}

export interface UiTitleState {
  title: string | null;
  subtitle: string | null;
  actionBar: string | null;
}

export interface UiResourcePackState {
  url: string;
  hash: string;
}

export interface UiScoreboardItemState {
  name: string;
  displayName: string;
  value: number;
}

export interface UiScoreboardState {
  title: string;
  items: UiScoreboardItemState[];
}

export interface UiBossBarState {
  entityUUID: string;
  title: string;
  health: number;
  color: string;
  dividers: number;
}

export interface UiTablistState {
  header: string;
  footer: string;
}

export interface UiWindowSlotState {
  slot: number;
  name: string;
  count: number;
  displayName: string;
}

export interface UiWindowState {
  title: string;
  slots: UiWindowSlotState[];
}

export interface UiState {
  title: UiTitleState;
  tablist: UiTablistState;
  bossBars: UiBossBarState[];
  scoreboards: {
    sidebar: UiScoreboardState | null;
    list: UiScoreboardState | null;
    belowName: UiScoreboardState | null;
  };
  resourcePack: UiResourcePackState | null;
  window: UiWindowState | null;
}

interface UiStateRecord {
  state: UiState;
  listeners: Set<(state: UiState) => void>;
}

interface UpdateSlotEmitter {
  on(event: 'updateSlot', listener: () => void): void;
  removeListener(event: 'updateSlot', listener: () => void): void;
}

const uiStateRecords = new WeakMap<mineflayer.Bot, UiStateRecord>();

function emptyUiState(): UiState {
  return {
    title: { title: null, subtitle: null, actionBar: null },
    tablist: { header: '', footer: '' },
    bossBars: [],
    scoreboards: { sidebar: null, list: null, belowName: null },
    resourcePack: null,
    window: null
  };
}

function normalizeResourcePack(a: string, b: string | undefined): UiResourcePackState {
  const first = a;
  const second = b ?? '';
  const url = /^https?:\/\//i.test(first) ? first : second;
  const hash = url === first ? second : first;
  return { url, hash };
}

function toScoreboardState(board: mineflayer.ScoreBoard | undefined): UiScoreboardState | null {
  if (!board) return null;
  return {
    title: board.title,
    items: board.items.map((item) => ({
      name: item.name,
      displayName: item.displayName?.toMotd?.() ?? item.name,
      value: item.value
    }))
  };
}

// Wires the UI listeners exactly once per bot instance. Called eagerly by BotConnection when a
// bot is created, with a lazy fallback here so callers reading state before that point still work.
export function attachUiState(bot: mineflayer.Bot): void {
  if (uiStateRecords.has(bot)) return;

  const record: UiStateRecord = { state: emptyUiState(), listeners: new Set() };
  uiStateRecords.set(bot, record);

  const notify = (): void => {
    for (const listener of record.listeners) listener(record.state);
  };

  bot.on('title', (text, type) => {
    if (type === 'title') record.state.title.title = text;
    else record.state.title.subtitle = text;
    notify();
  });

  bot.on('actionBar', (jsonMsg) => {
    record.state.title.actionBar = jsonMsg.toMotd();
    notify();
  });

  // mineflayer's resourcePack emit call sites disagree on argument order (url-first vs uuid-first)
  bot.on('resourcePack', (a, b) => {
    record.state.resourcePack = normalizeResourcePack(a, b);
    notify();
  });

  const refreshScoreboards = (): void => {
    record.state.scoreboards = {
      sidebar: toScoreboardState(bot.scoreboard?.sidebar),
      list: toScoreboardState(bot.scoreboard?.list),
      belowName: toScoreboardState(bot.scoreboard?.belowName)
    };
    notify();
  };
  bot.on('scoreboardCreated', refreshScoreboards);
  bot.on('scoreboardDeleted', refreshScoreboards);
  bot.on('scoreboardTitleChanged', refreshScoreboards);
  bot.on('scoreUpdated', refreshScoreboards);
  bot.on('scoreRemoved', refreshScoreboards);
  bot.on('scoreboardPosition', refreshScoreboards);

  const refreshBossBars = (): void => {
    const bars = (bot as mineflayer.Bot & { bossBars?: mineflayer.BossBar[] }).bossBars ?? [];
    record.state.bossBars = bars.map((bar) => ({
      entityUUID: bar.entityUUID,
      title: bar.title.toMotd(),
      health: bar.health,
      color: bar.color,
      dividers: bar.dividers
    }));
    notify();
  };
  bot.on('bossBarCreated', refreshBossBars);
  bot.on('bossBarDeleted', refreshBossBars);
  bot.on('bossBarUpdated', refreshBossBars);

  let currentWindow: mineflayer.Bot['currentWindow'] = null;
  const refreshWindow = (): void => {
    if (!currentWindow) {
      record.state.window = null;
      notify();
      return;
    }
    const win = currentWindow;
    const slots: UiWindowSlotState[] = [];
    win.slots.forEach((item, slot) => {
      if (item) slots.push({ slot, name: item.name, count: item.count, displayName: item.displayName });
    });
    record.state.window = { title: win.title || '', slots };
    notify();
  };
  const onSlotUpdate = (): void => refreshWindow();
  bot.on('windowOpen', (win) => {
    currentWindow = win;
    (win as unknown as UpdateSlotEmitter).on('updateSlot', onSlotUpdate);
    refreshWindow();
  });
  bot.on('windowClose', (win) => {
    (win as unknown as UpdateSlotEmitter).removeListener('updateSlot', onSlotUpdate);
    currentWindow = null;
    refreshWindow();
  });
}

// tablist header/footer have no change event in mineflayer, so they are read live here
// instead of cached, avoiding a timer that would outlive removeAllListeners() cleanup.
export function getUiState(bot: mineflayer.Bot): UiState {
  attachUiState(bot);
  const record = uiStateRecords.get(bot)!;
  const header = bot.tablist?.header?.toMotd?.() ?? '';
  const footer = bot.tablist?.footer?.toMotd?.() ?? '';
  return { ...record.state, tablist: { header, footer } };
}

export function onUiStateChange(bot: mineflayer.Bot, listener: (state: UiState) => void): () => void {
  attachUiState(bot);
  const record = uiStateRecords.get(bot)!;
  record.listeners.add(listener);
  return () => record.listeners.delete(listener);
}

function normalizePrefix(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') return null;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function renderOverlayHtml(prefix: string | null): string {
  const base = prefix ? `<base href="${prefix}">` : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${base}
<title>Minecraft Bot Viewer</title>
<style>
  html, body { margin:0; padding:0; height:100%; background:#000; overflow:hidden; font-family:sans-serif; }
  #view { position:absolute; inset:0; width:100%; height:100%; border:0; }
  #overlay { position:absolute; inset:0; pointer-events:none; color:#fff; text-shadow:1px 1px 2px #000; }
  #scoreboard { position:absolute; top:12px; right:12px; background:rgba(0,0,0,0.5); padding:8px 12px; min-width:160px; }
  #scoreboard h3 { margin:0 0 4px; font-size:14px; }
  #scoreboard div { font-size:13px; display:flex; justify-content:space-between; gap:12px; }
  #bossbars { position:absolute; top:12px; left:50%; transform:translateX(-50%); display:flex; flex-direction:column; gap:4px; align-items:center; }
  .bossbar { width:400px; }
  .bossbar-label { text-align:center; font-size:13px; margin-bottom:2px; }
  .bossbar-track { background:rgba(0,0,0,0.6); height:8px; border-radius:2px; overflow:hidden; }
  .bossbar-fill { height:100%; }
  #actionbar { position:absolute; bottom:76px; left:50%; transform:translateX(-50%); font-size:16px; }
  #title-container { position:absolute; top:30%; left:50%; transform:translate(-50%,-50%); text-align:center; }
  #title-container .title { font-size:36px; }
  #title-container .subtitle { font-size:20px; }
  #tablist { position:absolute; inset:40px 15%; background:rgba(0,0,0,0.75); display:none; flex-direction:column; padding:16px; box-sizing:border-box; }
  #tablist.visible { display:flex; }
  #tablist .header, #tablist .footer { text-align:center; font-size:14px; }
  #window { position:absolute; bottom:12px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.6); padding:8px; display:none; }
  #window.visible { display:block; }
  #window h3 { margin:0 0 6px; font-size:14px; text-align:center; }
  #window .grid { display:grid; grid-template-columns:repeat(9, 36px); gap:2px; }
  #window .slot { position:relative; width:36px; height:36px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.2); font-size:9px; box-sizing:border-box; overflow:hidden; text-align:center; }
  #window .slot .count { position:absolute; bottom:1px; right:2px; font-size:10px; font-weight:bold; }
  #status { position:absolute; bottom:12px; right:12px; font-size:11px; opacity:0.6; }
</style>
</head>
<body>
<iframe id="view" src="${VIEW_PROXY_PREFIX.slice(1)}/"></iframe>
<div id="overlay">
  <div id="scoreboard"></div>
  <div id="bossbars"></div>
  <div id="title-container"></div>
  <div id="actionbar"></div>
  <div id="tablist"><div class="header"></div><div style="flex:1"></div><div class="footer"></div></div>
  <div id="window"></div>
  <div id="status">connecting...</div>
</div>
<script>
(function () {
  var MC_COLORS = {
    '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
    '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
    '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
    'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF'
  };
  var BOSSBAR_COLOR_CODE = { pink: 'd', blue: '9', red: 'c', green: 'a', yellow: 'e', purple: '5', white: 'f' };

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function parseColorCodes(text) {
    if (!text) return '';
    var pattern = /§(#[0-9a-fA-F]{6}|[0-9a-fk-or])/gi;
    var lastIndex = 0;
    var color = null, bold = false, italic = false, underline = false, strikethrough = false;
    var html = '';

    function flush(chunk) {
      if (!chunk) return;
      var styles = [];
      if (color) styles.push('color:' + color);
      if (bold) styles.push('font-weight:bold');
      if (italic) styles.push('font-style:italic');
      var decorations = [];
      if (underline) decorations.push('underline');
      if (strikethrough) decorations.push('line-through');
      if (decorations.length) styles.push('text-decoration:' + decorations.join(' '));
      var escaped = escapeHtml(chunk);
      html += styles.length ? ('<span style="' + styles.join(';') + '">' + escaped + '</span>') : escaped;
    }

    var match;
    while ((match = pattern.exec(text)) !== null) {
      flush(text.slice(lastIndex, match.index));
      lastIndex = pattern.lastIndex;
      var code = match[1].toLowerCase();
      if (code.charAt(0) === '#') {
        color = code; bold = italic = underline = strikethrough = false;
      } else if (code === 'r') {
        color = null; bold = italic = underline = strikethrough = false;
      } else if (code === 'l') {
        bold = true;
      } else if (code === 'o') {
        italic = true;
      } else if (code === 'n') {
        underline = true;
      } else if (code === 'm') {
        strikethrough = true;
      } else if (MC_COLORS[code]) {
        color = MC_COLORS[code]; bold = italic = underline = strikethrough = false;
      }
    }
    flush(text.slice(lastIndex));
    return html;
  }

  function shortName(name) {
    var idx = name.indexOf(':');
    var stripped = idx >= 0 ? name.slice(idx + 1) : name;
    return stripped.length > 9 ? stripped.slice(0, 9) : stripped;
  }

  var scoreboardEl = document.getElementById('scoreboard');
  var bossbarsEl = document.getElementById('bossbars');
  var actionbarEl = document.getElementById('actionbar');
  var titleEl = document.getElementById('title-container');
  var tablistEl = document.getElementById('tablist');
  var tablistHeaderEl = tablistEl.querySelector('.header');
  var tablistFooterEl = tablistEl.querySelector('.footer');
  var windowEl = document.getElementById('window');
  var statusEl = document.getElementById('status');

  function renderScoreboard(scoreboards) {
    var board = scoreboards.sidebar || scoreboards.list || scoreboards.belowName;
    if (!board) { scoreboardEl.innerHTML = ''; return; }
    var html = '<h3>' + parseColorCodes(board.title) + '</h3>';
    for (var i = 0; i < board.items.length; i++) {
      var item = board.items[i];
      html += '<div><span>' + parseColorCodes(item.displayName) + '</span><span>' + item.value + '</span></div>';
    }
    scoreboardEl.innerHTML = html;
  }

  function renderBossBars(bars) {
    var html = '';
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      var pct = Math.max(0, Math.min(1, bar.health)) * 100;
      var colorHex = MC_COLORS[BOSSBAR_COLOR_CODE[bar.color]] || '#ffffff';
      html += '<div class="bossbar">' +
        '<div class="bossbar-label">' + parseColorCodes(bar.title) + '</div>' +
        '<div class="bossbar-track"><div class="bossbar-fill" style="width:' + pct + '%;background:' + colorHex + '"></div></div>' +
        '</div>';
    }
    bossbarsEl.innerHTML = html;
  }

  function renderActionBar(actionBar) {
    actionbarEl.innerHTML = actionBar ? parseColorCodes(actionBar) : '';
  }

  function renderTitle(title) {
    var html = '';
    if (title.title) html += '<div class="title">' + parseColorCodes(title.title) + '</div>';
    if (title.subtitle) html += '<div class="subtitle">' + parseColorCodes(title.subtitle) + '</div>';
    titleEl.innerHTML = html;
  }

  function renderTablist(tablist) {
    tablistHeaderEl.innerHTML = parseColorCodes(tablist.header);
    tablistFooterEl.innerHTML = parseColorCodes(tablist.footer);
  }

  function renderWindow(win) {
    if (!win) { windowEl.classList.remove('visible'); windowEl.innerHTML = ''; return; }
    var bySlot = {};
    var maxSlot = 0;
    for (var i = 0; i < win.slots.length; i++) {
      bySlot[win.slots[i].slot] = win.slots[i];
      if (win.slots[i].slot > maxSlot) maxSlot = win.slots[i].slot;
    }
    var html = '<h3>' + parseColorCodes(win.title) + '</h3><div class="grid">';
    for (var slot = 0; slot <= maxSlot; slot++) {
      var item = bySlot[slot];
      html += '<div class="slot" title="' + (item ? escapeHtml(item.displayName) : '') + '">' +
        (item ? escapeHtml(shortName(item.name)) : '') +
        (item && item.count > 1 ? '<span class="count">' + item.count + '</span>' : '') +
        '</div>';
    }
    html += '</div>';
    windowEl.innerHTML = html;
    windowEl.classList.add('visible');
  }

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') { e.preventDefault(); tablistEl.classList.add('visible'); }
  });
  window.addEventListener('keyup', function (e) {
    if (e.key === 'Tab') { tablistEl.classList.remove('visible'); }
  });

  function applyState(state) {
    renderScoreboard(state.scoreboards);
    renderBossBars(state.bossBars);
    renderActionBar(state.title.actionBar);
    renderTitle(state.title);
    renderTablist(state.tablist);
    renderWindow(state.window);
  }

  var source = new EventSource('ui-state');
  source.onmessage = function (event) {
    statusEl.textContent = 'live';
    try {
      applyState(JSON.parse(event.data));
    } catch (err) {
      /* ignore malformed frame */
    }
  };
  source.onerror = function () {
    statusEl.textContent = 'reconnecting...';
  };
})();
</script>
</body>
</html>`;
}

export interface WebViewerOptions {
  port?: number;
  attach?: AttachViewerFn;
}

export class WebViewer {
  private readonly port: number;
  private readonly attach: AttachViewerFn;
  private server: http.Server | null = null;
  private actualPort: number | null = null;
  private running = false;
  private bot: ViewerBot | null = null;
  private internalPort: number | null = null;
  private attachToken = 0;
  private attachWarning: string | null = null;
  private unsubscribeUi: (() => void) | null = null;
  private readonly sseClients = new Map<http.ServerResponse, ReturnType<typeof setInterval>>();

  constructor(options: WebViewerOptions = {}) {
    this.port = options.port ?? resolveViewerPort();
    this.attach = options.attach ?? attachViewer;
  }

  isRunning(): boolean {
    return this.running;
  }

  getUrl(): string | null {
    return this.running && this.actualPort !== null ? `http://localhost:${this.actualPort}/` : null;
  }

  getVersionWarning(): string | null {
    return this.attachWarning;
  }

  async start(bot: mineflayer.Bot | null): Promise<string> {
    if (this.running) {
      this.rebind(bot);
      return this.getUrl()!;
    }

    const mcpPort = resolveMcpHttpPort();
    if (this.port === mcpPort) {
      throw new Error(`Web viewer port ${this.port} collides with the MCP HTTP port ${mcpPort}. Set WEB_VIEWER_PORT to a different value.`);
    }

    const server = http.createServer((req, res) => this.handleRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(this.port, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    this.server = server;
    const address = server.address();
    this.actualPort = address && typeof address === 'object' ? address.port : this.port;
    this.running = true;

    if (bot) {
      this.rebind(bot);
    }

    return this.getUrl()!;
  }

  stop(): void {
    this.running = false;
    this.detachBot();

    for (const [res, heartbeat] of this.sseClients) {
      clearInterval(heartbeat);
      res.end();
    }
    this.sseClients.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      this.actualPort = null;
      server.close();
    }
  }

  // Detaches from whatever bot is currently attached (if any) and, when running, attaches to
  // the new one. Called on every bot-lifecycle transition so the viewer never lingers on a dead bot.
  rebind(bot: mineflayer.Bot | null): void {
    this.detachBot();
    if (this.running && bot) {
      void this.attachBot(bot);
    }
  }

  private detachBot(): void {
    this.attachToken++;
    if (this.unsubscribeUi) {
      this.unsubscribeUi();
      this.unsubscribeUi = null;
    }
    if (this.bot?.viewer) {
      try {
        this.bot.viewer.close();
      } catch (err) {
        log('warn', `[web-viewer] error closing previous viewer: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.bot = null;
    this.internalPort = null;
  }

  private async attachBot(bot: mineflayer.Bot): Promise<void> {
    const token = ++this.attachToken;

    if (!SUPPORTED_VERSIONS.includes(bot.version)) {
      const fallback = nearestSupportedVersion(bot.version);
      if (!fallback) {
        this.attachWarning = `prismarine-viewer does not support Minecraft ${bot.version} and has no older assets to fall back to; the 3D view will not render.`;
        log('warn', `[web-viewer] ${this.attachWarning}`);
        return;
      }
      this.attachWarning = `Minecraft ${bot.version} is newer than prismarine-viewer's supported versions; rendering with ${fallback} assets. Blocks added after ${fallback} may look wrong or be missing.`;
      log('warn', `[web-viewer] ${this.attachWarning}`);
    } else {
      this.attachWarning = null;
    }

    try {
      const internalPort = await findFreePort();
      if (token !== this.attachToken || !this.running) {
        return;
      }
      this.attach(bot, { port: internalPort, firstPerson: false, viewDistance: VIEW_DISTANCE });
      this.internalPort = internalPort;
      this.bot = bot as ViewerBot;
      this.unsubscribeUi = onUiStateChange(bot, (state) => this.broadcastUiState(state));
      this.broadcastUiState(getUiState(bot));
    } catch (err) {
      log('error', `[web-viewer] failed to attach viewer to bot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private broadcastUiState(state: UiState): void {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of this.sseClients.keys()) {
      res.write(payload);
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = (req.url ?? '/').split('?')[0];

    if (pathname === '/') {
      this.serveOverlayPage(req, res);
      return;
    }
    if (pathname === UI_STATE_PATH) {
      this.serveUiStateStream(res);
      return;
    }
    const proxyPath = this.resolveProxyPath(pathname);
    if (proxyPath !== null) {
      this.proxyToInternal(req, res, proxyPath);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? '/').split('?')[0];
    const rewrittenPath = this.resolveProxyPath(pathname);

    if (!this.internalPort || rewrittenPath === null) {
      socket.destroy();
      return;
    }

    const search = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const internalPort = this.internalPort;
    const target = net.connect(internalPort, '127.0.0.1', () => {
      const headerLines = [`${req.method ?? 'GET'} ${rewrittenPath + search} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headerLines.push(`${key}: ${item}`);
        } else if (value !== undefined) {
          headerLines.push(`${key}: ${value}`);
        }
      }
      target.write(`${headerLines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) {
        target.write(head);
      }
      target.pipe(socket);
      socket.pipe(target);
    });

    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  }

  private resolveProxyPath(pathname: string): string | null {
    if (pathname === VIEW_PROXY_PREFIX || pathname.startsWith(`${VIEW_PROXY_PREFIX}/`)) {
      return pathname.slice(VIEW_PROXY_PREFIX.length) || '/';
    }
    if (pathname === SOCKET_IO_PATH || pathname.startsWith(`${SOCKET_IO_PATH}/`)) {
      return pathname;
    }
    return null;
  }

  private proxyToInternal(req: http.IncomingMessage, res: http.ServerResponse, rewrittenPath: string): void {
    if (!this.internalPort) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Viewer is not attached to a bot yet');
      return;
    }

    const search = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const proxyReq = http.request({
      host: '127.0.0.1',
      port: this.internalPort,
      path: rewrittenPath + search,
      method: req.method,
      headers: req.headers as http.OutgoingHttpHeaders
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers as http.OutgoingHttpHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Viewer upstream unavailable');
    });

    req.pipe(proxyReq);
  }

  private serveOverlayPage(req: http.IncomingMessage, res: http.ServerResponse): void {
    const prefix = normalizePrefix(req.headers['x-forwarded-prefix']);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderOverlayHtml(prefix));
  }

  private serveUiStateStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const send = (): void => {
      const state = this.bot ? getUiState(this.bot) : emptyUiState();
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    };

    send();
    const heartbeat = setInterval(send, UI_HEARTBEAT_MS);
    this.sseClients.set(res, heartbeat);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    });
  }
}
