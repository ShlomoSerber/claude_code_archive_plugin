/**
 * Plugin configuration.
 *
 * Defaults are chosen so the plugin does the right thing with no config file at
 * all. Everything is overridable by file, and by environment for tests and
 * one-off runs.
 */

export type ArchiveConfig = {
  /** Local copies are deleted after this many idle days (SPEC §2). */
  retentionDays: number;
  /** Top-level Drive folder that holds the whole archive. */
  driveRootFolder: string;
  /** zstd level for bundles. 19 is the measured 3.7x point. */
  zstdLevel: number;
  /** How long a hook waits before its job becomes runnable, coalescing fires. */
  debounceMs: number;
  /** Sweeps closer together than this are skipped. */
  sweepMinIntervalMs: number;
  /** How long a worker may run before it stops and leaves the rest requeued. */
  workerBudgetMs: number;
  /** Visibility timeout on a claimed job. */
  jobVisibilityMs: number;
  /** Set false to stop all archiving without uninstalling. */
  enabled: boolean;
  /** Skip reaping entirely: back everything up, delete nothing. */
  keepLocalForever: boolean;
};

export const DEFAULT_CONFIG: ArchiveConfig = {
  retentionDays: 30,
  driveRootFolder: 'ClaudeArchive',
  zstdLevel: 19,
  debounceMs: 5_000,
  sweepMinIntervalMs: 10 * 60_000,
  workerBudgetMs: 20 * 60_000,
  jobVisibilityMs: 15 * 60_000,
  enabled: true,
  keepLocalForever: false,
};

export const DAY_MS = 86_400_000;

/**
 * Claude Code's own transcript reaper is disabled by setting this (SPEC §2).
 * Never 0 — that value disables transcript writing entirely
 * (anthropics/claude-code#23710) — and never much larger, which overflows the
 * date arithmetic.
 */
export const CLEANUP_PERIOD_DAYS = 365_000;

type Source = Readonly<Record<string, unknown>>;

/** File values override defaults; environment values override the file. */
export function resolveConfig(
  file: Source | null,
  env: Readonly<Record<string, string | undefined>>,
): ArchiveConfig {
  const config = { ...DEFAULT_CONFIG };
  applySource(config, file ?? {});
  applySource(config, envSource(env));
  return clamp(config);
}

function applySource(config: ArchiveConfig, source: Source): void {
  const retention = asNumber(source['retentionDays']);
  if (retention !== null) config.retentionDays = retention;
  const folder = asString(source['driveRootFolder']);
  if (folder !== null && folder.length > 0) config.driveRootFolder = folder;
  const level = asNumber(source['zstdLevel']);
  if (level !== null) config.zstdLevel = level;
  const debounce = asNumber(source['debounceMs']);
  if (debounce !== null) config.debounceMs = debounce;
  const sweepInterval = asNumber(source['sweepMinIntervalMs']);
  if (sweepInterval !== null) config.sweepMinIntervalMs = sweepInterval;
  const budget = asNumber(source['workerBudgetMs']);
  if (budget !== null) config.workerBudgetMs = budget;
  const visibility = asNumber(source['jobVisibilityMs']);
  if (visibility !== null) config.jobVisibilityMs = visibility;
  const enabled = asBoolean(source['enabled']);
  if (enabled !== null) config.enabled = enabled;
  const keepLocal = asBoolean(source['keepLocalForever']);
  if (keepLocal !== null) config.keepLocalForever = keepLocal;
}

function envSource(env: Readonly<Record<string, string | undefined>>): Source {
  return {
    retentionDays: env['ARCHIVE_RETENTION_DAYS'],
    driveRootFolder: env['ARCHIVE_DRIVE_FOLDER'],
    zstdLevel: env['ARCHIVE_ZSTD_LEVEL'],
    debounceMs: env['ARCHIVE_DEBOUNCE_MS'],
    sweepMinIntervalMs: env['ARCHIVE_SWEEP_INTERVAL_MS'],
    workerBudgetMs: env['ARCHIVE_WORKER_BUDGET_MS'],
    enabled: env['ARCHIVE_ENABLED'],
    keepLocalForever: env['ARCHIVE_KEEP_LOCAL_FOREVER'],
  };
}

/**
 * Bound every value to something survivable.
 *
 * A retention of 0 days would delete a session the moment it was verified,
 * which is legal but almost certainly a typo; one day is the floor.
 */
function clamp(config: ArchiveConfig): ArchiveConfig {
  return {
    ...config,
    retentionDays: clampNumber(config.retentionDays, 1, 36_500, DEFAULT_CONFIG.retentionDays),
    zstdLevel: clampNumber(config.zstdLevel, 1, 22, DEFAULT_CONFIG.zstdLevel),
    debounceMs: clampNumber(config.debounceMs, 0, 60_000, DEFAULT_CONFIG.debounceMs),
    sweepMinIntervalMs: clampNumber(
      config.sweepMinIntervalMs,
      0,
      24 * 3_600_000,
      DEFAULT_CONFIG.sweepMinIntervalMs,
    ),
    workerBudgetMs: clampNumber(
      config.workerBudgetMs,
      10_000,
      6 * 3_600_000,
      DEFAULT_CONFIG.workerBudgetMs,
    ),
    jobVisibilityMs: clampNumber(
      config.jobVisibilityMs,
      30_000,
      6 * 3_600_000,
      DEFAULT_CONFIG.jobVisibilityMs,
    ),
  };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

/** The cutoff a session's last activity must fall before to be reapable. */
export function reapCutoff(now: number, retentionDays: number): number {
  return now - retentionDays * DAY_MS;
}
