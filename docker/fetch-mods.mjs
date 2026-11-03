#!/usr/bin/env node
// Fetch client mods or shaderpacks into a folder. Used at image build time for the pinned cinematic mods and at client
// launch for things that may not be baked into a public image (private mods, shaderpacks under their own licences).
//
//   node fetch-mods.mjs <dir> <entry>...
//
// An entry is either `modrinth:<project>:<version_number>` (verified against Modrinth's sha512) or `<file>=<url>` (a
// private file; MC_EXTRA_MODS_TOKEN, when set, is sent as a bearer token and GitHub release asset URLs get the
// octet-stream Accept header). Files that are already there are kept.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function parseEntry(entry) {
  const m = /^modrinth:([a-z0-9_-]+):(.+)$/i.exec(entry);
  if (m) return { kind: "modrinth", project: m[1], version: m[2] };
  const eq = entry.indexOf("=");
  if (eq > 0 && /^https:\/\//.test(entry.slice(eq + 1))) {
    const file = entry.slice(0, eq);
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.(jar|zip)$/.test(file)) throw new Error(`not a plain mod file name: ${file}`);
    return { kind: "url", file, url: entry.slice(eq + 1) };
  }
  throw new Error(`unknown entry: ${entry}`);
}

async function download(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} for ${url.replace(/\?.*/, "")}`);
  return Buffer.from(await res.arrayBuffer());
}

async function modrinth(dir, project, version) {
  const versions = await (await fetch(`https://api.modrinth.com/v2/project/${project}/version`, { headers: { "user-agent": "minecraft-mcp-server" } })).json();
  const hit = versions.find((v) => v.version_number === version);
  if (!hit) throw new Error(`${project} ${version} not on Modrinth`);
  const file = hit.files.find((f) => f.primary) ?? hit.files[0];
  const dest = path.join(dir, file.filename);
  if (fs.existsSync(dest)) return dest;
  const body = await download(file.url, { "user-agent": "minecraft-mcp-server" });
  const sha = crypto.createHash("sha512").update(body).digest("hex");
  if (sha !== file.hashes.sha512) throw new Error(`${file.filename}: sha512 mismatch`);
  fs.writeFileSync(dest, body);
  return dest;
}

async function privateFile(dir, file, url) {
  const dest = path.join(dir, file);
  if (fs.existsSync(dest)) return dest;
  const headers = { "user-agent": "minecraft-mcp-server" };
  if (process.env.MC_EXTRA_MODS_TOKEN) headers.authorization = `Bearer ${process.env.MC_EXTRA_MODS_TOKEN}`;
  if (/api\.github\.com\/repos\/.+\/releases\/assets\//.test(url)) headers.accept = "application/octet-stream";
  const body = await download(url, headers);
  const temp = `${dest}.part`;
  fs.writeFileSync(temp, body);
  fs.renameSync(temp, dest);
  return dest;
}

export async function fetchAll(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const raw of entries.filter(Boolean)) {
    const e = parseEntry(raw);
    out.push(e.kind === "modrinth" ? await modrinth(dir, e.project, e.version) : await privateFile(dir, e.file, e.url));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, ...entries] = process.argv.slice(2);
  fetchAll(dir, entries.flatMap((e) => e.split(/\s+/)))
    .then((files) => files.forEach((f) => console.log(`fetched ${path.basename(f)}`)))
    .catch((err) => { console.error(`fetch-mods: ${err.message}`); process.exit(1); });
}
