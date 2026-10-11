// Ad-hoc signs the mac app (no Developer ID yet, identity: null). Apple silicon refuses to run unsigned code,
// and a consistent ad-hoc signature over the whole bundle keeps the app launchable after our own updater swaps it.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterSign(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • afterSign: ad-hoc signed ${app}`);
};
