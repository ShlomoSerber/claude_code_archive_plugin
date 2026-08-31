import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FatalError, UploadSessionExpired } from '../../src/core/errors.ts';
import type {
  DriveTransport,
  RemoteFile,
  StorageQuota,
  UploadProgress,
} from '../../src/ports/drive.ts';

/**
 * An in-memory Drive.
 *
 * It models the parts of the real one that the archive depends on and that are
 * hard to reproduce with a live account: partially received uploads, expired
 * session URIs, and a remote whose checksum disagrees with ours.
 */

type StoredFile = {
  id: string;
  name: string;
  parentId: string;
  mimeType: string;
  content: Buffer;
  appProperties: Record<string, string>;
};

type Session = {
  uri: string;
  name: string;
  parentId: string;
  totalBytes: number;
  received: Buffer;
  appProperties: Record<string, string>;
  expired: boolean;
};

export type FakeDriveOptions = {
  /** Accept only this many bytes of each chunk, to force a resume. */
  truncateChunksTo?: number;
  /** Report a checksum that does not match, to exercise verification. */
  corruptChecksums?: boolean;
  /** Report every file as being in the wastebasket, awaiting purge. */
  trashed?: boolean;
  /** Return no checksum at all, as Drive does for some files. */
  omitSha256?: boolean;
  /** Start failing uploads once this many have succeeded, to model a bad day. */
  failUploadsAfter?: number;
};

export class FakeDrive implements DriveTransport {
  readonly files = new Map<string, StoredFile>();
  readonly folders = new Map<string, { id: string; name: string; parentId: string }>();
  readonly calls: string[] = [];
  /** Ids in the wastebasket: still present, but no longer stored. */
  readonly trashedIds = new Set<string>();
  options: FakeDriveOptions;

  private sessions = new Map<string, Session>();
  private nextId = 1;
  private completedUploads = 0;

  constructor(options: FakeDriveOptions = {}) {
    this.options = options;
  }

  /** Force every open upload session to behave as if it had expired. */
  expireUploadSessions(): void {
    for (const session of this.sessions.values()) session.expired = true;
  }

  fileByName(name: string): StoredFile | undefined {
    return [...this.files.values()].find((file) => file.name === name);
  }

  ensureFolder(pathSegments: string[]): Promise<string> {
    this.calls.push(`ensureFolder:${pathSegments.join('/')}`);
    let parentId = 'root';
    for (const segment of pathSegments) {
      const existing = [...this.folders.values()].find(
        (folder) => folder.name === segment && folder.parentId === parentId,
      );
      if (existing !== undefined) {
        parentId = existing.id;
        continue;
      }
      const id = `folder-${String(this.nextId++)}`;
      this.folders.set(id, { id, name: segment, parentId });
      parentId = id;
    }
    return Promise.resolve(parentId);
  }

  listFiles(args: { parentId: string; namePrefix: string }): Promise<RemoteFile[]> {
    this.calls.push(`listFiles:${args.namePrefix}`);
    return Promise.resolve(
      [...this.files.values()]
        .filter((file) => file.parentId === args.parentId && file.name.startsWith(args.namePrefix))
        .map((file) => this.describe(file)),
    );
  }

  findFile(args: { name: string; parentId: string }): Promise<RemoteFile | null> {
    this.calls.push(`findFile:${args.name}`);
    const found = [...this.files.values()].find(
      (file) => file.name === args.name && file.parentId === args.parentId,
    );
    return Promise.resolve(found === undefined ? null : this.describe(found));
  }

  startResumableUpload(args: {
    name: string;
    parentId: string;
    totalBytes: number;
    appProperties?: Record<string, string>;
  }): Promise<string> {
    this.calls.push(`startResumableUpload:${args.name}`);
    const uri = `https://upload.test/session/${String(this.nextId++)}`;
    this.sessions.set(uri, {
      uri,
      name: args.name,
      parentId: args.parentId,
      totalBytes: args.totalBytes,
      received: Buffer.alloc(0),
      appProperties: args.appProperties ?? {},
      expired: false,
    });
    return Promise.resolve(uri);
  }

  uploadChunk(args: {
    uploadUri: string;
    body: Uint8Array;
    offset: number;
    totalBytes: number;
  }): Promise<UploadProgress> {
    this.calls.push(`uploadChunk:${String(args.offset)}`);
    const session = this.sessions.get(args.uploadUri);
    if (session === undefined || session.expired) {
      throw new UploadSessionExpired('no such upload session');
    }
    if (args.offset !== session.received.length) {
      throw new Error(`chunk offset ${String(args.offset)} does not continue the upload`);
    }
    const accepted =
      this.options.truncateChunksTo === undefined
        ? args.body
        : args.body.subarray(0, Math.min(args.body.length, this.options.truncateChunksTo));
    session.received = Buffer.concat([session.received, Buffer.from(accepted)]);

    if (session.received.length < session.totalBytes) {
      return Promise.resolve({ confirmedBytes: session.received.length, done: false, file: null });
    }
    if (
      this.options.failUploadsAfter !== undefined &&
      this.completedUploads >= this.options.failUploadsAfter
    ) {
      this.sessions.delete(args.uploadUri);
      throw new Error('Drive is having a bad day');
    }
    this.completedUploads++;
    const stored = this.store(session);
    this.sessions.delete(args.uploadUri);
    return Promise.resolve({ confirmedBytes: session.totalBytes, done: true, file: stored });
  }

  probeUpload(args: { uploadUri: string; totalBytes: number }): Promise<UploadProgress | null> {
    this.calls.push('probeUpload');
    const session = this.sessions.get(args.uploadUri);
    if (session === undefined || session.expired) return Promise.resolve(null);
    return Promise.resolve({
      confirmedBytes: session.received.length,
      done: false,
      file: null,
    });
  }

  uploadSmallFile(args: {
    name: string;
    parentId: string;
    mimeType: string;
    body: Uint8Array;
    appProperties?: Record<string, string>;
    replaceFileId?: string;
  }): Promise<RemoteFile> {
    this.calls.push(`uploadSmallFile:${args.name}`);
    const id = args.replaceFileId ?? `file-${String(this.nextId++)}`;
    const file: StoredFile = {
      id,
      name: args.name,
      parentId: args.parentId,
      mimeType: args.mimeType,
      content: Buffer.from(args.body),
      appProperties: args.appProperties ?? {},
    };
    this.files.set(id, file);
    return Promise.resolve(this.describe(file));
  }

  getFile(fileId: string): Promise<RemoteFile> {
    this.calls.push(`getFile:${fileId}`);
    const file = this.files.get(fileId);
    // The real transport turns Drive 4xx, including 404, into a FatalError.
    // A fake that throws something else lets code pass tests it would fail
    // against Google.
    if (file === undefined) {
      throw new FatalError(`no such file ${fileId}`, 'Run /archive:now to re-upload it.');
    }
    return Promise.resolve(this.describe(file));
  }

  trashFile(fileId: string): Promise<void> {
    this.calls.push(`trashFile:${fileId}`);
    if (this.files.has(fileId)) this.trashedIds.add(fileId);
    return Promise.resolve();
  }

  deleteFile(fileId: string): Promise<void> {
    this.calls.push(`deleteFile:${fileId}`);
    this.files.delete(fileId);
    return Promise.resolve();
  }

  async downloadToFile(args: { fileId: string; destination: string }): Promise<void> {
    this.calls.push(`downloadToFile:${args.fileId}`);
    const file = this.files.get(args.fileId);
    if (file === undefined) {
      throw new FatalError(`no such file ${args.fileId}`, 'Run /archive:now to re-upload it.');
    }
    await fsp.mkdir(path.dirname(args.destination), { recursive: true });
    await fsp.writeFile(args.destination, file.content);
  }

  storageQuota(): Promise<StorageQuota> {
    const used = [...this.files.values()].reduce((total, file) => total + file.content.length, 0);
    return Promise.resolve({ limitBytes: 15 * 1024 ** 3, usageBytes: used });
  }

  private store(session: Session): RemoteFile {
    const id = `file-${String(this.nextId++)}`;
    const file: StoredFile = {
      id,
      name: session.name,
      parentId: session.parentId,
      mimeType: 'application/zstd',
      content: session.received,
      appProperties: session.appProperties,
    };
    this.files.set(id, file);
    return this.describe(file);
  }

  private describe(file: StoredFile): RemoteFile {
    const sha256 = createHash('sha256').update(file.content).digest('hex');
    const md5 = createHash('md5').update(file.content).digest('hex');
    return {
      id: file.id,
      name: file.name,
      size: file.content.length,
      sha256:
        this.options.omitSha256 === true
          ? null
          : this.options.corruptChecksums === true
            ? 'f'.repeat(64)
            : sha256,
      md5: this.options.omitSha256 === true ? null : md5,
      trashed: this.options.trashed === true || this.trashedIds.has(file.id),
    };
  }
}
