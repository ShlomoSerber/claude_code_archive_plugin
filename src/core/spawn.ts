/**
 * How to launch the detached worker (ARCHITECTURE §4).
 *
 * A pure function so the incantation can be unit-tested on every platform,
 * rather than only on whichever one CI happens to run.
 *
 * The three options are not optional: without `detached`, without non-inherited
 * `stdio`, and without `unref()` on the returned child, the worker dies with the
 * hook that started it.
 */

export type SpawnSpec = {
  command: string;
  args: string[];
  options: {
    detached: boolean;
    stdio: 'ignore';
    windowsHide: boolean;
    env: Record<string, string | undefined>;
    cwd: string;
  };
};

export function workerSpawnSpec(args: {
  /** Always `process.execPath`, never the string "node": PATH lies on Windows. */
  execPath: string;
  workerPath: string;
  env: Record<string, string | undefined>;
  cwd: string;
  extraArgs?: string[];
}): SpawnSpec {
  return {
    command: args.execPath,
    args: [args.workerPath, ...(args.extraArgs ?? [])],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: args.env,
      cwd: args.cwd,
    },
  };
}

/** `ARCHIVE_NO_DETACH=1` runs the worker inline, for debugging and tests. */
export function detachDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env['ARCHIVE_NO_DETACH'];
  return value !== undefined && value !== '' && value !== '0';
}
