---
description: Run the archive sweep immediately instead of waiting for the next session.
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" now
```

This backs up anything unarchived, retries failed uploads, deletes local copies
that Drive has already verified, and refreshes the catalog copy on Drive.

It can take a while on a first run: zstd level 19 is slow, deliberately. If the
output says it stopped on the time budget, the rest is queued and the next sweep
picks it up — say so rather than rerunning it in a loop.
