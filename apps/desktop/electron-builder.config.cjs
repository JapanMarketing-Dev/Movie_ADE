// electron-builder configuration for Solocut (docs/07).
// mac: ad-hoc signed (no Developer ID yet), so updates are applied by our own updater, not Squirrel.
// node-pty ships N-API prebuilds for mac/win; on Linux CI set SOLOCUT_REBUILD_NATIVE=1 to rebuild it.

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.solocut.desktop',
  productName: 'Solocut',
  copyright: 'Copyright © 2026 JapanMarketing-Dev (MIT)',
  directories: { output: 'release', buildResources: 'build' },
  artifactName: 'Solocut-${version}-${os}-${arch}.${ext}',
  // Everything JS is bundled by electron-vite; the only runtime node_modules entry is node-pty (native).
  files: ['out/**/*', 'package.json', '!**/*.map', '!node_modules/**/*', 'node_modules/node-pty/**/*', '!node_modules/node-pty/{src,deps,third_party,scripts,typings}/**/*'],
  asar: true,
  asarUnpack: ['**/node_modules/node-pty/**'],
  extraResources: [
    { from: 'resources/cli', to: 'cli', filter: ['**/*'] },
    { from: 'resources/templates', to: 'templates', filter: ['**/*'] },
  ],
  npmRebuild: process.env.SOLOCUT_REBUILD_NATIVE === '1',
  nodeGypRebuild: false,
  afterPack: './scripts/after-pack.cjs',
  afterSign: './scripts/after-sign.cjs',
  publish: null,

  mac: {
    category: 'public.app-category.video',
    icon: 'build/icon.icns',
    // arch comes from the CLI (--arm64 / --x64); release CI builds both.
    target: ['dmg', 'zip'],
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    darkModeSupport: true,
    minimumSystemVersion: '12.0',
    extendInfo: {
      NSCameraUsageDescription: 'Solocut records your camera for your videos.',
      NSMicrophoneUsageDescription: 'Solocut records your microphone for your videos.',
      NSScreenCaptureUsageDescription: 'Solocut records your screen for tutorial videos.',
      NSAudioCaptureUsageDescription: 'Solocut records system audio when you turn it on.',
      LSApplicationCategoryType: 'public.app-category.video',
    },
  },
  dmg: {
    sign: false,
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    shortcutName: 'Solocut',
  },

  linux: {
    // The npm package name (@solocut/desktop) is not a valid file name; name the binary explicitly.
    executableName: 'solocut-desktop',
    icon: 'build/icons',
    category: 'AudioVideo',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    maintainer: 'JapanMarketing-Dev <takumi.endoh@japan-marketing.co.jp>',
    synopsis: 'The ADE for video editing',
  },
  deb: { depends: ['libnotify4', 'libxtst6', 'libnss3'] },
};
