import os from "node:os";
import path from "node:path";

// Videos and screenshots the real client writes for a caller on another machine: kept in one folder, served by name
// at /files/<name> behind the same bearer token as /mcp, so a remote workshop can fetch what it recorded.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function recordingsDir(): string {
  return process.env.MC_RECORDINGS_DIR || path.join(os.tmpdir(), "mcp-recordings");
}

/** A bare file name inside the recordings folder, or null when it is not a safe plain name. */
export function recordingPath(name: string): string | null {
  if (!NAME.test(name) || name.includes("..")) {
    return null;
  }
  return path.join(recordingsDir(), name);
}

export function isBareName(value: string): boolean {
  return !value.includes("/") && !value.includes("\\");
}

export function downloadPath(file: string | undefined): string | undefined {
  if (!file || path.dirname(file) !== recordingsDir()) {
    return undefined;
  }
  return `/files/${path.basename(file)}`;
}
