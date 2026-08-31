import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  rankCandidates,
  satisfiesFloor,
  versionFromPath,
  type NodeCandidate,
} from '../core/node-discovery.ts';
import { MIN_NODE_VERSION } from '../core/runtime-check.ts';
import type { Environment } from '../core/paths.ts';

/**
 * Finding an installed Node that meets the floor (filesystem half).
 *
 * Synchronous on purpose. This runs at the very top of a hook, before stdin has
 * been touched, and only on the cold path where the current interpreter is too
 * old. On a correctly configured machine it never runs at all.
 */

export type FoundNode = { path: string; version: string };

export type LocateOptions = {
  env?: Environment;
  homedir?: () => string;
  /** Injected in tests so no real interpreter has to be executed. */
  verify?: (candidatePath: string) => string | null;
  cacheFile?: string;
  minVersion?: string;
};

/** Ask an interpreter its own version. The one expense worth paying. */
export function probeVersion(candidatePath: string): string | null {
  try {
    const result = spawnSync(candidatePath, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const version = result.stdout.trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}

export function findCompatibleNode(options: LocateOptions = {}): FoundNode | null {
  const env = options.env ?? process.env;
  const homedir = (options.homedir ?? os.homedir)();
  const verify = options.verify ?? probeVersion;
  const minVersion = options.minVersion ?? MIN_NODE_VERSION;

  const cached = readCache(options.cacheFile);
  if (cached !== null && fs.existsSync(cached.path) && satisfiesFloor(cached.version, minVersion)) {
    return cached;
  }

  for (const candidate of rankCandidates(collectCandidates(env, homedir), minVersion)) {
    const version = verify(candidate.path);
    if (version === null || !satisfiesFloor(version, minVersion)) continue;
    const found: FoundNode = { path: candidate.path, version };
    writeCache(options.cacheFile, found);
    return found;
  }
  return null;
}

/** Every place the mainstream version managers put an interpreter. */
export function collectCandidates(env: Environment, homedir: string): NodeCandidate[] {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates: NodeCandidate[] = [];

  const add = (candidatePath: string): void => {
    candidates.push({ path: candidatePath, version: versionFromPath(candidatePath) });
  };

  /** Expand one directory level: `<root>/<each child>/<tail...>`. */
  const addVersioned = (root: string, ...tail: string[]): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(root, entry, ...tail, exe);
      if (fs.existsSync(full)) add(full);
    }
  };

  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    const localAppData = env['LOCALAPPDATA'];
    const programFiles = env['ProgramFiles'];
    if (appData !== undefined) addVersioned(path.join(appData, 'nvm'));
    if (localAppData !== undefined) {
      addVersioned(path.join(localAppData, 'fnm', 'node-versions'), 'installation');
      addVersioned(path.join(localAppData, 'Volta', 'tools', 'image', 'node'));
      addIfPresent(path.join(localAppData, 'Programs', 'nodejs', exe), add);
    }
    if (programFiles !== undefined) addIfPresent(path.join(programFiles, 'nodejs', exe), add);
  } else {
    const nvm = env['NVM_DIR'] ?? path.join(homedir, '.nvm');
    addVersioned(path.join(nvm, 'versions', 'node'), 'bin');

    for (const fnm of [
      env['FNM_DIR'],
      path.join(homedir, '.fnm'),
      path.join(homedir, '.local', 'share', 'fnm'),
    ]) {
      if (fnm !== undefined) addVersioned(path.join(fnm, 'node-versions'), 'installation', 'bin');
    }

    addVersioned(path.join(homedir, '.volta', 'tools', 'image', 'node'), 'bin');
    addVersioned(path.join(homedir, '.local', 'share', 'mise', 'installs', 'node'), 'bin');
    addVersioned(path.join(homedir, '.asdf', 'installs', 'nodejs'), 'bin');

    for (const fixed of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      addIfPresent(fixed, add);
    }
  }

  return candidates;
}

function addIfPresent(candidatePath: string, add: (value: string) => void): void {
  if (fs.existsSync(candidatePath)) add(candidatePath);
}

/**
 * Re-run this process under `nodePath`.
 *
 * `stdio: 'inherit'` matters more than it looks: a hook's JSON payload is still
 * unread on stdin at this point, and the child is the one that has to read it.
 */
export function reexec(nodePath: string, env: NodeJS.ProcessEnv = process.env): number {
  const result = spawnSync(nodePath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...env, ARCHIVE_REEXEC: '1' },
    windowsHide: true,
  });
  return result.status ?? 1;
}

/** True once we have already re-executed, so a loop is impossible. */
export function alreadyReexeced(env: Environment): boolean {
  const value = env['ARCHIVE_REEXEC'];
  return value !== undefined && value !== '' && value !== '0';
}

function readCache(file: string | undefined): FoundNode | null {
  if (file === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { path: cachedPath, version } = parsed as Partial<FoundNode>;
    if (typeof cachedPath !== 'string' || typeof version !== 'string') return null;
    return { path: cachedPath, version };
  } catch {
    return null;
  }
}

function writeCache(file: string | undefined, found: FoundNode): void {
  if (file === undefined) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(found)}\n`, { mode: 0o600 });
  } catch {
    // The cache is an optimisation; losing it costs a directory scan.
  }
}
