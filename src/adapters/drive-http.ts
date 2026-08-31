import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FatalError, RetryableError, UploadSessionExpired } from '../core/errors.ts';
import { nullLogger, type Logger } from '../ports/logger.ts';
import type { DriveTransport, RemoteFile, StorageQuota, UploadProgress } from '../ports/drive.ts';
import { describeApiError, readJson, type HttpClient, type SendOptions } from './http-client.ts';
import { renameWithRetry, siblingTempPath } from './atomic.ts';
import { REAUTH_REMEDIATION, type AuthProvider } from './google-auth.ts';

/**
 * Google Drive over plain REST (ARCHITECTURE §6).
 *
 * No `googleapis` package: it is large, it drags in its own HTTP stack, and the
 * dozen endpoints this plugin uses are simpler to read as URLs than as a
 * generated client.
 */

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,size,sha256Checksum,md5Checksum,trashed';

/** Drive wants chunks in multiples of 256 KiB; 8 MiB balances retries and calls. */
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const CHUNK_ALIGNMENT = 256 * 1024;

export type DriveDeps = {
  http: HttpClient;
  auth: AuthProvider;
  logger?: Logger;
};

export function createDriveTransport(deps: DriveDeps): DriveTransport {
  const logger = deps.logger ?? nullLogger;

  /**
   * Every call goes through here: it attaches the token and, on a 401, refreshes
   * once and retries. A token can expire between our check and Drive's clock.
   */
  const authorized = async (url: string, options: SendOptions = {}): Promise<Response> => {
    const send = async (): Promise<Response> => {
      const token = await deps.auth.getAccessToken(options.signal);
      return deps.http.send(url, {
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${token}` },
        expect: [...(options.expect ?? []), 401],
      });
    };
    const first = await send();
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => undefined);
    logger.debug('drive.token_rejected_retrying');
    const second = await send();
    if (second.status === 401) {
      await second.body?.cancel().catch(() => undefined);
      throw new FatalError('Google rejected the access token', REAUTH_REMEDIATION);
    }
    return second;
  };

  const failIfNotOk = async (response: Response, what: string): Promise<unknown> => {
    const body = await readJson(response);
    if (response.ok) return body;
    const message = `${what}: ${describeApiError(response.status, body)}`;
    if (response.status === 403 && isQuotaExhausted(body)) {
      throw new FatalError(message, 'Free space in Google Drive, then run /archive:now.');
    }
    // 403 is how Drive signals a rate limit as well as a refusal. Classing the
    // former as fatal made the reaper read "slow down" as "the archive is gone".
    if (response.status === 403 && isRateLimited(body)) {
      throw new RetryableError(message, { status: response.status });
    }
    if (response.status >= 400 && response.status < 500) {
      throw new FatalError(message, 'Run /archive:status for details.');
    }
    throw new RetryableError(message, { status: response.status });
  };

  const listOne = async (
    query: string,
    signal: AbortSignal | undefined,
  ): Promise<RemoteFile | null> => {
    const url = new URL(`${API}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', `files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', '1');
    url.searchParams.set('spaces', 'drive');
    const response = await authorized(url.toString(), signal === undefined ? {} : { signal });
    const body = await failIfNotOk(response, 'listing Drive files');
    const files = (body as { files?: unknown } | null)?.files;
    if (!Array.isArray(files) || files.length === 0) return null;
    return toRemoteFile(files[0]);
  };

  const createFolder = async (
    name: string,
    parentId: string,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const url = new URL(`${API}/files`);
    url.searchParams.set('fields', 'id');
    const response = await authorized(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      ...(signal === undefined ? {} : { signal }),
    });
    const body = await failIfNotOk(response, `creating the folder ${name}`);
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') throw new RetryableError('Drive created a folder with no id');
    return id;
  };

  return {
    async ensureFolder(pathSegments: string[], signal?: AbortSignal): Promise<string> {
      let parentId = 'root';
      for (const segment of pathSegments) {
        const existing = await listOne(
          `name = '${escapeQuery(segment)}' and mimeType = '${FOLDER_MIME}' ` +
            `and '${escapeQuery(parentId)}' in parents and trashed = false`,
          signal,
        );
        parentId = existing?.id ?? (await createFolder(segment, parentId, signal));
      }
      return parentId;
    },

    async listFiles(args, signal): Promise<RemoteFile[]> {
      const url = new URL(`${API}/files`);
      url.searchParams.set(
        'q',
        `name contains '${escapeQuery(args.namePrefix)}' and '${escapeQuery(args.parentId)}' ` +
          `in parents and trashed = false`,
      );
      url.searchParams.set('fields', `files(${FILE_FIELDS})`);
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('spaces', 'drive');
      const response = await authorized(url.toString(), signal === undefined ? {} : { signal });
      const body = await failIfNotOk(response, 'listing Drive files');
      const files = (body as { files?: unknown } | null)?.files;
      if (!Array.isArray(files)) return [];
      // `name contains` is a prefix-ish match on Drive, so filter exactly.
      return files.map(toRemoteFile).filter((file) => file.name.startsWith(args.namePrefix));
    },

    findFile(args, signal) {
      return listOne(
        `name = '${escapeQuery(args.name)}' and '${escapeQuery(args.parentId)}' in parents ` +
          `and trashed = false`,
        signal,
      );
    },

    async startResumableUpload(args, signal): Promise<string> {
      const url = new URL(UPLOAD_API);
      url.searchParams.set('uploadType', 'resumable');
      url.searchParams.set('fields', FILE_FIELDS);
      const metadata: Record<string, unknown> = { name: args.name, parents: [args.parentId] };
      if (args.appProperties !== undefined) metadata['appProperties'] = args.appProperties;
      const response = await authorized(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': args.mimeType,
          'x-upload-content-length': String(args.totalBytes),
        },
        body: JSON.stringify(metadata),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        await failIfNotOk(response, 'starting a Drive upload');
      }
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (location === null) {
        throw new RetryableError('Drive started an upload without returning a session URI');
      }
      return location;
    },

    async uploadChunk(args, signal): Promise<UploadProgress> {
      const end = args.offset + args.body.length - 1;
      const response = await authorized(args.uploadUri, {
        method: 'PUT',
        headers: {
          'content-range': `bytes ${String(args.offset)}-${String(end)}/${String(args.totalBytes)}`,
        },
        body: args.body,
        // 308 is the normal "keep going" answer, not an error.
        expect: [308, 404, 410],
        retry: false,
        ...(signal === undefined ? {} : { signal }),
      });
      return interpretUploadResponse(response, args.totalBytes);
    },

    async probeUpload(args, signal): Promise<UploadProgress | null> {
      const response = await authorized(args.uploadUri, {
        method: 'PUT',
        headers: { 'content-range': `bytes */${String(args.totalBytes)}` },
        body: '',
        expect: [308, 404, 410],
        ...(signal === undefined ? {} : { signal }),
      });
      try {
        return await interpretUploadResponse(response, args.totalBytes);
      } catch (err) {
        if (err instanceof UploadSessionExpired) return null;
        throw err;
      }
    },

    async uploadSmallFile(args, signal): Promise<RemoteFile> {
      const metadata: Record<string, unknown> = { name: args.name };
      if (args.replaceFileId === undefined) metadata['parents'] = [args.parentId];
      if (args.appProperties !== undefined) metadata['appProperties'] = args.appProperties;

      const boundary = `archive-${Math.random().toString(36).slice(2)}-${String(Date.now())}`;
      const body = multipartBody(boundary, metadata, args.mimeType, args.body);

      const url = new URL(
        args.replaceFileId === undefined ? UPLOAD_API : `${UPLOAD_API}/${args.replaceFileId}`,
      );
      url.searchParams.set('uploadType', 'multipart');
      url.searchParams.set('fields', FILE_FIELDS);

      const response = await authorized(url.toString(), {
        method: args.replaceFileId === undefined ? 'POST' : 'PATCH',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      return toRemoteFile(await failIfNotOk(response, `uploading ${args.name}`));
    },

    async getFile(fileId, signal): Promise<RemoteFile> {
      const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`);
      // Checksums are not returned unless asked for by name.
      url.searchParams.set('fields', FILE_FIELDS);
      const response = await authorized(url.toString(), signal === undefined ? {} : { signal });
      return toRemoteFile(await failIfNotOk(response, 'reading Drive file metadata'));
    },

    async deleteFile(fileId, signal): Promise<void> {
      const response = await authorized(`${API}/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        expect: [404],
        ...(signal === undefined ? {} : { signal }),
      });
      // A file that is already gone is the state we wanted.
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      await failIfNotOk(response, 'deleting a Drive file');
    },

    async trashFile(fileId, signal): Promise<void> {
      const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set('fields', 'id,trashed');
      const response = await authorized(url.toString(), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ trashed: true }),
        expect: [404],
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      await failIfNotOk(response, 'moving a Drive file to the wastebasket');
    },

    async downloadToFile(args, signal): Promise<void> {
      const url = new URL(`${API}/files/${encodeURIComponent(args.fileId)}`);
      url.searchParams.set('alt', 'media');
      const response = await authorized(url.toString(), signal === undefined ? {} : { signal });
      if (!response.ok) await failIfNotOk(response, 'downloading from Drive');
      if (response.body === null) throw new RetryableError('Drive returned an empty body');

      await fsp.mkdir(path.dirname(args.destination), { recursive: true });
      const temp = siblingTempPath(args.destination);
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
        );
        await renameWithRetry(temp, args.destination);
      } catch (err) {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async storageQuota(signal): Promise<StorageQuota> {
      const url = new URL(`${API}/about`);
      url.searchParams.set('fields', 'storageQuota');
      const response = await authorized(url.toString(), signal === undefined ? {} : { signal });
      const body = await failIfNotOk(response, 'reading Drive storage quota');
      const quota = (body as { storageQuota?: unknown } | null)?.storageQuota;
      if (typeof quota !== 'object' || quota === null)
        return { limitBytes: null, usageBytes: null };
      const record = quota as Record<string, unknown>;
      return {
        limitBytes: asNumber(record['limit']),
        usageBytes: asNumber(record['usage']),
      };
    },
  };
}

/**
 * Read the state of a resumable upload out of Drive's answer.
 *
 * The `Range` header is the only trustworthy statement of what landed. Assuming
 * the chunk we just sent arrived intact is how uploads silently corrupt.
 */
export async function interpretUploadResponse(
  response: Response,
  totalBytes: number,
): Promise<UploadProgress> {
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined);
    throw new UploadSessionExpired(`the upload session is gone (HTTP ${String(response.status)})`);
  }
  if (response.status === 308) {
    await response.body?.cancel().catch(() => undefined);
    return {
      confirmedBytes: confirmedFromRange(response.headers.get('range')),
      done: false,
      file: null,
    };
  }
  if (response.ok) {
    const body = await readJson(response);
    return { confirmedBytes: totalBytes, done: true, file: toRemoteFile(body) };
  }
  const body = await readJson(response);
  const message = describeApiError(response.status, body);
  if (response.status >= 400 && response.status < 500) {
    throw new FatalError(
      `Drive refused the upload: ${message}`,
      'Run /archive:status for details.',
    );
  }
  throw new RetryableError(`Drive upload failed: ${message}`, { status: response.status });
}

/** `bytes=0-262143` means 262144 bytes are stored; an absent header means none. */
export function confirmedFromRange(header: string | null): number {
  if (header === null) return 0;
  const match = /bytes=(\d+)-(\d+)/.exec(header.trim());
  if (match === null) return 0;
  return Number(match[2]) + 1;
}

/** Round a chunk size down to Drive's 256 KiB requirement, keeping at least one. */
export function alignChunkSize(size: number): number {
  const aligned = Math.floor(size / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT;
  return aligned > 0 ? aligned : CHUNK_ALIGNMENT;
}

function multipartBody(
  boundary: string,
  metadata: Record<string, unknown>,
  mimeType: string,
  content: Uint8Array,
): Uint8Array {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, Buffer.from(content), tail]);
}

/** Single quotes are the only character that can break a Drive `q` expression. */
export function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function toRemoteFile(value: unknown): RemoteFile {
  if (typeof value !== 'object' || value === null) {
    throw new RetryableError('Drive returned a file with no metadata');
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string') throw new RetryableError('Drive returned a file with no id');
  return {
    id,
    name: typeof record['name'] === 'string' ? record['name'] : '',
    size: asNumber(record['size']),
    sha256: typeof record['sha256Checksum'] === 'string' ? record['sha256Checksum'] : null,
    md5: typeof record['md5Checksum'] === 'string' ? record['md5Checksum'] : null,
    trashed: record['trashed'] === true,
  };
}

/** Drive returns 64-bit counts as strings, because JSON numbers cannot hold them. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRateLimited(body: unknown): boolean {
  const text = JSON.stringify(body ?? '');
  return (
    text.includes('rateLimitExceeded') ||
    text.includes('userRateLimitExceeded') ||
    text.includes('sharingRateLimitExceeded')
  );
}

function isQuotaExhausted(body: unknown): boolean {
  const text = JSON.stringify(body ?? '');
  return text.includes('storageQuotaExceeded') || text.includes('quotaExceeded');
}
