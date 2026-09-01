# Architecture and Code Standards

Companion to `docs/SPEC.md` (the product spec). This document defines the functionalities the implementation needs, and the researched gold-standard practice for each. Sources were surveyed 2026-08-31; decisions here are settled unless the decision log says otherwise.

## Runtime and hard constraints

- **Node.js ≥ 22.16** (raised from the spec's 22.15: `sqlite.backup()` landed in 22.16, and we need it for safe live-catalog copies; zstd was already in 22.15). Document Node 24 LTS as the recommended install.
- ESM only. Zero runtime npm dependencies; zero native modules; no postinstall scripts. Everything ships as committed single-file bundles.
- All std-lib capabilities this design relies on: `node:zlib` zstd (level 19 via `ZSTD_c_compressionLevel` param), `node:sqlite` (WAL, backup API), `node:crypto` (sha256), `fetch`/undici, `child_process`, `node:test`.
- The only allowed runtime package bundled in: `tar` (^7.5, pinned past the 2025 Windows path-traversal CVE) — pure JS, bundles cleanly.

## Functionality map and module layout

Light ports-and-adapters, manual dependency injection (no DI framework — decorators fight `verbatimModuleSyntax`, and a ~30-line composition root suffices).

```
src/
  hooks/            # thin entries: session-end.ts, session-start.ts (parse stdin → enqueue → maybe spawn worker → exit fast)
  commands/         # thin entries for skills: setup.ts, status.ts, now.ts, search.ts, resume.ts, verify.ts
  worker/           # the detached background worker entry (sweep loop)
  core/             # pure logic: archive policy, queue semantics, retry/backoff decisions, slugging, integrity chain
  ports/            # interfaces: DriveTransport, TokenStore, Clock, Logger, ProcessRunner, FileStore, Db
  adapters/         # drive-http.ts, token-file.ts, sqlite-db.ts, spawn-runner.ts, fs-store.ts
  composition.ts    # single place wiring real adapters
dist/               # committed esbuild bundles, 1:1 with entry points
```

Entry points only parse input, call the composition root, and exit. Everything below the entries is testable with fakes. The Drive transport and process spawner are exactly the seams tests need most; the ports pay for themselves immediately.

Subsystems, each detailed below:

1. Hook entries (fast, non-blocking)
2. Work queue + debounce (SQLite)
3. Single-instance lock
4. Detached worker spawn
5. Compression/bundling (tar.zst)
6. Drive transport (auth, resumable upload, verify)
7. Token storage
8. Catalog (SQLite schema + extraction)
9. Restore
10. Filename/path hygiene
11. Logging, error taxonomy, status surfacing
12. Build, test, CI

## 1. Hook entries

- Hook command is always one line: `node "${CLAUDE_PLUGIN_ROOT}/dist/<hook>.mjs"`. No shell logic; `process.platform` and `node:path` inside JS.
- A hook does at most: read hook JSON from stdin, `INSERT OR REPLACE` a job row, spawn the worker if none is running, exit 0. Milliseconds, and **always exit 0** — a hook failure must never disturb the session. Errors are logged, never thrown to stderr.
- User-visible warnings from hooks use the hooks' `systemMessage` JSON channel, not stderr.

## 2. Work queue + debounce (SQLite, at-least-once)

- The queue lives in the same SQLite DB as the catalog. `jobs` table: `id, kind, session_id, status, attempts, not_before, visible_at, payload`.
- Debounce: hooks `INSERT OR REPLACE` keyed on session id with a `not_before` timestamp; rapid hook fires coalesce into one job.
- Claim atomically with a visibility timeout: `UPDATE ... SET visible_at = now + timeout, attempts = attempts + 1 WHERE id = (SELECT ... WHERE visible_at <= now LIMIT 1) RETURNING *`. A worker crash after claim auto-requeues on timeout — that is the at-least-once guarantee. SQLite's single-writer model makes this equivalent to `SKIP LOCKED`.

## 3. Single-instance lock

- DIY (~60 lines), copying proper-lockfile's design, not the package (unmaintained since 2021).
- Primitive: `fs.mkdirSync(lockDir)` (atomic everywhere; a lock *directory* avoids Windows zombie-handle problems that a lock file has). Inside: JSON with pid + hostname + start time.
- Staleness: holder touches the lock's mtime every N seconds; mtime older than 2–3× the heartbeat is stale and may be broken. PID liveness (`process.kill(pid, 0)`) is a fast-path hint only — PIDs recycle, especially on Windows.
- Release wrapped in a short retry loop (Windows antivirus/indexer causes transient `EPERM`/`EBUSY`). Stale threshold ≥ 5–10 s (coarse mtime on FAT-family filesystems).

## 4. Detached worker spawn

Canonical incantation, correct on all three OSes:

```js
const child = spawn(process.execPath, [workerPath], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
```

- `process.execPath`, never `'node'` (PATH/shim issues on Windows); never `shell: true` (re-introduces console flash).
- All three of `detached`, non-inherited `stdio`, `unref()` are required for the child to survive parent exit.
- Windows job objects can still kill children regardless of `detached`; the worker is therefore designed resumable (queue + partials), never assumed immortal. If empirical testing under Claude Code shows job-object kills, fall back to double-spawn (intermediary spawns the real worker and exits).
- Escape hatches for tests and debugging: a `--foreground` flag runs the worker inline; `ARCHIVER_NO_DETACH=1` disables detachment.

## 5. Compression/bundling

- Stream: `tar` (portable mode, `/`-separated relative paths) → `createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } })` → file.
- Always write `<final>.partial` as a **sibling** of the final path (same directory — cross-device rename fails), `fsync`, atomic rename with Windows `EPERM` retry (6 retries, 10 ms → 1 s backoff).
- On worker startup, delete orphaned `*.partial` and restart those jobs. Recreating an archive is cheap; do not attempt mid-stream zstd resume.
- Compute sha256 in a hash-tee while writing (hash the exact bytes written), store in SQLite before upload starts.

## 6. Drive transport

- Direct REST via `fetch`; no `googleapis` package. Auth via `drive.file` scope, Desktop-app client, loopback flow primary, device flow fallback (see SPEC §9).
- **Resumable uploads:** persist the session URI in the job row the moment it's issued (it is the idempotency key; valid ~1 week). Chunks in multiples of 256 KiB (8–16 MiB default). On any interruption: probe with `Content-Range: bytes */<total>`, read the `Range` header from the `308`, resume from its upper bound + 1 — never assume the last chunk landed. On 404/410 for the session URI, start fresh (check-before-create by name/appProperties to avoid duplicates).
- **Retry policy:** full-jitter exponential backoff (`delay = random(0, min(cap, base·2^attempt))`, base 1 s, cap 60–120 s), plus a total elapsed-time budget per run. `Retry-After` always wins when present. Retry only 408/425/429/5xx and network errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`); never other 4xx. `AbortSignal.timeout()` on every request.
- **Never spin hot:** the circuit breaker is *persisted* (short-lived processes can't hold in-memory state): `backoff_until` per job and globally per remote; consecutive failures push it out (30 min → hours, cap 6 h); every wake-up checks it first and exits if cooling down. Plus a retry budget (max N attempts/hour across jobs). 401 `invalid_grant` never retries — job marked blocked, "re-auth needed" surfaced.
- **Integrity chain:** local sha256 (from §5) → upload → `files.get?fields=size,sha256Checksum` (Drive v3 exposes md5/sha1/sha256; must be requested explicitly) → compare size and hash → only then mark done / allow local deletion. Mismatch: delete remote, requeue. Stamp the sha256 into the file's `appProperties` too, so audits can verify without local state. This implements SPEC invariant #1.

## 7. Token storage

- `tokens.json` in the plugin data dir, created `mode: 0o600`; perms re-verified on read. On Windows `mode` is a no-op, but the user-profile app-data dir is already user-ACL'd — the same protection AWS CLI and gcloud rely on. This is the accepted industry norm for personal-machine CLIs (keytar is dead; its successors are native modules we've banned).
- Optional opt-in hardening (all zero-dep shell-outs, documented, not default): DPAPI via PowerShell on Windows, `security add-generic-password` on macOS, `secret-tool` on Linux.
- The real security win is already in the design: `drive.file` scope means a leaked token exposes only files the plugin created.
- Never place the data dir (tokens or SQLite) inside a cloud-synced folder; SQLite corrupts on synced/network filesystems.

## 8. Catalog (SQLite)

- One DB: catalog tables + jobs table. Open-time pragmas on **every** connection (hook and worker): `journal_mode=WAL`, `busy_timeout=5000` (critical — default 0 throws instantly on writer contention), `synchronous=NORMAL`, `foreign_keys=ON`. Write transactions short; `BEGIN IMMEDIATE` for read-then-write. `wal_checkpoint(TRUNCATE)` at worker exit.
- Migrations: ordered SQL list applied under one `BEGIN IMMEDIATE` against `PRAGMA user_version`. Both hook and worker run the migrator idempotently at startup. No scattered `CREATE TABLE IF NOT EXISTS`.
- Drive copy of the catalog: `sqlite.backup()` (or `VACUUM INTO`) — **never** `fs.copyFile` of a live WAL database (documented corruption class).
- Extraction (title, verbatim user prompts, dates, branch, files touched) parses transcript JSONL defensively and fails soft; archived bytes are always verbatim regardless (SPEC invariant #2).
- Search: plain tables + LIKE; no FTS5 (see SPEC decision log).

## 9. Restore

- Download → verify sha256 against catalog → unpack into `~/.claude/projects/<encoded-cwd>/` (path from manifest, located via `CLAUDE_CONFIG_DIR` fallback `<home>/.claude`) → hand the user `claude --resume <session-id>`.
- Extraction uses `tar` with absolute-path and traversal protections left at defaults (the reason we pin ≥ the patched 7.5.x).

## 10. Filename/path hygiene

Own ~25-line slugifier (reimplement `sanitize-filename`'s rule set, no dep):

- `normalize('NFC')` first (macOS supplies NFD); strip control chars and `<>:"/\|?*`.
- Reject Windows reserved basenames case-insensitively **including with extensions** (`CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9`; `CON.txt` counts).
- Trim trailing dots/spaces (Windows silently strips them) and leading dots.
- Cap filenames at ~200 **bytes** (UTF-8, truncate on codepoint boundary), leaving room for `.tar.zst.partial`.
- Uniqueness comes from the session id, not the title: `<date>_<slug>_<shortId>.tar.zst`.
- Windows path budget: do not rely on `LongPathsEnabled` or automatic `\\?\` prefixing (Node's behavior is mixed). What this actually costs is bounded: the slug appears only in the Drive object name, never in a local path. Local paths are the ones Claude Code itself created plus a fixed suffix (`<session-id>.building.tar.zst` in a shallow data dir), so the enforced rule is the ~200-byte filename cap in `sanitizeFileName`. When reading arbitrarily deep session dirs, `path.toNamespacedPath()` on fully resolved absolute paths is permitted.

## 11. Logging, errors, status

- **Logger:** hand-rolled sync NDJSON appender (~50 lines) to a file in the data dir. Not pino: its transports run in worker threads (breaks single-file bundles) and its async buffering is wrong for 200 ms hook processes that must flush before exit. Line shape: `{"ts","level","event","session_id?","attempt?","err":{name,message,code}}`. Size-capped with simple rotation.
- **Error taxonomy** (typed classes, not ad-hoc codes):
  - `RetryableError` (429/5xx/network) → backoff, logged `warn` until exhausted;
  - `FatalError` (invalid_grant, missing config, quota full) → logged `error` **with a remediation message** ("run /archive:setup to reauthenticate");
  - `BugError` (invariant violation) → full stack to log.
- **Surfacing:** hooks/worker never fail loudly (exit 0, swallow-and-log). Three channels: NDJSON log; a persisted last-error/status file rendered by `/archive:status`; hooks' `systemMessage` JSON for warnings that need eyes now. User-invoked commands follow stdout-for-data / stderr-for-diagnostics.

## 12. Build, test, CI

**Language:** TypeScript strict. tsconfig: `module: "nodenext"`, `target: "es2023"`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (keeps source runnable via Node type stripping in dev), `isolatedModules`, `noEmit` (tsc type-checks; esbuild emits).

**Lint/format:** ESLint flat config + typescript-eslint + Prettier. Deciding factor over Biome: type-aware rules, above all `no-floating-promises` — this codebase is async I/O in fire-and-forget processes, exactly where floating promises kill.

**Bundling:** esbuild, exact-pinned version. Per entry: `--bundle --platform=node --format=esm --target=node22 --outfile=dist/<entry>.mjs`, `createRequire` banner (cheap insurance for transitively bundled CJS). Not minified — committed bundles must diff and debug. `.gitattributes`: `* text=auto eol=lf` plus `dist/** linguist-generated=true`.

**Anti-drift gate:** CI runs `npm ci && npm run build && git diff --exit-code -- dist/`. Requires determinism: exact-pinned esbuild, committed lockfile, forced LF.

**Testing:** `node:test` (right-sized, zero deps; coverage via `--experimental-test-coverage`, snapshots via the experimental flag on 22.x). HTTP mocking with undici `MockAgent` + `setGlobalDispatcher` (dispatcher-level interception of native fetch; `assertNoPendingInterceptors()`), devDep only. Most Drive-logic tests inject a fake `DriveTransport` port; only the thin adapter needs MockAgent. Spawn testing: unit-test a pure function returning `{cmd,args,options}`; integration-test with a fixture script writing a heartbeat file after parent exit; `--foreground` mode for functional tests.

**CI (GitHub Actions):**

```yaml
strategy:
  fail-fast: false
  matrix: { os: [ubuntu-latest, macos-latest, windows-latest] }
```

- `git config --global core.autocrlf false` **before** checkout (Windows runners default to CRLF and break byte-exact fixtures) — belt and suspenders with `.gitattributes`.
- `setup-node` with `node-version-file` (pin 22.16.x / 24.x in one place) and `cache: npm`.
- Steps: typecheck, lint, test on all OSes; bundle-drift gate on ubuntu.
- `defaults.run.shell: bash` across the matrix; paths built with `node:path`; dynamic `import()` of absolute paths through `pathToFileURL`.

## Decision table

| Area | Pick | Rejected | Why |
|---|---|---|---|
| Node floor | ≥ 22.16 | 22.15 | `sqlite.backup()` landed in 22.16 |
| Language | TS strict, nodenext + verbatimModuleSyntax | JS + JSDoc | Build step exists anyway; TS terser |
| Lint | ESLint flat + typescript-eslint + Prettier | Biome v2 | Typed rules (`no-floating-promises`) |
| Bundler | esbuild pinned, non-minified, drift-gated | tsdown/tsup | N entries → N files; determinism |
| Tests | node:test + undici MockAgent | Vitest, nock, msw | Right-sized, zero deps, native-fetch interception |
| Architecture | Ports-and-adapters, manual DI | DI frameworks, flat modules | Testable seams at Drive/spawn; no decorator conflicts |
| Lock | DIY mkdir + mtime heartbeat | proper-lockfile pkg | Package dead since 2021; design is right, copy it |
| Queue/state | SQLite (WAL, busy_timeout, user_version migrations, visibility-timeout jobs) | JSON state files | Atomic claims, at-least-once, one source of truth |
| Atomic writes | DIY sibling-temp + fsync + rename + Windows EPERM retry | write-file-atomic | Known unretried-EPERM bug class on Windows |
| Backoff | Full jitter + Retry-After + persisted `backoff_until` + retry budget | In-memory circuit breaker | Processes are short-lived; state must persist |
| Tokens | 0600 file in data dir; opt-in DPAPI/keychain shell-outs | keytar/@napi-rs/keyring | Native deps banned; file storage is the AWS/gcloud norm |
| Catalog backup | `sqlite.backup()` / `VACUUM INTO` | `fs.copyFile` | Live-WAL copy is a documented corruption class |
| Logging | Sync NDJSON, hand-rolled | pino | Worker-thread transports break bundles; hooks need sync flush |
| Slugs | Own slugifier, ~200-byte filename cap | sanitize-filename dep; `\\?\` reliance | Trivial to own; long-path support can't be assumed |
