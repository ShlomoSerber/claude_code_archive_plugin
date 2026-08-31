/**
 * The storage seam (ARCHITECTURE, module layout).
 *
 * Google Drive is the only implementation in v1, but every method here is
 * expressed in terms the archive cares about — folders, bundles, checksums —
 * not in Drive's vocabulary. That is what keeps the backend swappable and what
 * lets almost every test run against a fake instead of HTTP.
 */

export type RemoteFile = {
  id: string;
  name: string;
  /** Bytes as the remote reports them, not as we believe them to be. */
  size: number | null;
  sha256: string | null;
  md5: string | null;
  /**
   * In the remote's wastebasket, awaiting purge.
   *
   * Drive answers a metadata request for a trashed file with a normal 200 and
   * a valid checksum; only a permanent delete gives a 404. So "the request
   * succeeded" is not the same as "the archive still holds this", and code that
   * conflates them will delete a local copy against a bundle that has about
   * thirty days left to live.
   */
  trashed: boolean;
};

export type UploadProgress = {
  /** Bytes the remote has confirmed. Resume from here, never from memory. */
  confirmedBytes: number;
  done: boolean;
  file: RemoteFile | null;
};

export type StorageQuota = {
  limitBytes: number | null;
  usageBytes: number | null;
};

export interface DriveTransport {
  /** Create the folder chain if needed and return the deepest folder's id. */
  ensureFolder(pathSegments: string[], signal?: AbortSignal): Promise<string>;

  /** Files in a folder whose name starts with `prefix`. */
  listFiles(
    args: { parentId: string; namePrefix: string },
    signal?: AbortSignal,
  ): Promise<RemoteFile[]>;

  /** Find a file by exact name inside a folder, or null. */
  findFile(
    args: { name: string; parentId: string },
    signal?: AbortSignal,
  ): Promise<RemoteFile | null>;

  /**
   * Begin a resumable upload and return its session URI.
   *
   * The caller must persist that URI before sending any bytes: it is the
   * upload's idempotency key, and it stays valid for about a week.
   */
  startResumableUpload(
    args: {
      name: string;
      parentId: string;
      mimeType: string;
      totalBytes: number;
      appProperties?: Record<string, string>;
    },
    signal?: AbortSignal,
  ): Promise<string>;

  /** Send one chunk. `offset` is the absolute position of `body[0]`. */
  uploadChunk(
    args: { uploadUri: string; body: Uint8Array; offset: number; totalBytes: number },
    signal?: AbortSignal,
  ): Promise<UploadProgress>;

  /**
   * Ask the remote how much of an interrupted upload it actually holds.
   * Returns null when the session has expired and must be restarted.
   */
  probeUpload(
    args: { uploadUri: string; totalBytes: number },
    signal?: AbortSignal,
  ): Promise<UploadProgress | null>;

  /** Upload a small file in one request; used for manifests and the catalog. */
  uploadSmallFile(
    args: {
      name: string;
      parentId: string;
      mimeType: string;
      body: Uint8Array;
      appProperties?: Record<string, string>;
      replaceFileId?: string;
    },
    signal?: AbortSignal,
  ): Promise<RemoteFile>;

  /** Metadata including checksums, which must be requested explicitly. */
  getFile(fileId: string, signal?: AbortSignal): Promise<RemoteFile>;

  /** Permanent. Only for a file this run created and then rejected. */
  deleteFile(fileId: string, signal?: AbortSignal): Promise<void>;

  /**
   * Move to the remote's wastebasket, where it can still be recovered.
   *
   * Anything that retires a bundle believed to be good goes through here. A
   * permanent delete makes one wrong decision anywhere upstream unrecoverable;
   * the wastebasket buys thirty days to notice.
   */
  trashFile(fileId: string, signal?: AbortSignal): Promise<void>;

  /** Stream a file's bytes to a local path. */
  downloadToFile(
    args: { fileId: string; destination: string },
    signal?: AbortSignal,
  ): Promise<void>;

  storageQuota(signal?: AbortSignal): Promise<StorageQuota>;
}
