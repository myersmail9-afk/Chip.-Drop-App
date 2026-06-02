# apps-script/ — operating manual

Local mirror of the Google Apps Script behind the Chip.-Drop-App
+1-load logger. Two-way sync via Google's `clasp` CLI.

## Day-to-day commands

```bash
clasp pull       # grab latest from Google
clasp push       # send local edits up
clasp deploy     # make pushed code live for the PWA
clasp open       # open script in Apps Script editor
clasp logs       # see runtime logs
```

## Shortcut

From the repo root:

```bash
./deploy-apps-script.sh
```

Runs `clasp push && clasp deploy` so a change goes from local file
to live PWA backend in one command.

## If clasp gets out of sync

1. `clasp pull` first.
2. Confirm `.clasp.json` has the right `scriptId`.
3. Nuclear: delete this folder, re-run `Run-ChipDrop-Setup.command`.

## Don't commit

- `.clasprc.json` (OAuth tokens) — `.gitignore` blocks it.
- Anything in `.env*` or `secrets.json`.
