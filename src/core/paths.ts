import path from 'node:path';
import os from 'node:os';

/**
 * Where everything lives, on all three platforms.
 *
 * Nothing here touches the filesystem: these are pure path computations so the
 * tests can drive them with a fake environment.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export type ArchivePaths = {
  /** Claude Code's own config root: `$CLAUDE_CONFIG_DIR` or `<home>/.claude`. */
  readonly claudeDir: string;
  /** `<claudeDir>/projects` — one subdirectory per encoded working directory. */
  readonly projectsDir: string;
  /** `<claudeDir>/settings.json` — where `cleanupPeriodDays` is set. */
  readonly settingsFile: string;
  /** Plugin-owned state: `$CLAUDE_PLUGIN_DATA`, wiped on neither update nor upgrade. */
  readonly dataDir: string;
  readonly dbFile: string;
  readonly logFile: string;
  readonly tokenFile: string;
  readonly statusFile: string;
  readonly lockDir: string;
  /** Remembers which interpreter satisfied the Node floor, to skip rescanning. */
  readonly runtimeCacheFile: string;
  /** Scratch space for `.partial` bundles, a sibling of nothing else. */
  readonly stagingDir: string;
  /** Downloads in progress. Separate from staging, which sweeps clean out. */
  readonly restoreDir: string;
};

/**
 * `CLAUDE_CONFIG_DIR` overrides the location of Claude Code's data. Never
 * hardcode `~`: Windows has no such thing, and tests need to redirect it.
 */
export function resolveClaudeDir(env: Environment, homedir: () => string = os.homedir): string {
  const configured = trimmed(env['CLAUDE_CONFIG_DIR']);
  if (configured !== undefined) return path.resolve(configured);
  return path.join(homedir(), '.claude');
}

/**
 * Claude Code sets `CLAUDE_PLUGIN_DATA` for plugin hooks and commands, and
 * creates the directory before running us. Outside that context (a bare CLI
 * run, a test) we fall back to the same location Claude Code would have used.
 */
export function resolveDataDir(env: Environment, claudeDir: string): string {
  const override = trimmed(env['ARCHIVE_DATA_DIR']);
  if (override !== undefined) return path.resolve(override);
  const provided = trimmed(env['CLAUDE_PLUGIN_DATA']);
  if (provided !== undefined) return path.resolve(provided);
  return path.join(claudeDir, 'plugins', 'data', DEFAULT_PLUGIN_SLUG);
}

const DEFAULT_PLUGIN_SLUG = 'claude-code-archive-plugin';

export function resolvePaths(env: Environment, homedir: () => string = os.homedir): ArchivePaths {
  const claudeDir = resolveClaudeDir(env, homedir);
  const dataDir = resolveDataDir(env, claudeDir);
  return {
    claudeDir,
    projectsDir: path.join(claudeDir, 'projects'),
    settingsFile: path.join(claudeDir, 'settings.json'),
    dataDir,
    dbFile: path.join(dataDir, 'archive.sqlite'),
    logFile: path.join(dataDir, 'archive.log'),
    tokenFile: path.join(dataDir, 'tokens.json'),
    statusFile: path.join(dataDir, 'status.json'),
    lockDir: path.join(dataDir, 'worker.lock'),
    runtimeCacheFile: path.join(dataDir, 'runtime.json'),
    stagingDir: path.join(dataDir, 'staging'),
    restoreDir: path.join(dataDir, 'restoring'),
  };
}

/**
 * Claude Code's encoding of a working directory into a project folder name:
 * every character outside `[a-zA-Z0-9]` becomes `-`, and names longer than 200
 * characters get truncated plus a hash suffix we cannot reproduce.
 *
 * The encoding is lossy, so it is never the source of truth. Prefer
 * {@link encodedDirOfTranscript}, which reads the real name off disk; this
 * function exists for lookups where only a cwd is known.
 */
export function encodeProjectDir(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return encoded.length <= PROJECT_DIR_MAX ? encoded : encoded.slice(0, PROJECT_DIR_MAX);
}

const PROJECT_DIR_MAX = 200;

/** True when {@link encodeProjectDir} had to truncate, so its result is a prefix. */
export function isTruncatedProjectDir(cwd: string): boolean {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').length > PROJECT_DIR_MAX;
}

/** `<projects>/<encoded>/<session>.jsonl` → `<encoded>`. */
export function encodedDirOfTranscript(transcriptPath: string): string {
  return path.basename(path.dirname(transcriptPath));
}

/** `<projects>/<encoded>/<session>.jsonl` → `<session>`. */
export function sessionIdOfTranscript(transcriptPath: string): string {
  return path.basename(transcriptPath, '.jsonl');
}

/**
 * A session is a transcript plus an optional sidecar directory of the same
 * name holding tool results and subagent transcripts.
 */
export type SessionLocation = {
  readonly sessionId: string;
  readonly encodedDir: string;
  readonly transcriptPath: string;
  readonly sidecarDir: string;
};

export function locateSession(
  paths: ArchivePaths,
  encodedDir: string,
  sessionId: string,
): SessionLocation {
  const dir = path.join(paths.projectsDir, encodedDir);
  return {
    sessionId,
    encodedDir,
    transcriptPath: path.join(dir, `${sessionId}.jsonl`),
    sidecarDir: path.join(dir, sessionId),
  };
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}
