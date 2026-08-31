import type { DriveTransport } from '../ports/drive.ts';

/**
 * A transport that builds the real one on first use.
 *
 * Several commands touch Drive only in some branches: restoring a session that
 * is still on disk needs no network at all. Constructing the client eagerly
 * turned "that session is not in the catalog" into "no Google OAuth client is
 * configured", which points the user at the wrong problem.
 *
 * It also keeps SPEC invariant 6 honest: search works with no credentials
 * because nothing in that path ever asks for them.
 */
export function createLazyDrive(factory: () => Promise<DriveTransport>): DriveTransport {
  let pending: Promise<DriveTransport> | undefined;
  const resolve = (): Promise<DriveTransport> => {
    pending ??= factory();
    return pending;
  };

  return {
    async ensureFolder(...args) {
      return (await resolve()).ensureFolder(...args);
    },
    async findFile(...args) {
      return (await resolve()).findFile(...args);
    },
    async startResumableUpload(...args) {
      return (await resolve()).startResumableUpload(...args);
    },
    async uploadChunk(...args) {
      return (await resolve()).uploadChunk(...args);
    },
    async probeUpload(...args) {
      return (await resolve()).probeUpload(...args);
    },
    async uploadSmallFile(...args) {
      return (await resolve()).uploadSmallFile(...args);
    },
    async getFile(...args) {
      return (await resolve()).getFile(...args);
    },
    async deleteFile(...args) {
      return (await resolve()).deleteFile(...args);
    },
    async downloadToFile(...args) {
      return (await resolve()).downloadToFile(...args);
    },
    async storageQuota(...args) {
      return (await resolve()).storageQuota(...args);
    },
  };
}
