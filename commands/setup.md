---
description: Connect Google Drive, take over transcript cleanup, and back up every session you already have.
allowed-tools: Bash(node:*)
argument-hint: '[--device] [--reauth] [--skip-backfill]'
---

Run the archive setup. This is a one-time step per machine.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" setup $ARGUMENTS
```

The command opens a browser for Google sign-in. It asks for the `drive.file`
scope only, which reaches files this plugin creates and nothing else in the
user's Drive.

Then relay the result:

- If it prints a URL because the browser did not open, show the user that URL.
- If it fails with "no Google OAuth client is configured", the user needs a
  Desktop-app OAuth client. Repeat the remediation the command printed verbatim;
  it names the exact file to create.
- On a headless or SSH machine, rerun with `--device` and read out the code and
  URL it prints.

When it succeeds, tell the user in one or two lines: how many sessions are
archived, how much is still on disk, and that local copies are deleted only
after Drive has a hash-verified copy.
