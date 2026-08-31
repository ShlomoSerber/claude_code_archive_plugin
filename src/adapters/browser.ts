import { spawn } from 'node:child_process';

/**
 * Open a URL in the user's browser, best effort.
 *
 * Never throws and never blocks: the caller always prints the URL too, so a
 * headless machine or a missing opener costs the user a copy and paste, not the
 * login.
 *
 * Windows uses `rundll32` rather than `cmd /c start` on purpose — an OAuth URL
 * is full of `&`, which `cmd` treats as a command separator.
 */
export function openUrl(url: string): boolean {
  const command = openCommand(url);
  if (command === null) return false;
  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function openCommand(url: string): { file: string; args: string[] } | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (process.platform === 'darwin') return { file: 'open', args: [url] };
  if (process.platform === 'win32') {
    return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { file: 'xdg-open', args: [url] };
}
