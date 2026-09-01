---
description: Search the full session history in natural language, including sessions no longer on disk.
allowed-tools: Bash(node:*)
argument-hint: '<what you remember about the session>'
---

Search the archive for: **$ARGUMENTS**

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" search -- "$ARGUMENTS"
```

The CLI does a keyword prefilter over the local catalog and returns up to 30
candidate cards as JSON. It has no idea what the user meant — that part is yours.

1. Read the cards. Rank them by what the user actually described: dates, project
   paths, and the wording of the matched prompts. The `score` field is a keyword
   count, not a judgement.
2. Answer the question they asked. If they wanted a specific session, show the
   best 2 to 4 with date, project, title, and a prompt snippet. If they asked
   something about their history ("how often did I work on billing?"), answer it
   from the cards.
3. If nothing fits, try other keywords before saying it is not there. Matching is
   literal and knows no synonyms.

Never print all 30 candidates.

Add `--since` / `--until` (ISO dates) or `--project <path>` when the user's
phrasing implies a window or a project.
