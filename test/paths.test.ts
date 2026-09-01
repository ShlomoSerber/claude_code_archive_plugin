import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';
import {
  encodeProjectDir,
  encodedDirOfTranscript,
  isTruncatedProjectDir,
  locateSession,
  resolveClaudeDir,
  resolveDataDir,
  resolvePaths,
  sessionIdOfTranscript,
} from '../src/core/paths.ts';

const home = (): string => path.join(path.sep, 'home', 'someone');

describe('resolveClaudeDir', () => {
  it('defaults to <home>/.claude', () => {
    assert.equal(resolveClaudeDir({}, home), path.join(home(), '.claude'));
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    const custom = path.join(path.sep, 'srv', 'claude');
    assert.equal(resolveClaudeDir({ CLAUDE_CONFIG_DIR: custom }, home), custom);
  });

  it('ignores a blank CLAUDE_CONFIG_DIR', () => {
    assert.equal(
      resolveClaudeDir({ CLAUDE_CONFIG_DIR: '   ' }, home),
      path.join(home(), '.claude'),
    );
  });
});

describe('resolveDataDir', () => {
  const claudeDir = path.join(home(), '.claude');

  it('prefers the directory Claude Code hands the plugin', () => {
    const provided = path.join(path.sep, 'data', 'plugin');
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: provided }, claudeDir), provided);
  });

  it('lets the test override win over everything', () => {
    const override = path.join(path.sep, 'tmp', 'override');
    assert.equal(
      resolveDataDir({ ARCHIVE_DATA_DIR: override, CLAUDE_PLUGIN_DATA: '/other' }, claudeDir),
      override,
    );
  });

  it('falls back to the location Claude Code would have used', () => {
    // <plugin name>-<marketplace name>, which is what Claude Code derives.
    // A slug of our own invention here meant a bare CLI run opened a second,
    // empty catalog beside the real one and reported an empty archive.
    assert.equal(
      resolveDataDir({}, claudeDir),
      path.join(claudeDir, 'plugins', 'data', 'archive-claude-code-archive'),
    );
  });

  it('keeps using a directory an earlier naming already created', () => {
    const older = path.join(tempDir(), '.claude');
    const legacy = path.join(older, 'plugins', 'data', 'claude-code-archive-plugin');
    fs.mkdirSync(legacy, { recursive: true });
    assert.equal(resolveDataDir({}, older), legacy, 'an early install keeps its catalog');
  });
});

describe('resolvePaths', () => {
  it('keeps plugin state out of the plugin root', () => {
    const paths = resolvePaths({ CLAUDE_PLUGIN_DATA: path.join(path.sep, 'data') }, home);
    assert.equal(paths.projectsDir, path.join(home(), '.claude', 'projects'));
    assert.equal(paths.dbFile, path.join(path.sep, 'data', 'archive.sqlite'));
    assert.equal(paths.tokenFile, path.join(path.sep, 'data', 'tokens.json'));
    assert.ok(
      !paths.dbFile.startsWith(paths.claudeDir + path.sep + 'plugins' + path.sep + 'repos'),
    );
  });
});

describe('encodeProjectDir', () => {
  it('matches the encoding Claude Code uses', () => {
    assert.equal(
      encodeProjectDir('/home/shlomo-serber/Desktop/My Projects/claude_code_archive_plugin'),
      '-home-shlomo-serber-Desktop-My-Projects-claude-code-archive-plugin',
    );
  });

  it('turns each separator character into its own dash', () => {
    assert.equal(encodeProjectDir('/a/90 Seconds - Docs'), '-a-90-Seconds---Docs');
  });

  it('reports when the result is only a truncated prefix', () => {
    const long = `/${'a'.repeat(400)}`;
    assert.equal(isTruncatedProjectDir(long), true);
    assert.equal(encodeProjectDir(long).length, 200);
    assert.equal(isTruncatedProjectDir('/short'), false);
  });
});

describe('reading identity off a transcript path', () => {
  const transcript = path.join(path.sep, 'p', '-home-a-b', 'c0ffee-1234.jsonl');

  it('takes the encoded directory from disk rather than re-encoding', () => {
    assert.equal(encodedDirOfTranscript(transcript), '-home-a-b');
  });

  it('takes the session id from the file name', () => {
    assert.equal(sessionIdOfTranscript(transcript), 'c0ffee-1234');
  });
});

describe('locateSession', () => {
  it('pairs the transcript with its sidecar directory', () => {
    const paths = resolvePaths({ CLAUDE_CONFIG_DIR: path.join(path.sep, 'c') }, home);
    const found = locateSession(paths, '-home-a', 'sess-1');
    assert.equal(
      found.transcriptPath,
      path.join(path.sep, 'c', 'projects', '-home-a', 'sess-1.jsonl'),
    );
    assert.equal(found.sidecarDir, path.join(path.sep, 'c', 'projects', '-home-a', 'sess-1'));
  });
});
