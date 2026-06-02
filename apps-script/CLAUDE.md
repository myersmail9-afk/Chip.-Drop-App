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

## Jobber invoicing (built in v4 — needs creds + schema verify before live)

Automatic **Jobber invoicing** fires in `handleDrop` after the email
send, via `maybeCreateInvoice_`. Decisions locked in with Joseph:

- **One invoice per +1 tap** (not a rolling per-job invoice). Two taps
  → two invoices.
- **Rate is read per-customer** from the priority column —
  `customerRate_()` parses `$30`/`$50`/`$30.50`/etc. Free tier ($0).
- **Free tier still gets a $0 invoice**, emailed like any other (record).
- **Invoice goes to the customer; Joseph gets a copy** via
  `notifyInvoice_` (MailApp, not Jobber CC — reliable).

Plumbing that's done and trustworthy: OAuth refresh + token caching
(`getJobberAccessToken_`), GraphQL transport (`jobberGraphQL_`), and
client-id encoding (`jobberEncodedClientId_` →
`base64("gid://Jobber/Client/<id>")` from the sheet's Jobber URL).

⚠ **Verify before deploy:** the exact `invoiceCreate` /
`invoiceSendEmail` field names in `createJobberInvoice_` /
`sendJobberInvoice_` were written without live schema access. Confirm
them in GraphiQL (Developer Center → Test in GraphiQL → Documentation)
or via the local Jobber MCP, then `./deploy-apps-script.sh`.

Until creds are set, the invoice step **safely no-ops** (returns a skip
reason) — drops still log and notify as before.

**Setup (one-time):** add `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`,
`JOBBER_REFRESH_TOKEN` in Project Settings → Script Properties. Run
`checkJobberConfig_` to confirm they're present (logs set/MISSING, never
the values). No new OAuth scopes were needed — `script.external_request`
was already granted, so the live web app does NOT need re-authorizing.

The Jobber MCP is NOT in the runtime path — runtime is plain HTTPS to
Jobber's GraphQL endpoint from Apps Script.

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
