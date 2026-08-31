---
description: Spot-check archived sessions on Google Drive against their stored hashes.
allowed-tools: Bash(node:*)
argument-hint: '[--all] [--limit <n>]'
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" verify $ARGUMENTS
```

By default this samples the 20 most recently archived sessions. `--all` checks
every one, which costs one Drive API call per session — say so before running it
on a large archive.

Report the result plainly. If anything mismatched, name the sessions and tell
the user to run `/archive:now`, which re-uploads them. A mismatch does not mean
data is lost: the local copy is never deleted unless a hash matched.
