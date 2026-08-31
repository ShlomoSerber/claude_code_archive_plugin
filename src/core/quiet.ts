/**
 * Silence the one warning `node:sqlite` prints on Node 22.
 *
 * Importing this module applies the patch as a side effect, and entry points
 * import it first. That ordering is the whole point: a warning raised while
 * `node:sqlite` loads cannot be suppressed by a call that runs afterwards.
 *
 * A hook that writes to stderr is a hook the user sees, and "ExperimentalWarning:
 * SQLite is an experimental feature" in the middle of a session reads as a
 * broken plugin.
 */

let applied = false;

export function silenceSqliteWarning(): void {
  if (applied) return;
  applied = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = (warning: unknown, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  };
}

function isSqliteExperimentalWarning(warning: unknown, rest: unknown[]): boolean {
  const type = warningType(warning, rest);
  if (type !== 'ExperimentalWarning') return false;
  const text = warning instanceof Error ? warning.message : String(warning);
  return text.includes('SQLite');
}

function warningType(warning: unknown, rest: unknown[]): string {
  const [second] = rest;
  if (typeof second === 'string') return second;
  if (typeof second === 'object' && second !== null) {
    const type = (second as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return warning instanceof Error ? warning.name : '';
}

silenceSqliteWarning();
