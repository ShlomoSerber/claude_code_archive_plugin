/**
 * Catalog extraction from a transcript (SPEC §4, ARCHITECTURE §8).
 *
 * The JSONL format is internal to Claude Code and changes between versions, so
 * every field read here is optional and every failure is soft. A session whose
 * transcript we cannot parse still gets archived byte for byte; it just lands
 * in the catalog with a thin entry.
 *
 * The extractor is a fold over lines, not a whole-file parse: transcripts reach
 * hundreds of megabytes and must never be held in memory.
 */

/** Beyond this a prompt is an artefact of a paste, not something to index. */
export const MAX_PROMPT_CHARS = 8_000;
export const MAX_PROMPTS = 1_000;
export const MAX_FILES = 500;

export type ExtractedPrompt = {
  seq: number;
  ts: number | null;
  text: string;
};

export type TranscriptSummary = {
  sessionId: string | null;
  title: string | null;
  /** The most recent prompt, kept as a one-line description of the session. */
  lastPrompt: string | null;
  projectCwd: string | null;
  gitBranch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  messageCount: number;
  prompts: ExtractedPrompt[];
  files: string[];
  /** Lines that were not valid JSON. A few are normal; many mean trouble. */
  malformedLines: number;
};

type Record_ = Record<string, unknown>;

export type Extractor = {
  pushLine(line: string): void;
  finish(): TranscriptSummary;
};

export function createExtractor(): Extractor {
  let sessionId: string | null = null;
  let title: string | null = null;
  let lastPrompt: string | null = null;
  let projectCwd: string | null = null;
  let gitBranch: string | null = null;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let messageCount = 0;
  let malformedLines = 0;
  const prompts: ExtractedPrompt[] = [];
  const files = new Set<string>();

  const noteTimestamp = (record: Record_): void => {
    const ts = parseTimestamp(record['timestamp']);
    if (ts === null) return;
    if (startedAt === null || ts < startedAt) startedAt = ts;
    if (endedAt === null || ts > endedAt) endedAt = ts;
  };

  return {
    pushLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let record: Record_;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) {
          malformedLines++;
          return;
        }
        record = parsed as Record_;
      } catch {
        malformedLines++;
        return;
      }

      sessionId ??= asString(record['sessionId']);
      const type = asString(record['type']);

      if (type === 'ai-title') {
        // Later titles supersede earlier ones: Claude Code refines them.
        title = asString(record['aiTitle']) ?? title;
        return;
      }
      if (type === 'summary') {
        title ??= asString(record['summary']);
        return;
      }
      if (type === 'last-prompt') {
        lastPrompt = asString(record['lastPrompt']) ?? lastPrompt;
        return;
      }
      if (type !== 'user' && type !== 'assistant') return;

      noteTimestamp(record);
      projectCwd ??= asString(record['cwd']);
      const branch = asString(record['gitBranch']);
      if (branch !== null && branch.length > 0) gitBranch = branch;

      // Subagent transcripts are part of the session's bytes but not part of
      // its conversation; counting them would distort every catalog number.
      if (record['isSidechain'] === true) return;
      messageCount++;

      if (type === 'assistant') {
        collectToolPaths(record, files);
        return;
      }
      if (record['isMeta'] === true) return;
      if (record['toolUseResult'] !== undefined) return;

      const text = userPromptText(record);
      if (text === null) return;
      if (prompts.length >= MAX_PROMPTS) return;
      prompts.push({
        seq: prompts.length,
        ts: parseTimestamp(record['timestamp']),
        text: text.slice(0, MAX_PROMPT_CHARS),
      });
    },

    finish(): TranscriptSummary {
      return {
        sessionId,
        title,
        lastPrompt: lastPrompt ?? prompts.at(-1)?.text ?? null,
        projectCwd,
        gitBranch,
        startedAt,
        endedAt,
        messageCount,
        prompts,
        files: [...files].slice(0, MAX_FILES),
        malformedLines,
      };
    },
  };
}

/**
 * Pull the text a person actually typed out of a `user` record.
 *
 * Claude Code puts several different things in this record type: real prompts,
 * slash-command invocations, command output echoed back, and system reminders.
 * Only the first two are worth indexing.
 */
export function userPromptText(record: Record_): string | null {
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record_)['content'];

  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const blockRecord = block as Record_;
      // A tool_result block means this record is machinery, not a prompt.
      if (blockRecord['type'] === 'tool_result') return null;
      if (blockRecord['type'] === 'text') {
        const value = asString(blockRecord['text']);
        if (value !== null) parts.push(value);
      }
    }
    if (parts.length === 0) return null;
    text = parts.join('\n');
  } else {
    return null;
  }

  return cleanPromptText(text);
}

const SYNTHETIC_PREFIXES = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<system-reminder>',
  '<user-memory-input>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];

/**
 * Strip the wrappers Claude Code adds, and reject records that are output
 * rather than input. Returns null when nothing a person typed remains.
 */
export function cleanPromptText(raw: string): string | null {
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (text.length === 0) return null;

  for (const prefix of SYNTHETIC_PREFIXES) {
    if (text.startsWith(prefix)) return null;
  }

  // A slash command: keep it, as `/archive:search foo`, since the user typed it.
  const commandName = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (commandName !== null) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    const name = (commandName[1] ?? '').trim();
    const argText = (args?.[1] ?? '').trim();
    const joined = argText.length > 0 ? `${name} ${argText}` : name;
    return joined.length > 0 ? joined : null;
  }

  // A caveat block can precede a real prompt; drop the block, keep the prompt.
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim();
  return text.length > 0 ? text : null;
}

/** Record every file an assistant turn read or wrote, for the catalog. */
function collectToolPaths(record: Record_, into: Set<string>): void {
  if (into.size >= MAX_FILES) return;
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return;
  const content = (message as Record_)['content'];
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const blockRecord = block as Record_;
    if (blockRecord['type'] !== 'tool_use') continue;
    const input = blockRecord['input'];
    if (typeof input !== 'object' || input === null) continue;
    const inputRecord = input as Record_;
    for (const key of ['file_path', 'notebook_path', 'path']) {
      const value = asString(inputRecord[key]);
      if (value !== null && value.length > 0 && into.size < MAX_FILES) into.add(value);
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  // Rounded, not merely finite: these land in STRICT INTEGER columns, and a
  // fractional value makes the insert throw, which fails the whole backup for
  // that session silently and permanently.
  // Safe-integer, not merely finite: 1e300 truncates to itself, and a value
  // SQLite's STRICT INTEGER column cannot hold throws out of the *insert*,
  // which is outside the fail-soft boundary around parsing — so one absurd
  // timestamp made a session permanently unarchivable.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    return Number.isSafeInteger(truncated) ? truncated : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.trunc(parsed);
}
