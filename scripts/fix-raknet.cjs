// raknet-native ships prebuilt binaries in folders named <platform>-<kernel major>-<arch> (linux-5-x64), and
// looks only for the running kernel's folder, so on Linux 6.x it finds none and tries to build with cmake.
// The binary does not depend on the kernel version: link the running kernel's folder to the shipped one.
// Install with SKIP_BUILD=1 so raknet-native does not try cmake first; npm runs this as postinstall.
const fs = require('fs');
const os = require('os');
const path = require('path');

function fix(root) {
  // Top level, or nested under bedrock-protocol when npm could not hoist it.
  const paths = [root];
  try { paths.push(path.dirname(require.resolve('bedrock-protocol/package.json', { paths: [root] }))); } catch { /* not installed */ }
  let dir;
  for (const from of paths) {
    try {
      dir = path.join(path.dirname(require.resolve('raknet-native/package.json', { paths: [from] })), 'prebuilds');
      break;
    } catch { /* try the next place */ }
  }
  if (!dir) return 'raknet-native is not installed';
  const want = `${process.platform}-${os.release().split('.', 1)[0]}-${process.arch}`;
  if (fs.existsSync(path.join(dir, want, 'node-raknet.node'))) return `${want} is there`;
  const shipped = fs.readdirSync(dir).find((d) => {
    const [plat, , arch] = d.split('-');
    return plat === process.platform && arch === process.arch && fs.existsSync(path.join(dir, d, 'node-raknet.node'));
  });
  if (!shipped) return `no prebuilt raknet-native for ${process.platform}-${process.arch}; build it with cmake (npm rebuild raknet-native)`;
  fs.symlinkSync(shipped, path.join(dir, want), 'dir');
  return `linked ${want} -> ${shipped}`;
}

if (require.main === module) console.log(`[fix-raknet] ${fix(process.argv[2] || process.cwd())}`);
module.exports = { fix };
