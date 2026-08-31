# Claude Code Archive Plugin — Product Specification

Status: definitive product spec, agreed 2026-08-31. Implementation has not started.

## One-liner

A Claude Code plugin that keeps every session you ever run, forever, in Google Drive — while your computer only holds the recent ones.

## The model

**Google Drive is always the complete archive. The local disk is a cache of recent sessions.**

- Every session is backed up to Drive the moment it closes.
- The local copy is deleted after N idle days (default 30), and only ever after its Drive copy is hash-verified.
- A local catalog makes the entire history searchable, in natural language, without touching Drive.
- Any archived session can be restored and resumed as if it never left.
- Because the catalog is also copied to Drive, a dead or stolen laptop loses nothing: install the plugin on a new machine, log in, and the full history is searchable and restorable again.

## The problem

Claude Code stores session transcripts as JSONL under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, plus per-session sidecar directories (tool results, subagent transcripts). By default it deletes transcripts after 30 days (`cleanupPeriodDays`). Users who want their history forever must choose between unbounded disk growth and data loss.

Measured baseline (this machine, 2026-08-31):
- 1.8 GB in `~/.claude/projects`: 592 transcripts (1.74 GB) + 81 sidecar dirs (~390 MB), accumulated in 4 weeks.
- Growth rate ≈ 20–25 GB/year uncompressed.
- zstd -19 on a real transcript: 3.7x (gzip only 1.6x). Compressed run rate ≈ 6 GB/year.

## Functional specification

### 1. Continuous backup (on session close)

- A `SessionEnd` hook fires when a session closes. It records the session as a backup candidate and spawns a short-lived, detached background worker. The hook itself must return in milliseconds and never block session exit.
- The worker compresses the session (transcript + sidecar dir) into a single `.tar.zst` (zstd level 19), uploads it to Drive, verifies the remote hash, and updates the catalog.
- A resumed session that closes again is simply re-uploaded; the new copy supersedes the old one.
- Failures (offline, expired token, full Drive) are retried at the next sweep. Failures never crash or block Claude Code.

### 2. Local cleanup (the plugin owns deletion)

- On install, the plugin sets `cleanupPeriodDays: 365000` (1000 years) in the user's settings. Claude Code's own reaper effectively never runs; the plugin becomes the only deleter.
  - Never set `cleanupPeriodDays: 0` — a known bug makes 0 disable transcript writing entirely (anthropics/claude-code#23710).
  - Do not use values much larger than 365000 — absurd day counts exceed JavaScript's date range.
- A sweep (see 3) deletes local copies of sessions idle longer than the cleanup window (default 30 days), strictly after the Drive copy is hash-verified.
- Failure direction is a design invariant: if the plugin breaks, the disk fills up (visible, recoverable). It must never be possible for history to be lost (silent, fatal).

### 3. Sweep (no daemon, no OS scheduler)

- There is no always-running service and no cron/launchd/Task Scheduler entry in v1.
- `SessionStart` and `SessionEnd` hooks trigger the sweep, guarded by a lock file and a debounce.
- The sweep: retries failed uploads, backs up any session missed by its close hook (covers crashes and long absences), deletes verified idle local copies, and refreshes the Drive copy of the catalog.
- Rationale: when the user isn't using Claude Code, nothing accumulates, so nothing is time-critical. Deferred work safely waits for the next use.

### 4. Catalog (local, always)

- Built/updated at backup time, while the transcript is still local and cheap to read. SQLite, lives locally forever. Search never requires Drive.
- Per session it stores: session id, project (encoded dir + original cwd), title/summary (Claude Code generates these), every user prompt verbatim, date range, git branch if present, files touched, sizes, sha256 of the original transcript, remote file id/path, backup timestamp and version.
- A copy of the catalog is uploaded to Drive after sweeps (disaster recovery). On a fresh machine, setup pulls it down once.
- Transcript parsing is defensive: the JSONL format is internal to Claude Code and changes between versions. Archived bytes are always stored verbatim; parsing is for index extraction only and is allowed to fail soft (a session with a thin catalog entry is still fully archived).

### 5. Natural-language search and resume

The AI is the search engine — the plugin runs inside Claude Code, so no embeddings service, no external AI API, no vector DB.

Flow for `/archive:resume <free-text description>`:
1. **Prefilter** (instant, local): the plugin CLI queries the catalog with keywords, project hints, and date hints; returns top ~30 candidate cards.
2. **AI ranking**: Claude reads the cards (summary, verbatim prompts, project, dates) and ranks them semantically.
3. **Present**: Claude shows 2–4 candidates (date, project, summary, prompt snippet); user picks.
4. **Restore + hand off**: the plugin downloads the bundle, verifies the hash, unpacks the session back into the correct `~/.claude/projects/<encoded-cwd>/` location, and hands the user the ready-to-run `claude --resume <session-id>` command. (A running session cannot become an old one; the hand-off is the last step.)

`/archive:search` is the same machinery without restore — answers questions about history.

Escalation path: if catalog matches are ambiguous, Claude may (opt-in, uses tokens) download top candidate bundles and read the actual transcripts to confirm.

Ruled out: embeddings index (paid external dependency solving a problem keyword-prefilter + Claude rerank already solves at personal scale).

### 6. Session awareness (context injection)

- Every Claude session must know the archive exists so that "find me that old chat" works without the user knowing command names.
- Mechanism: skill descriptions (always in context, ~a few dozen tokens total). Full instructions load only on invocation. Keep the always-loaded footprint minimal.

### 7. Commands

| Command | Purpose |
|---|---|
| `/archive:setup` | One-time: Google login, set `cleanupPeriodDays`, initial backfill of all existing sessions. On a fresh machine: pull catalog from Drive. |
| `/archive:status` | What's local, what's archived, space saved, Drive usage, pending/failed uploads. |
| `/archive:now` | Force a sweep immediately. |
| `/archive:search <text>` | Natural-language search over the full history. |
| `/archive:resume <text or id>` | Find, restore, hand back the resume command. |
| `/archive:verify` | Spot-check archive integrity against stored hashes. |

### 8. Google Drive layout

Per-session bundles (not monthly batches), human-readable, plain files openable without the plugin:

```
ClaudeArchive/
  catalog.sqlite                  (disaster-recovery copy)
  <encoded-project-dir>/
    2026/
      2026-08-31_fix-auth-redirect_<short-id>.tar.zst
      2026-08-31_fix-auth-redirect_<short-id>.manifest.json
```

- Filename = date + session-title slug + short session id (titles alone can duplicate and contain invalid characters).
- Manifest per bundle: session id, original cwd, encoded dir, dates, sha256 of each contained file, uncompressed sizes.
- Year subfolders keep Drive listings sane; the catalog, not Drive listing, is the source of truth for search.
- Why per-session, not monthly: granular restore (one session ≠ one 100 MB month), resumed sessions re-upload one small file instead of rewriting a batch, and continuous backup uploads sessions individually anyway. Monthly compresses marginally better; a trained zstd dictionary can recover most of that later if wanted.

### 9. Google Drive access

- Scope: `drive.file` only (files the app created). Non-sensitive scope → no CASA audit, mild consent screen, and unlocks the device flow.
- Auth: Desktop-app OAuth client; loopback flow (browser + localhost redirect) primary, device flow fallback for headless/SSH.
- Ship a shared client id for zero-setup onboarding; document bring-your-own client id as an override.
- Drive rate reality: ~2 files/second effective for small files; per-session volume (~20 uploads/day at measured usage) is comfortably inside it.
- rclone is not a dependency. (Optional pluggable backend later, not v1.)

## Invariants (must never regress)

1. Never delete a local session unless its Drive copy's hash has been verified.
2. Archived bytes are stored verbatim; no transformation of the original JSONL.
3. Hooks return fast and never block or crash a session, no matter what fails.
4. Broken plugin ⇒ disk fills; never ⇒ data loss.
5. `cleanupPeriodDays` is 365000, never 0.
6. Search works fully offline.
7. Everything on Drive is a plain file recoverable without the plugin (`tar` + `zstd` suffice).

## Platform requirements

- macOS, Windows (native), Linux — identical behavior.
- Only prerequisite: Node.js ≥ 22.16 (Node 24 LTS recommended; 22.16 is the floor because the built-in SQLite backup API landed there). Zero native npm dependencies, no compile step, no other tools.
- Installed as a normal Claude Code plugin from a marketplace; same on all OSes.
- Sessions located via `CLAUDE_CONFIG_DIR` env var, falling back to `<home>/.claude`. Never hardcode `~`.
- Plugin state lives in the per-plugin data dir (`${CLAUDE_PLUGIN_DATA}`), never in the plugin root (wiped on update).

## Non-goals (v1)

- No UI beyond terminal + Claude Code commands.
- No OS schedulers, no daemon.
- No embeddings / vector search.
- No encryption layer by default (Drive-side files stay self-describing); may be opt-in later.
- No backends other than Google Drive (keep the transport module small and swappable).
- No archival of non-session data (`file-history/`, caches) — possible later.

## Decision log

| Decision | Choice | Why |
|---|---|---|
| Storage backend | Google Drive | User already on Workspace; browsable; `drive.file` scope needs no audit; at ~6 GB/yr cost is a non-issue. Transport kept pluggable. |
| Backup timing | On every session close | Shrinks loss window from 30 days to ~0; makes Drive the complete archive; removes need for schedulers. |
| Local retention | 30 idle days, plugin-owned deletion | Safe failure direction; Claude reaper neutralized at 1000 years. |
| Bundle unit | Per session | Granular restore; cheap re-upload of resumed sessions; fits continuous backup. |
| Runtime | Node ≥ 22.16 only | Native zstd (level 19), `node:sqlite`, `tar` pkg with zstd; zero native deps; one `node script.mjs` hook line works in Bash/Git Bash/PowerShell. |
| Search | Catalog prefilter + Claude rerank | AI is already in the loop; no external services. |
| Full-text index | Plain SQLite, no FTS5 | `node:sqlite` lacks FTS5; `better-sqlite3` adds install risk; LIKE-scale is fine at personal volume. |
| rclone | Not used | External binary dependency; needs restricted full-drive scope; its shared OAuth client is being retired. |
