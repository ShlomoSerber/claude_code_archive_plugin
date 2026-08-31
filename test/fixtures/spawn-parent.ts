// Spawns the heartbeat through the real spawnWorker, then exits immediately.
import { spawnWorker } from '../../src/adapters/spawn-worker.ts';

const [workerPath, target] = process.argv.slice(2);
spawnWorker({
  workerPath: workerPath ?? '',
  env: { ...process.env, ARCHIVE_NO_DETACH: '' },
  cwd: process.cwd(),
  extraArgs: [target ?? ''],
});
process.exit(0);
