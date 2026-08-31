---
name: archive
description: Search, restore, or resume an old Claude Code session from the Google Drive archive. Use when the user refers to a past conversation ("that chat where we fixed the auth redirect", "what was I working on last week", "resume the session from Tuesday"), or asks about archive status, disk usage of sessions, or backup health.
---

# Claude Code Archive

Every session this user has ever run is archived to Google Drive and indexed in a
local catalog. The local disk keeps only recent sessions; anything older can be
restored on demand.

The plugin CLI is at `${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs`. Run it with `node`.

## Finding a session

The CLI does a keyword prefilter; **you** do the semantic ranking. It returns up
to 30 candidate cards, and most of them will be wrong — that is expected.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" search "<the user's own words>"
```

Useful flags: `--limit <n>`, `--since <ISO date>`, `--until <ISO date>`,
`--project <path>`, `--files` (include the files each session touched).

Output is JSON with a `candidates` array. Each card carries the session id,
title, project, dates, message count, and the prompts that matched.

Then:

1. Read the cards and rank them by what the user actually asked for. Dates,
   project paths, and prompt wording matter more than the numeric `score`, which
   is only a keyword count.
2. Show the user the best 2 to 4, with date, project, title, and a prompt
   snippet. Never dump all 30.
3. If nothing plausible comes back, try different keywords before concluding the
   session is not there. The prefilter is literal; it does not know synonyms.

## Restoring and resuming

Once the user picks one, restore it by session id:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" resume <session-id>
```

This downloads the bundle, checks its hash, unpacks it back into place, and
returns `resumeCommand`. Give that command to the user to run themselves, along
with the directory to run it from (`projectCwd`) — a running session cannot turn
into an older one.

Passing free text instead of an id returns candidates rather than restoring
anything.

## Archive health

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" status          # what is local, archived, or stuck
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" now             # force a sweep now
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" verify          # check hashes against Drive
```

If `status` reports blocked jobs or a missing Google connection, tell the user to
run `/archive:setup`.

## What not to do

- Do not read or edit anything under the plugin's data directory by hand. The
  SQLite catalog is written by concurrent processes.
- Do not delete session files to free space. The plugin deletes local copies only
  after Drive has a hash-verified copy; doing it manually loses data.
- Do not run `search` or `resume` to answer a question about the _current_
  session. They only see archived ones.
