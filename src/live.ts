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
    "-vf", `scale=${w}:-2`, "-q:v", "7", "-f", "mpjpeg", "-"];
}

export function serveLive(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, message: string) => void): void {
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
  const stop = () => { if (!ffmpeg.killed) ffmpeg.kill("SIGTERM"); };
  ffmpeg.on("close", () => { viewers--; if (!res.writableEnded) res.end(); });
  ffmpeg.on("error", (err) => { log("error", `live: ${err.message}`); if (!res.writableEnded) res.end(); });
  req.on("close", stop);
}
