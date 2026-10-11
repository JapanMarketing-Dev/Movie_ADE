// Generates build/icon.icns, build/icon.ico, build/icon.png (512) and build/icons/*.png from brand/icon-1024.png.
// macOS only (uses sips + iconutil). The outputs are committed so other platforms can build without this script.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const brand = join(app, '..', '..', 'brand');
const build = join(app, 'build');
const src = join(brand, 'icon-1024.png');

mkdirSync(build, { recursive: true });
copyFileSync(src, join(build, 'icon-1024.png'));
copyFileSync(join(brand, 'icon.svg'), join(build, 'icon.svg'));

function resize(size, out) {
  execFileSync('sips', ['-z', String(size), String(size), src, '--out', out], { stdio: 'ignore' });
}

// icon.png (512) for electron-builder / linux
resize(512, join(build, 'icon.png'));

// Linux icon set
const linuxDir = join(build, 'icons');
mkdirSync(linuxDir, { recursive: true });
for (const s of [16, 32, 48, 64, 128, 256, 512]) resize(s, join(linuxDir, `${s}x${s}.png`));

// icns
const iconset = join(build, 'icon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  resize(s, join(iconset, `icon_${s}x${s}.png`));
  resize(s * 2, join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')]);
rmSync(iconset, { recursive: true, force: true });

// ico: PNG-compressed entries (supported since Windows Vista)
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map((s) => {
  const out = join(build, `.ico-${s}.png`);
  resize(s, out);
  const data = readFileSync(out);
  rmSync(out);
  return { s, data };
});
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const entries = [];
let offset = 6 + 16 * pngs.length;
for (const { s, data } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  entries.push(e);
}
writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
console.log('icons written to', build);
