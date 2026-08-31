/**
 * Command output helpers.
 *
 * Data goes to stdout, diagnostics to stderr. Claude reads stdout, so anything
 * a command wants a person *or* a model to act on must go there.
 */

/**
 * Stop a closed stdout from killing the process.
 *
 * `archive status | head` closes the pipe as soon as head has what it wants,
 * and the next write raises EPIPE. Unhandled, that surfaces as a stack trace
 * on a command that actually succeeded.
 */
export function ignoreClosedPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function warn(line: string): void {
  process.stderr.write(`${line}\n`);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0);
  return `${rounded} ${UNITS[unit] ?? 'B'}`;
}

export function formatDate(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || epochMs <= 0) return '—';
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16);
}

export function formatRelative(epochMs: number | null | undefined, now: number): string {
  if (epochMs === null || epochMs === undefined || epochMs <= 0) return 'never';
  const seconds = Math.round((now - epochMs) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

/** Cut a prompt down to one readable line for a candidate card. */
export function snippet(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
