import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { createExtractor, type TranscriptSummary } from '../core/transcript.ts';

/**
 * Stream a transcript through the extractor.
 *
 * Line by line, never whole-file: real transcripts run to hundreds of
 * megabytes, and this runs in a background worker that must stay small.
 */
export async function extractFromFile(
  file: string,
  signal?: AbortSignal,
): Promise<TranscriptSummary> {
  const extractor = createExtractor();
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      extractor.pushLine(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return extractor.finish();
}
