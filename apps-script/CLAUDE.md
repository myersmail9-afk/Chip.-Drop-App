# Chip.-Drop-App / apps-script/ — Claude Code context

> Local mirror of the Google Apps Script that powers the TTC ChipDrop
> +1-load logger. This folder is `clasp`-managed: edits made here are
> pushed live to Google via `clasp push`. Pulls come down via `clasp
> pull`. The repo is the source of truth — Google is the mirror.

## Workflow for Claude Code (read this first)

When Joseph asks for an Apps Script change, the loop is:

```
1. clasp pull          # be sure local matches Google before editing
2. <edit .gs files>    # Claude Code makes the change here
3. clasp push          # source goes back up to Google
4. clasp deploy        # makes the new code LIVE for the PWA crew app
```

Steps 1, 3, 4 can be done from Claude Code's bash tool. Step 2 is
the editing itself. The single-line shortcut is at the repo root:

```bash
./deploy-apps-script.sh
```

That wrapper runs `clasp push && clasp deploy` inside this folder.

**Important:** `clasp push` updates the source on Google but does NOT
update what the live PWA hits — the PWA hits a specific deployment
URL. `clasp deploy` is what makes a new version live for the crew.
Always do both.

## What this Apps Script does today

The PWA at https://myersmail9-afk.github.io/Chip.-Drop-App/ is an HTML
shell deployed from the parent repo. When a crew member taps "+1 load"
on a customer card, the PWA POSTs to this Apps Script's web app
`/exec` endpoint. The Apps Script then:

1. Writes the load to the **TTC Chip Drops Live (v2)** Google Sheet.
2. Looks up the customer's tier on that sheet — VIP $30/load, Free
   $0/load, etc.
3. Sends Joseph the "Drop: <name> +1 load" email with action buttons
   (Open Jobber, Open Maps, Sheet).

The PWA's service worker (`../sw.js`) explicitly bypasses caching for
`script.google.com`, so every tap hits this backend live.

## What's planned next (not built — discuss before building)

Add automatic **Jobber invoicing** after the email send:
- VIP / paid tier → $30/load invoice line item
- Free tier → $0 line item (issued for record-keeping)

The Jobber client ID is already on the sheet. The new function needs
`(clientId, tier, loadCount)` plus the existing sheet lookup.

Jobber OAuth creds (client_id, client_secret, refresh_token) live in
`PropertiesService.getScriptProperties()` — never in any committed
file. Apps Script handles its own token refresh. The Jobber MCP is
NOT in the runtime path (MCP is a Claude-only tool — your runtime is
plain HTTPS to Jobber's GraphQL endpoint).

Open question for Joseph before code: **one invoice per +1 tap, or
one invoice per chip-drop job that accumulates line items?**

## Hard rules when editing

1. **Never touch `appsscript.json` scopes** without flagging — adding
   scopes forces re-auth of the deployed web app, breaking the live
   crew app until re-authorized.
2. **Never log Jobber tokens or customer PII** with `Logger.log()`
   or `console.log()`.
3. **Test against a dev deployment first.** Don't push a new
   `doPost` directly to the live deployment.
4. **Always `clasp deploy` after `clasp push`.** Push alone doesn't
   change what the PWA hits.

## File map

| File | What it is |
|---|---|
| `appsscript.json` | Manifest — runtime, scopes, web app config. |
| `*.gs` | Script source. Entry point is `doPost(e)`. |
| `.clasp.json` | Holds the scriptId. Safe to commit. |
| `.clasprc.json` | OAuth tokens. NEVER commit (`.gitignore` blocks it). |
