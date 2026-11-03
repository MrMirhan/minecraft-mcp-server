import { spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";

// A live view of the camera client: ffmpeg grabs the screen the game draws into (Xvfb on Linux, the real display through
// AVFoundation on macOS) and sends it as MJPEG (multipart/x-mixed-replace), so a browser <img> on another machine shows it.
// It copies what the game already drew: the game renders no extra frames. ffmpeg runs only while someone watches.
const MAX_VIEWERS = 3;
let viewers = 0;

export function liveArgs(display: string, fps: number, width: number): string[] {
  const rate = Math.max(1, Math.min(30, Math.round(fps) || 10));
  const w = Math.max(160, Math.min(1280, Math.round(width) || 640));
  return ["-loglevel", "error", "-f", "x11grab", "-framerate", String(rate), "-video_size", "1280x720", "-i", display,
    "-vf", `scale=${w}:-2`, "-q:v", "7", "-f", "mpjpeg", "-"];
}

// macOS: the screen through AVFoundation (MC_LIVE_SCREEN, default "Capture screen 0"). The process that runs this server
// needs the Screen Recording permission once (System Settings -> Privacy & Security), and the client a window (not headless).
export function macLiveArgs(screen: string, fps: number, width: number): string[] {
  const rate = Math.max(1, Math.min(30, Math.round(fps) || 10));
  const w = Math.max(160, Math.min(1920, Math.round(width) || 640));
  return ["-loglevel", "error", "-f", "avfoundation", "-capture_cursor", "0", "-pixel_format", "nv12", "-framerate", String(rate), "-i", `${screen}:none`,
    "-vf", `scale=${w}:-2`, "-r", String(rate), "-q:v", "7", "-f", "mpjpeg", "-"];
}

/** The camera mod's own preview stream (mc-cli 1.9+, GET /live on its MCP port), with its access token. */
export function modLive(env: NodeJS.ProcessEnv, fps: number, width: number): { url: string; token?: string } {
  const host = env.MCCLI_HOST || "127.0.0.1";
  const port = Number(env.MCCLI_MCP_PORT) || 25590;
  const rate = Math.max(1, Math.min(30, Math.round(fps) || 10));
  const w = Math.max(160, Math.min(1280, Math.round(width) || 640));
  let token = env.MCCLI_TOKEN || undefined;
  const file = env.MCCLI_TOKEN_FILE || (env.MC_CLIENT_DIR ? `${env.MC_CLIENT_DIR}/game/config/mccli-token` : "");
  if (!token && file) {
    try { token = fs.readFileSync(file, "utf8").trim() || undefined; } catch { /* no token file yet */ }
  }
  return { url: `http://${host}:${port}/live?fps=${rate}&width=${w}`, token };
}

/**
 * The live view: the camera mod's preview first (it reads the frame the game drew, so it works headless and behind a
 * lock screen), then a screen grab when the mod has none (older mc-cli). MC_LIVE_SOURCE=mod|x11|avfoundation forces one.
 */
export async function serveLive(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, message: string) => void): Promise<void> {
  const forced = process.env.MC_LIVE_SOURCE;
  if (forced !== "x11" && forced !== "avfoundation") {
    const query = new URL(req.url ?? "/live", "http://x").searchParams;
    const { url, token } = modLive(process.env, Number(query.get("fps")) || 10, Number(query.get("width")) || 640);
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    res.on("close", () => abort.abort());
    try {
      const up = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: abort.signal });
      if (up.ok && up.body) {
        res.writeHead(200, { "Content-Type": up.headers.get("content-type") || "multipart/x-mixed-replace; boundary=ffmpeg", "Cache-Control": "no-store", Connection: "keep-alive" });
        for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
          if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
        }
        if (!res.writableEnded) res.end();
        return;
      }
      log("warn", `live: the camera mod answered ${up.status}; ${forced === "mod" ? "no fallback" : "falling back to a screen grab"}`);
    } catch (err) {
      if (abort.signal.aborted) { if (!res.writableEnded) res.end(); return; }
      log("warn", `live: the camera mod's preview is not reachable (${(err as Error).message})`);
    }
    if (forced === "mod") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "the camera client is not running or has no preview; any client-* tool starts it" }));
      return;
    }
  }
  serveScreen(req, res, log);
}

function serveScreen(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, message: string) => void): void {
  // MC_LIVE_SOURCE: "x11" or "avfoundation"; the default follows the platform.
  const mac = (process.env.MC_LIVE_SOURCE || (process.platform === "darwin" ? "avfoundation" : "x11")) === "avfoundation";
  const display = process.env.DISPLAY || ":99";
  const socket = process.env.MC_LIVE_DISPLAY_SOCKET || `/tmp/.X11-unix/X${display.replace(/^:/, "")}`;
  if (!mac && !fs.existsSync(socket)) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "the camera client is not running; any client-* tool starts it" }));
    return;
  }
  if (viewers >= MAX_VIEWERS) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "too many live viewers" }));
    return;
  }
  const query = new URL(req.url ?? "/live", "http://x").searchParams;
  const fps = Number(query.get("fps")) || 10;
  const width = Number(query.get("width")) || 640;
  const args = mac ? macLiveArgs(process.env.MC_LIVE_SCREEN || "Capture screen 0", fps, width) : liveArgs(display, fps, width);
  const ffmpeg = spawn(process.env.FFMPEG_PATH || "ffmpeg", args,
    { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "pipe", "pipe"] });
  viewers++;
  res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg", "Cache-Control": "no-store", Connection: "keep-alive" });
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", (d: Buffer) => log("warn", `live: ${d.toString().trim().slice(0, 200)}`));
  // The screen has one reader at a time on macOS: a viewer that leaves must not leave ffmpeg holding it.
  const stop = () => {
    if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) return;
    ffmpeg.kill("SIGTERM");
    setTimeout(() => { if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill("SIGKILL"); }, 2000).unref();
  };
  res.on("close", stop);
  ffmpeg.on("close", () => { viewers--; if (!res.writableEnded) res.end(); });
  ffmpeg.on("error", (err) => { log("error", `live: ${err.message}`); if (!res.writableEnded) res.end(); });
  req.on("close", stop);
}
