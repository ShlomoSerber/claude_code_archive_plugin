// Must come first: it silences the node:sqlite warning before SQLite loads.
import '../core/quiet.ts';
import { parseArgs } from 'node:util';
import { createRuntime } from '../composition.ts';
import { FatalError, toErrorInfo } from '../core/errors.ts';
import { NODE_REMEDIATION, nodeVersionProblem } from '../core/runtime-check.ts';
import { alreadyReexeced, findCompatibleNode, reexec } from '../adapters/node-locator.ts';
import { resolvePaths } from '../core/paths.ts';
import { ARCHIVER_VERSION } from '../version.ts';
import { runNow } from './now.ts';
import { runResume } from './resume.ts';
import { runSearch } from './search.ts';
import { runSetup } from './setup.ts';
import { runStatus } from './status.ts';
import { runVerify } from './verify.ts';
import { ignoreClosedPipe, print, warn } from './output.ts';

/**
 * One CLI, one bundle, six subcommands.
 *
 * The slash commands in `commands/` are thin wrappers around this: they carry
 * the prose that tells Claude what to do with the output, and this carries the
 * work. Data goes to stdout so Claude can read it; diagnostics go to stderr.
 */

const USAGE = `claude-archive <command> [options]

  setup     Sign in to Google, take over transcript cleanup, back up what exists
  status    What is local, what is archived, what is stuck
  now       Run a sweep immediately
  search    Find candidate sessions for a free-text query
  resume    Restore a session and print the command to resume it
  verify    Check archived bundles against their stored hashes

Common options
  --json            Machine-readable output
  --limit <n>       Candidates to return (search, resume, verify)

setup   --device          Use the no-browser device flow
        --reauth          Sign in again even if a token exists
        --skip-backfill   Do not back up existing sessions now
search  --since <date>    ISO date lower bound
        --until <date>    ISO date upper bound
        --project <path>  Restrict to one project directory
        --files           Include the files each session touched
        --text            Human-readable instead of JSON
verify  --all             Check every archived session, not a sample
status  --quota           Also ask Drive how much space is used`;

async function main(): Promise<number> {
  ignoreClosedPipe();

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean' },
      text: { type: 'boolean' },
      device: { type: 'boolean' },
      reauth: { type: 'boolean' },
      'skip-backfill': { type: 'boolean' },
      all: { type: 'boolean' },
      files: { type: 'boolean' },
      quota: { type: 'boolean' },
      limit: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });

  const command = positionals[0];
  if (values.version === true) {
    print(ARCHIVER_VERSION);
    return 0;
  }
  if (values.help === true || command === undefined || command === 'help') {
    print(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }

  const problem = nodeVersionProblem();
  if (problem !== null) {
    if (!alreadyReexeced(process.env)) {
      const better = findCompatibleNode({ cacheFile: resolvePaths(process.env).runtimeCacheFile });
      if (better !== null) return reexec(better.path);
    }
    warn(problem);
    warn(NODE_REMEDIATION);
    return 1;
  }

  const runtime = await createRuntime();
  try {
    const json = values.json === true;
    const query = positionals.slice(1).join(' ');

    switch (command) {
      case 'setup':
        return await runSetup(runtime, {
          device: values.device === true,
          reauth: values.reauth === true,
          skipBackfill: values['skip-backfill'] === true,
          json,
        });
      case 'status':
        return await runStatus(runtime, { json, quota: values.quota === true });
      case 'now':
        return await runNow(runtime, { json });
      case 'search':
        return runSearch(runtime, {
          query,
          limit: parseLimit(values.limit, 30),
          since: parseDate(values.since),
          until: parseDate(values.until),
          project: typeof values.project === 'string' ? values.project : null,
          files: values.files === true,
          // Search feeds the model, so JSON is the default here.
          json: values.text !== true,
        });
      case 'resume':
        return await runResume(runtime, {
          query,
          limit: parseLimit(values.limit, 30),
          json: values.text !== true,
        });
      case 'verify':
        return await runVerify(runtime, {
          limit: parseLimit(values.limit, 20),
          all: values.all === true,
          json,
        });
      default:
        warn(`Unknown command: ${command}`);
        print(USAGE);
        return 1;
    }
  } finally {
    runtime.close();
  }
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(500, Math.trunc(parsed)) : fallback;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed) ? null : parsed;
}

try {
  process.exitCode = await main();
} catch (err) {
  // A command runs in front of a person, so it says what went wrong and, when
  // it knows, what to do about it.
  if (err instanceof FatalError) {
    warn(err.message);
    warn(err.remediation);
  } else {
    const info = toErrorInfo(err);
    warn(`${info.name}: ${info.message}`);
  }
  process.exitCode = 1;
}
