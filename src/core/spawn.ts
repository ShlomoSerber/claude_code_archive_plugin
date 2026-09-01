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
    stdio: 'ignore' | 'inherit';
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
  /** Debugging: keep the child attached and let its output through. */
  attached?: boolean;
}): SpawnSpec {
  return {
    command: args.execPath,
    args: [args.workerPath, ...(args.extraArgs ?? [])],
    options: {
      detached: args.attached !== true,
      // Never 'inherit', even attached: the hook's stdout pipe would stay open
      // for the worker's whole life, so the session waited on it and the
      // worker's output landed on the hook's JSON channel. The worker logs to
      // a file; that is where its output belongs.
      stdio: 'ignore',
      windowsHide: true,
      env: args.env,
      cwd: args.cwd,
    },
  };
}

/**
 * `ARCHIVE_NO_DETACH=1` keeps the worker attached to its parent, with its
 * output inherited, for debugging.
 *
 * It used to mean "do not start the worker at all", which quietly turned the
 * whole plugin off: hooks kept queueing sessions and nothing ever uploaded one.
 * A debugging switch must not be a way to lose data.
 */
export function detachDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env['ARCHIVE_NO_DETACH'];
  return value !== undefined && value !== '' && value !== '0';
}
