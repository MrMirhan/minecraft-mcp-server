import { spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";

// A live view of the camera client: ffmpeg grabs the Xvfb screen the game draws into and sends it as MJPEG
// (multipart/x-mixed-replace), so a browser <img> on another machine shows it. ffmpeg runs only while someone watches.
const MAX_VIEWERS = 3;
let viewers = 0;

export function liveArgs(display: string, fps: number, width: number): string[] {
  const rate = Math.max(1, Math.min(30, Math.round(fps) || 10));
  const w = Math.max(160, Math.min(1280, Math.round(width) || 640));
  return ["-loglevel", "error", "-f", "x11grab", "-framerate", String(rate), "-video_size", "1280x720", "-i", display,
    "-vf", `scale=${w}:-2`, "-q:v", "7", "-f", "mpjpeg", "-"];
}

export function serveLive(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, message: string) => void): void {
  const display = process.env.DISPLAY || ":99";
  const socket = process.env.MC_LIVE_DISPLAY_SOCKET || `/tmp/.X11-unix/X${display.replace(/^:/, "")}`;
  if (!fs.existsSync(socket)) {
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
  const ffmpeg = spawn("ffmpeg", liveArgs(display, Number(query.get("fps")) || 10, Number(query.get("width")) || 640),
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
