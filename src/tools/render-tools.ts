import { z } from "zod";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import mineflayer from 'mineflayer';
import puppeteer, { type Browser } from 'puppeteer-core';
import { createCanvas, loadImage, Image, type CanvasRenderingContext2D } from 'canvas';
import prismarineViewer from 'prismarine-viewer';
import { ToolFactory } from '../tool-factory.js';

type ToolResponse = ReturnType<ToolFactory['createResponse']>;
// prismarine-viewer attaches `.viewer` to the bot at runtime; mineflayer's own types don't know about it.
type ViewerBot = mineflayer.Bot & { viewer?: { close: () => void } };
type CurrentWindow = NonNullable<mineflayer.Bot['currentWindow']>;

// Named imports from prismarine-viewer's CJS module.exports fail Node's cjs-module-lexer
// detection for the `supportedVersions` property, so the whole object is default-imported instead.
const attachViewer = prismarineViewer.mineflayer;
const SUPPORTED_VERSIONS: readonly string[] = prismarineViewer.supportedVersions;

const DEFAULT_DIMENSION = 512;
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 800;
const VIEW_DISTANCE = 4;
const RENDER_SETTLE_MS = 6000;
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const BLANK_FRAME_TOLERANCE = 6;

const SLOT_SIZE = 36;
const SLOT_MARGIN = 4;
const PADDING = 12;
const TITLE_HEIGHT = 26;
const GRID_COLUMNS = 9;
const SECTION_GAP = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

// prismarine-viewer lags the newest releases. Rendering with the closest older assets beats
// refusing outright, as long as the caller is told which assets were used.
export function nearestSupportedVersion(version: string): string | null {
  const target = versionParts(version);
  const older = SUPPORTED_VERSIONS
    .filter((candidate) => {
      const parts = versionParts(candidate);
      for (let i = 0; i < 3; i++) {
        const diff = (parts[i] ?? 0) - (target[i] ?? 0);
        if (diff !== 0) return diff < 0;
      }
      return true;
    })
    .sort((a, b) => {
      const pa = versionParts(a);
      const pb = versionParts(b);
      for (let i = 0; i < 3; i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

  return older[0] ?? null;
}

function imageResponse(buffer: Buffer): ToolResponse {
  return {
    content: [{ type: "image", data: buffer.toString('base64'), mimeType: "image/png" }]
  } as unknown as ToolResponse;
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
        server.close(() => reject(new Error('Could not allocate a free port for the render viewer')));
      }
    });
  });
}

export async function isBlankImage(buffer: Buffer): Promise<boolean> {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  const [r0, g0, b0] = data;

  for (let i = 4; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - r0) > BLANK_FRAME_TOLERANCE ||
      Math.abs(data[i + 1] - g0) > BLANK_FRAME_TOLERANCE ||
      Math.abs(data[i + 2] - b0) > BLANK_FRAME_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

async function captureScreenshot(
  bot: mineflayer.Bot,
  width: number,
  height: number,
  firstPerson: boolean
): Promise<{ ok: true; buffer: Buffer; warning?: string } | { ok: false; error: string }> {
  const fallbackVersion = SUPPORTED_VERSIONS.includes(bot.version) ? null : nearestSupportedVersion(bot.version);
  if (!SUPPORTED_VERSIONS.includes(bot.version) && !fallbackVersion) {
    return {
      ok: false,
      error: `take-screenshot cannot render Minecraft ${bot.version}. prismarine-viewer supports: ${SUPPORTED_VERSIONS.join(', ')}.`
    };
  }

  const assetVersion = fallbackVersion ?? bot.version;
  if (!hasBundledTextures(assetVersion)) {
    return {
      ok: false,
      error: `take-screenshot has no bundled textures for ${assetVersion}. This image ships only the recent texture sets; use a newer server, or rebuild the image keeping the ${assetVersion} textures.`
    };
  }

  const port = await findFreePort();
  attachViewer(bot, { port, firstPerson, viewDistance: VIEW_DISTANCE });
  const viewerBot = bot as ViewerBot;

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--disable-gpu-sandbox',
        '--enable-webgl',
        '--ignore-gpu-blocklist'
      ]
    });

    const page = await browser.newPage();
    const collectedErrors: string[] = [];
    // Chunk meshes build in a Web Worker; puppeteer forwards its exceptions into
    // 'pageerror'/'console' too, so no separate CDP worker plumbing is needed here.
    page.on('pageerror', (err) => collectedErrors.push(err instanceof Error ? err.message : String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') collectedErrors.push(msg.text());
    });

    await page.setViewport({ width, height });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'load' });
    await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));

    const buffer = Buffer.from(await page.screenshot({ type: 'png' }));

    if (await isBlankImage(buffer)) {
      const detail = collectedErrors.length > 0
        ? ` Errors observed while rendering: ${collectedErrors.slice(0, 3).join(' | ')}`
        : '';
      return {
        ok: false,
        error: `Screenshot came back as a single flat color, meaning the 3D scene failed to render.${detail}`
      };
    }

    return fallbackVersion
      ? { ok: true, buffer, warning: `Rendered with ${fallbackVersion} assets; the bot is on ${bot.version}, which prismarine-viewer does not support yet. Blocks added after ${fallbackVersion} may look wrong or be missing.` }
      : { ok: true, buffer };
  } finally {
    if (browser) {
      await browser.close();
    }
    viewerBot.viewer?.close();
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sectors: Array<[number, number, number]> = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [r, g, b] = sectors[Math.floor(h / 60) % 6];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function colorForItem(name: string): string {
  const hue = hashString(name) % 360;
  const [r, g, b] = hslToRgb(hue, 0.55, 0.5);
  return `rgb(${r}, ${g}, ${b})`;
}

// prismarine-viewer ships the vanilla texture sets it renders the world with; the item
// subset is a few MB and saves pulling minecraft-assets just for inventory icons.
function resolveTextureRoot(): string | null {
  try {
    const viewerManifest = createRequire(import.meta.url).resolve('prismarine-viewer/package.json');
    const root = path.join(path.dirname(viewerManifest), 'public', 'textures');
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

function pickTextureVersion(root: string): string | null {
  const versions = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
  return versions[0] ?? null;
}

const textureRoot = resolveTextureRoot();
const textureVersion = textureRoot ? pickTextureVersion(textureRoot) : null;
const textureCache = new Map<string, Image | null>();

// The Docker image keeps only the modern texture sets, so a version prismarine-viewer
// supports in code may still have no textures on disk.
export function hasBundledTextures(version: string): boolean {
  if (!textureRoot) {
    return true;
  }
  return fs.existsSync(path.join(textureRoot, version));
}

function itemTexture(name: string): Image | null {
  const cached = textureCache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  let image: Image | null = null;
  if (textureRoot && textureVersion) {
    for (const kind of ['items', 'blocks']) {
      const file = path.join(textureRoot, textureVersion, kind, `${name}.png`);
      if (fs.existsSync(file)) {
        const loaded = new Image();
        loaded.src = fs.readFileSync(file);
        image = loaded;
        break;
      }
    }
  }

  textureCache.set(name, image);
  return image;
}

function drawBevel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, baseColor: string, recessed: boolean): void {
  ctx.fillStyle = baseColor;
  ctx.fillRect(x, y, w, h);
  const topLeft = recessed ? '#373737' : '#ffffff';
  const bottomRight = recessed ? '#ffffff' : '#373737';
  ctx.fillStyle = topLeft;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = bottomRight;
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x + w - 2, y, 2, h);
}

export function renderWindowToPng(win: CurrentWindow): Buffer {
  const slotCount = win.slots.length;
  const rows = Math.max(1, Math.ceil(slotCount / GRID_COLUMNS));
  const boundaries = [win.inventoryStart, win.hotbarStart]
    .filter((b) => b > 0 && b < slotCount && b % GRID_COLUMNS === 0)
    .sort((a, b) => a - b);

  const width = PADDING * 2 + GRID_COLUMNS * SLOT_SIZE;
  const height = PADDING * 2 + TITLE_HEIGHT + rows * SLOT_SIZE + boundaries.length * SECTION_GAP;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  drawBevel(ctx, 0, 0, width, height, '#c6c6c6', false);

  ctx.fillStyle = '#3f3f3f';
  ctx.font = 'bold 14px sans-serif';
  const title = (win.title || String(win.type) || 'Window').slice(0, 40);
  ctx.fillText(title, PADDING, PADDING + 14);

  for (let i = 0; i < slotCount; i++) {
    const row = Math.floor(i / GRID_COLUMNS);
    const col = i % GRID_COLUMNS;
    const extraGap = boundaries.filter((b) => b <= row * GRID_COLUMNS).length * SECTION_GAP;

    const x = PADDING + col * SLOT_SIZE;
    const y = PADDING + TITLE_HEIGHT + row * SLOT_SIZE + extraGap;

    drawBevel(ctx, x, y, SLOT_SIZE, SLOT_SIZE, '#8b8b8b', true);

    const item = win.slots[i];
    if (item) {
      const inset = SLOT_MARGIN + 2;
      const swatchSize = SLOT_SIZE - inset * 2;
      const texture = itemTexture(item.name);
      if (texture) {
        // Item textures are 16x16; smoothing turns them to mush at slot size.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(texture, x + inset, y + inset, swatchSize, swatchSize);
        ctx.imageSmoothingEnabled = true;
      } else {
        ctx.fillStyle = colorForItem(item.name);
        ctx.fillRect(x + inset, y + inset, swatchSize, swatchSize);
        ctx.strokeStyle = '#1c1c1c';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + inset, y + inset, swatchSize, swatchSize);
      }

      if (item.count > 1) {
        const label = String(item.count);
        ctx.font = 'bold 12px sans-serif';
        const textWidth = ctx.measureText(label).width;
        const textX = x + SLOT_SIZE - textWidth - 3;
        const textY = y + SLOT_SIZE - 4;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        ctx.strokeText(label, textX, textY);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, textX, textY);
      }
    }
  }

  return canvas.toBuffer('image/png');
}

export function registerRenderTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "take-screenshot",
    "Render the bot's surroundings as a PNG image using prismarine-viewer",
    {
      width: z.coerce.number().int().positive().optional().describe(`Image width in pixels (default: ${DEFAULT_DIMENSION}, clamped between ${MIN_DIMENSION} and ${MAX_DIMENSION})`),
      height: z.coerce.number().int().positive().optional().describe(`Image height in pixels (default: ${DEFAULT_DIMENSION}, clamped between ${MIN_DIMENSION} and ${MAX_DIMENSION})`),
      firstPerson: z.boolean().optional().describe("Render from the bot's first-person view instead of third-person (default: false)")
    },
    async ({ width = DEFAULT_DIMENSION, height = DEFAULT_DIMENSION, firstPerson = false }) => {
      const bot = getBot();
      const clampedWidth = clamp(width, MIN_DIMENSION, MAX_DIMENSION);
      const clampedHeight = clamp(height, MIN_DIMENSION, MAX_DIMENSION);

      const result = await captureScreenshot(bot, clampedWidth, clampedHeight, firstPerson);
      if (!result.ok) {
        return factory.createResponse(result.error);
      }

      const response = imageResponse(result.buffer);
      if (result.warning) {
        response.content.unshift({ type: "text", text: result.warning });
      }
      return response;
    }
  );

  factory.registerTool(
    "render-window",
    "Render the currently open inventory or container window as a PNG image styled after the Minecraft GUI",
    {},
    async () => {
      const bot = getBot();
      const win = bot.currentWindow;

      if (!win) {
        return factory.createResponse("No inventory or container window is currently open. Open a chest, crafting table, furnace, or similar window first.");
      }

      return imageResponse(renderWindowToPng(win));
    }
  );
}
