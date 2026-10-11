// Keeps node-pty's spawn-helper executable (asar unpack / zip steps can drop the exec bit; without it every
// terminal fails with "posix_spawnp failed") and makes the bundled CLI wrappers executable.
const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

function walk(dir, fn) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, fn);
    else fn(p, e);
  }
}

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName === 'win32') return;
  const resources =
    ctx.electronPlatformName === 'darwin'
      ? join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(ctx.appOutDir, 'resources');
  let n = 0;
  walk(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'), (p, name) => {
    if (name === 'spawn-helper') {
      chmodSync(p, 0o755);
      n++;
    }
  });
  walk(join(resources, 'cli', 'bin'), (p, name) => {
    if (!name.endsWith('.cmd') && !name.endsWith('.ps1')) chmodSync(p, 0o755);
  });
  console.log(`  • afterPack: chmod +x on ${n} spawn-helper file(s)`);
};
