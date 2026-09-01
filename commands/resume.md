---
description: Find an archived session, restore it to disk, and hand back the command to resume it.
allowed-tools: Bash(node:*)
argument-hint: '<session id, or what you remember about it>'
---

Restore and resume: **$ARGUMENTS**

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" resume -- "$ARGUMENTS"
```

With a session id, this downloads the bundle, verifies its hash, unpacks it back
into place, and returns `"action": "restored"`.

With free text it returns `"action": "choose"` and a list of candidates instead.
In that case: rank them yourself, show the user the best 2 to 4, and ask which
one. Then rerun with the chosen session id.

After a restore, give the user the `resumeCommand` and tell them to run it from
`projectCwd`. Do not run it yourself — a session that is already running cannot
become an older one.
