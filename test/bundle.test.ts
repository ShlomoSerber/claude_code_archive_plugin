import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createBundle,
  describeSessionFiles,
  extractBundle,
  listBundle,
  toPosix,
} from '../src/adapters/bundle.ts';
import { sha256File, sha256OfBuffer } from '../src/adapters/hashing.ts';
import { tempDir } from './helpers.ts';

const SESSION = 'sess-1';

/** A project directory holding one transcript plus its sidecar directory. */
function makeSession(transcript = '{"type":"user"}\n'): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), transcript);
  fs.mkdirSync(path.join(dir, SESSION, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, SESSION, 'tool.json'), '{"result":"ok"}');
  fs.writeFileSync(path.join(dir, SESSION, 'nested', 'sub.jsonl'), '{"agent":true}');
  fs.writeFileSync(path.join(dir, 'other-session.jsonl'), 'not part of this bundle');
  return dir;
}

const ENTRIES = [`${SESSION}.jsonl`, SESSION];

describe('createBundle', () => {
  it('packs the transcript and its sidecar, and nothing else', async () => {
    const cwd = makeSession();
    const out = path.join(tempDir(), 'bundle.tar.zst');
    await createBundle({ cwd, entries: ENTRIES, outputPath: out });
    const names = (await listBundle(out)).map((entry) => entry.path).sort();
    assert.deepEqual(names, [
      'sess-1.jsonl',
      'sess-1/',
      'sess-1/nested/',
      'sess-1/nested/sub.jsonl',
      'sess-1/tool.json',
    ]);
  });

  it('reports the sha256 of the bytes it wrote', async () => {
    const cwd = makeSession();
    const out = path.join(tempDir(), 'bundle.tar.zst');
    const result = await createBundle({ cwd, entries: ENTRIES, outputPath: out });
    assert.equal(result.sha256, await sha256File(out));
    assert.equal(result.bytes, fs.statSync(out).size);
  });

  it('leaves no partial file behind on success', async () => {
    const cwd = makeSession();
    const dir = tempDir();
    await createBundle({ cwd, entries: ENTRIES, outputPath: path.join(dir, 'b.tar.zst') });
    assert.deepEqual(await fsp.readdir(dir), ['b.tar.zst']);
  });

  it('leaves no partial file behind on failure', async () => {
    const dir = tempDir();
    await assert.rejects(
      createBundle({
        cwd: path.join(tempDir(), 'does-not-exist'),
        entries: ['missing.jsonl'],
        outputPath: path.join(dir, 'b.tar.zst'),
      }),
    );
    assert.deepEqual(await fsp.readdir(dir), []);
  });

  it('actually compresses, at the level it was asked for', async () => {
    const cwd = makeSession('{"type":"user","text":"hello"}\n'.repeat(5000));
    const out = path.join(tempDir(), 'bundle.tar.zst');
    const raw = fs.statSync(path.join(cwd, `${SESSION}.jsonl`)).size;
    const result = await createBundle({ cwd, entries: ENTRIES, outputPath: out });
    assert.equal(result.compressionLevel, 19);
    assert.ok(result.bytes * 10 < raw, `${result.bytes} vs ${raw}`);
  });

  it('starts the zstd frame with the zstd magic number', async () => {
    const cwd = makeSession();
    const out = path.join(tempDir(), 'bundle.tar.zst');
    await createBundle({ cwd, entries: ENTRIES, outputPath: out });
    const head = await fsp.readFile(out);
    assert.equal(head.subarray(0, 4).toString('hex'), '28b52ffd');
  });
});

describe('extractBundle', () => {
  it('restores the session byte for byte', async () => {
    const cwd = makeSession('{"line":1}\n{"line":2}\n');
    const out = path.join(tempDir(), 'bundle.tar.zst');
    await createBundle({ cwd, entries: ENTRIES, outputPath: out });

    const target = tempDir();
    await extractBundle({ bundlePath: out, targetDir: target });

    assert.equal(
      await sha256File(path.join(target, `${SESSION}.jsonl`)),
      await sha256File(path.join(cwd, `${SESSION}.jsonl`)),
    );
    assert.equal(
      await fsp.readFile(path.join(target, SESSION, 'nested', 'sub.jsonl'), 'utf8'),
      '{"agent":true}',
    );
  });

  it('creates the destination directory when it is missing', async () => {
    const cwd = makeSession();
    const out = path.join(tempDir(), 'bundle.tar.zst');
    await createBundle({ cwd, entries: ENTRIES, outputPath: out });
    const target = path.join(tempDir(), 'new', 'projects', '-home-a');
    const result = await extractBundle({ bundlePath: out, targetDir: target });
    assert.ok(result.entries.includes(`${SESSION}.jsonl`));
  });

  it('survives a round trip of non-ASCII content', async () => {
    const cwd = tempDir();
    const text = '{"prompt":"añadir sesión 🎉"}\n';
    fs.writeFileSync(path.join(cwd, `${SESSION}.jsonl`), text, 'utf8');
    const out = path.join(tempDir(), 'bundle.tar.zst');
    await createBundle({ cwd, entries: [`${SESSION}.jsonl`], outputPath: out });
    const target = tempDir();
    await extractBundle({ bundlePath: out, targetDir: target });
    assert.equal(await fsp.readFile(path.join(target, `${SESSION}.jsonl`), 'utf8'), text);
  });
});

describe('describeSessionFiles', () => {
  it('hashes every file, sorted, with posix paths', async () => {
    const cwd = makeSession();
    const described = await describeSessionFiles({ cwd, entries: ENTRIES });
    assert.deepEqual(
      described.map((file) => file.path),
      ['sess-1.jsonl', 'sess-1/nested/sub.jsonl', 'sess-1/tool.json'],
    );
    assert.equal(described[2]?.sha256, sha256OfBuffer('{"result":"ok"}'));
    assert.equal(described[2]?.bytes, 15);
  });

  it('skips an entry that is not there', async () => {
    const cwd = makeSession();
    const described = await describeSessionFiles({ cwd, entries: ['nope.jsonl', SESSION] });
    assert.equal(described.length, 2);
  });
});

describe('toPosix', () => {
  it('leaves an already-posix path alone', () => {
    assert.equal(toPosix('sess-1/tool.json'), 'sess-1/tool.json');
  });
});
