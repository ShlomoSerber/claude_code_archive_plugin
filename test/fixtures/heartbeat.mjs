// Writes a file after its parent has certainly exited. If this file appears,
// the child really was detached.
import fs from 'node:fs';

const target = process.argv[2];
setTimeout(() => {
  fs.writeFileSync(target, `alive ${String(process.pid)}`);
}, 400);
