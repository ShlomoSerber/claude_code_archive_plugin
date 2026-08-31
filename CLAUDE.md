# claude_code_archive_plugin

A cross-platform (macOS / Windows / Linux) Claude Code plugin that continuously archives every Claude Code session to Google Drive and treats the local disk as a cache of recent sessions. Full history stays searchable in natural language, restorable, and safe against disk loss.

## Current state

Docs-only phase. No implementation code yet.

- `docs/SPEC.md` — the definitive product specification; it encodes decisions already made with the user.
- `docs/ARCHITECTURE.md` — technical architecture and code-quality standards for the implementation.

Both are imported below and load with every session:

@docs/SPEC.md
@docs/ARCHITECTURE.md

## Rules

- The invariants in `docs/SPEC.md` ("Invariants" section) are non-negotiable. The most important: never delete a local session before its Drive copy is hash-verified, and a broken plugin must fill the disk rather than lose data.
- Decisions in the SPEC's decision log are settled. Do not re-litigate them silently; if one must change, raise it with the user and update the log.
- Target runtime is Node.js ≥ 22.16 with zero native npm dependencies. Do not add packages requiring node-gyp, prebuilt native binaries, or postinstall scripts.
- All code must work on macOS, native Windows, and Linux. No bash-isms in hook commands: hooks are one-liners of the form `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"`; all logic lives in JS (`process.platform`, `node:path`).
- Locate Claude data via `CLAUDE_CONFIG_DIR`, falling back to `<home>/.claude`. Plugin state goes in the plugin data dir, never the plugin root.
- The Claude Code transcript JSONL format is internal and unstable: archive raw bytes verbatim; parse only for catalog extraction, failing soft.
