import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const entities = require('prismarine-viewer/viewer/lib/entity/entities.json');
const texturesRoot = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public', 'textures');

function indexByBasename(dir) {
  const index = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.png') && !index.has(entry.name)) index.set(entry.name, full);
    }
  };
  walk(dir);
  return index;
}

let linked = 0;
let missing = 0;
for (const version of fs.readdirSync(texturesRoot, { withFileTypes: true })) {
  if (!version.isDirectory()) continue;
  const versionDir = path.join(texturesRoot, version.name);
  const entityDir = path.join(versionDir, 'entity');
  if (!fs.existsSync(entityDir)) continue;
  const index = indexByBasename(entityDir);

  for (const def of Object.values(entities)) {
    for (const texture of Object.values(def.textures ?? {})) {
      const target = path.join(versionDir, `${texture.replace(/^textures/, '')}.png`);
      if (fs.existsSync(target)) continue;
      const source = index.get(path.basename(target));
      if (!source) { missing++; continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      linked++;
    }
  }
}
console.log(`entity textures linked: ${linked}, still missing: ${missing}`);
