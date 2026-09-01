import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  cleanPromptText,
  createExtractor,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
} from '../src/core/transcript.ts';
import { extractFromFile } from '../src/adapters/transcript-file.ts';
import { tempDir } from './helpers.ts';

/** Shapes taken from a real Claude Code transcript, trimmed to what we read. */
const LINES = [
  { type: 'last-prompt', leafUuid: 'u1', sessionId: 'sess-1', lastPrompt: 'ship it' },
  { type: 'mode', mode: 'normal', sessionId: 'sess-1' },
  {
    type: 'user',
    isMeta: true,
    userType: 'external',
    sessionId: 'sess-1',
    timestamp: '2026-08-31T10:00:00.000Z',
    cwd: '/home/a/project',
    gitBranch: 'main',
    message: { role: 'user', content: '<local-command-caveat>ignore me</local-command-caveat>' },
  },
  {
    type: 'user',
    userType: 'external',
    promptSource: 'typed',
    sessionId: 'sess-1',
    timestamp: '2026-08-31T10:01:00.000Z',
    cwd: '/home/a/project',
    gitBranch: 'main',
    message: { role: 'user', content: 'Fix the auth redirect loop' },
  },
  {
    type: 'assistant',
    sessionId: 'sess-1',
    timestamp: '2026-08-31T10:01:30.000Z',
    cwd: '/home/a/project',
    gitBranch: 'feature/auth',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking at it.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/home/a/project/src/auth.ts' } },
      ],
    },
  },
  {
    type: 'user',
    userType: 'external',
    sessionId: 'sess-1',
    timestamp: '2026-08-31T10:02:00.000Z',
    toolUseResult: { ok: true },
    message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
  },
  {
    type: 'user',
    isSidechain: true,
    sessionId: 'sess-1',
    timestamp: '2026-08-31T10:03:00.000Z',
    message: { role: 'user', content: 'subagent instruction' },
  },
  { type: 'ai-title', aiTitle: 'Auth redirect fix', sessionId: 'sess-1' },
  {
    type: 'user',
    userType: 'external',
    sessionId: 'sess-1',
    timestamp: '2026-08-31T10:04:00.000Z',
    message: {
      role: 'user',
      content:
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
    },
  },
];

function extractAll(lines: unknown[]): ReturnType<ReturnType<typeof createExtractor>['finish']> {
  const extractor = createExtractor();
  for (const line of lines) extractor.pushLine(JSON.stringify(line));
  return extractor.finish();
}

describe('createExtractor', () => {
  it('pulls the identity, title and project out of a transcript', () => {
    const summary = extractAll(LINES);
    assert.equal(summary.sessionId, 'sess-1');
    assert.equal(summary.title, 'Auth redirect fix');
    assert.equal(summary.projectCwd, '/home/a/project');
  });

  it('keeps the last non-empty git branch', () => {
    assert.equal(extractAll(LINES).gitBranch, 'feature/auth');
  });

  it('spans the first and last timestamps', () => {
    const summary = extractAll(LINES);
    assert.equal(summary.startedAt, Date.parse('2026-08-31T10:00:00.000Z'));
    assert.equal(summary.endedAt, Date.parse('2026-08-31T10:04:00.000Z'));
  });

  it('indexes what the user typed, and nothing else', () => {
    const summary = extractAll(LINES);
    assert.deepEqual(
      summary.prompts.map((prompt) => prompt.text),
      ['Fix the auth redirect loop', '/model opus'],
    );
  });

  it('excludes subagent turns from the message count', () => {
    // Two user prompts, one meta, one tool result, one assistant turn.
    assert.equal(extractAll(LINES).messageCount, 5);
  });

  it('records the files the assistant touched', () => {
    assert.deepEqual(extractAll(LINES).files, ['/home/a/project/src/auth.ts']);
  });

  it('survives a truncated final line', () => {
    const extractor = createExtractor();
    extractor.pushLine(JSON.stringify(LINES[3]));
    extractor.pushLine('{"type":"user","message":{"content":"cut off');
    const summary = extractor.finish();
    assert.equal(summary.malformedLines, 1);
    assert.equal(summary.prompts.length, 1);
  });

  it('survives a format it has never seen', () => {
    const summary = extractAll([{ type: 'something-new-in-2027', payload: { nested: true } }]);
    assert.equal(summary.prompts.length, 0);
    assert.equal(summary.malformedLines, 0);
  });

  it('ignores blank lines', () => {
    const extractor = createExtractor();
    extractor.pushLine('');
    extractor.pushLine('   ');
    assert.equal(extractor.finish().malformedLines, 0);
  });

  it('caps a pasted wall of text', () => {
    const summary = extractAll([
      {
        type: 'user',
        sessionId: 's',
        message: { role: 'user', content: 'x'.repeat(MAX_PROMPT_CHARS * 2) },
      },
    ]);
    assert.equal(summary.prompts[0]?.text.length, MAX_PROMPT_CHARS);
  });

  it('falls back to the last prompt when there is no title', () => {
    const summary = extractAll([LINES[0]]);
    assert.equal(summary.title, null);
    assert.equal(summary.lastPrompt, 'ship it');
  });
});

describe('cleanPromptText', () => {
  it('drops command output', () => {
    assert.equal(cleanPromptText('<local-command-stdout>ok</local-command-stdout>'), null);
  });

  it('drops a record that is only a system reminder', () => {
    assert.equal(cleanPromptText('<system-reminder>context</system-reminder>'), null);
  });

  it('keeps the prompt when a system reminder is attached to it', () => {
    assert.equal(
      cleanPromptText('<system-reminder>context</system-reminder>\nreal question'),
      'real question',
    );
  });

  it('renders a slash command the way the user typed it', () => {
    assert.equal(
      cleanPromptText(
        '<command-name>/archive:search</command-name><command-args>auth</command-args>',
      ),
      '/archive:search auth',
    );
  });

  it('keeps a slash command with no arguments', () => {
    assert.equal(
      cleanPromptText('<command-name>/status</command-name><command-args></command-args>'),
      '/status',
    );
  });
});

describe('extractFromFile', () => {
  it('reads a transcript off disk line by line', async () => {
    const file = path.join(tempDir(), 'sess-1.jsonl');
    await fsp.writeFile(file, LINES.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
    const summary = await extractFromFile(file);
    assert.equal(summary.title, 'Auth redirect fix');
    assert.equal(summary.prompts.length, 2);
  });

  it('handles CRLF line endings', async () => {
    const file = path.join(tempDir(), 'sess-crlf.jsonl');
    await fsp.writeFile(file, LINES.map((line) => JSON.stringify(line)).join('\r\n'), 'utf8');
    assert.equal((await extractFromFile(file)).prompts.length, 2);
  });
});

describe('a session with more prompts than the cap', () => {
  it('keeps the opening and the most recent, not the first thousand', () => {
    // The later prompts are the ones a person remembers; keeping only the
    // first N made a long session unsearchable by anything it ended with.
    const extractor = createExtractor();
    for (let index = 0; index < MAX_PROMPTS + 200; index++) {
      extractor.pushLine(
        JSON.stringify({
          type: 'user',
          userType: 'external',
          message: { role: 'user', content: `prompt ${String(index)}` },
        }),
      );
    }
    const result = extractor.finish();
    assert.equal(result.prompts.length, MAX_PROMPTS);
    assert.equal(result.prompts[0]?.text, 'prompt 0', 'the opening survives');
    assert.equal(
      result.prompts[result.prompts.length - 1]?.text,
      `prompt ${String(MAX_PROMPTS + 199)}`,
      'and so does the end',
    );
  });
});
