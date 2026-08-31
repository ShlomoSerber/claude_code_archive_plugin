---
description: Show what is archived, what is still local, disk space reclaimed, and anything stuck.
allowed-tools: Bash(node:*)
argument-hint: '[--quota]'
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" status $ARGUMENTS
```

Show the user the output. Add `--quota` when they ask about Google Drive space;
it costs a network call, so leave it off otherwise.

If the output shows blocked jobs, say what they are and what to do. If it says
`cleanupPeriodDays` is unset or not 365000, Claude Code's own reaper is still
deleting transcripts — tell the user to run `/archive:setup`.
