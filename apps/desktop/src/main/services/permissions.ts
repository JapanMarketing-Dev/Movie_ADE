// macOS camera / microphone / screen recording permissions.
import { shell, systemPreferences } from 'electron';
import type { MediaPermissionState } from '../../shared/types';

export function permissionState(): MediaPermissionState {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return { camera: 'granted', microphone: 'granted', screen: 'granted' };
  return {
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
  };
}

export async function askMediaAccess(kind: 'camera' | 'microphone'): Promise<boolean> {
  if (process.platform !== 'darwin') return systemPreferences.getMediaAccessStatus?.(kind) !== 'denied';
  return systemPreferences.askForMediaAccess(kind);
}

export function openScreenRecordingSettings(): void {
  if (process.platform === 'darwin') {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  } else if (process.platform === 'win32') {
    void shell.openExternal('ms-settings:privacy-webcam');
  }
}
