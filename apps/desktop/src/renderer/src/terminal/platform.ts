// The OS the renderer runs on, read from the user agent (the preload exposes no `process`).
// Electron's user agent names the OS like Chrome's: "Macintosh", "Windows", "Linux".

export function platformFromUserAgent(userAgent: string): 'darwin' | 'win32' | 'linux' {
  if (/Windows/i.test(userAgent)) return 'win32'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'darwin'
  return 'linux'
}

let cached: 'darwin' | 'win32' | 'linux' | null = null

export function rendererPlatform(): 'darwin' | 'win32' | 'linux' {
  cached ??= platformFromUserAgent(globalThis.navigator?.userAgent ?? '')
  return cached
}
