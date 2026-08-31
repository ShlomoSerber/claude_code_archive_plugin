/**
 * Reading the JSON Claude Code writes to a hook's stdin.
 *
 * The timeout matters: a hook that blocks on a stdin that never closes blocks
 * the session. Two seconds is far longer than this ever takes and still short
 * enough that a user would not notice the worst case.
 */

export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionStart: startup, resume, clear, compact, fork. */
  source?: string;
  /** SessionEnd: clear, resume, logout, prompt_input_exit, other. */
  reason?: string;
  /** Present for subagent sessions, which are archived with their parent. */
  agent_id?: string;
};

export async function readHookInput(timeoutMs = 2_000): Promise<HookInput | null> {
  const text = await readStdin(timeoutMs);
  if (text === null || text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readStdin(timeoutMs: number): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null);
    }, timeoutMs);
    timer.unref();

    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      finish(null);
    });
  });
}

/**
 * Ask Claude Code to show the user a message.
 *
 * `systemMessage` on stdout is the hook channel for this; stderr would surface
 * as an error and make a working plugin look broken.
 */
export function emitSystemMessage(message: string): void {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}
