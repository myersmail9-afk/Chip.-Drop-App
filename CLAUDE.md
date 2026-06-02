# Chip.-Drop-App — full project context for Claude Code

> The TTC ChipDrop PWA: a phone-installable web app the crew uses to
> log loads they drop. Crew taps "+1 load," the app POSTs to a Google
> Apps Script, Joseph gets an email/SMS, and (planned) a Jobber invoice
> fires automatically.

## Repo layout

```
Chip.-Drop-App/
├── index.html         ← PWA frontend (bundled React shell)
├── manifest.json      ← PWA install manifest
├── sw.js              ← Service worker (bypasses cache for script.google.com)
├── icon-*.png         ← PWA icons
├── .mcp.json          ← Launches Joseph's local Jobber MCP (dev-only, Mac-only path)
├── .claude/settings.json ← Pre-approves read-only Jobber MCP tools
├── JOBBER-MCP.md      ← What the Jobber MCP is + tool inventory (research, not runtime)
├── apps-script/       ← Google Apps Script backend (clasp-managed)
│   ├── CLAUDE.md         ← edit/deploy workflow + invoice plan
│   ├── README.md         ← clasp commands reference
│   ├── Code.js           ← v3 write endpoint (drop, undo_drop, dailySummary…)
│   ├── appsscript.json   ← Apps Script manifest
│   └── .clasp.json       ← script ID binding (safe to commit)
└── deploy-apps-script.sh  ← clasp push + clasp deploy in one command
```

## The architecture in one diagram

```
Crew phone (PWA, hosted on GitHub Pages)
  │
  └─ tap "+1 load"
     │
     └─ HTTPS POST to Apps Script web app /exec
        │
        ├─ writes row to "TTC Chip Drops Live (v2)" Sheet
        ├─ MailApp.sendEmail() → Joseph
        ├─ SMS via carrier gateway → Joseph
        ├─ auto-flips Status → Inactive when loadsDelivered ≥ loadsWanted
        └─ (planned) UrlFetchApp → Jobber GraphQL → invoiceCreate
```

The PWA's service worker (`sw.js`) explicitly bypasses caching for
`script.google.com`, so every tap hits the Apps Script live.

## Edit / deploy workflow (from Claude Code)

The PWA frontend deploys via GitHub Pages — push to `main` and Pages
rebuilds in 5–10 min. The Apps Script backend deploys via `clasp`.

```bash
# Frontend change (anything outside apps-script/)
git add . && git commit -m "..." && git push
# Pages rebuilds in 5–10 min.
# IMPORTANT: bump CACHE_VERSION in sw.js on every user-facing change so
# installed PWAs auto-update.

# Apps Script change (anything inside apps-script/)
./deploy-apps-script.sh
# Goes live within seconds for the next +1 tap.

# Always also commit Apps Script changes to git:
git add apps-script && git commit -m "..." && git push
```

`./deploy-apps-script.sh` wraps `cd apps-script && clasp push && clasp deploy`.
`clasp push` updates source on Google but does NOT update what the live
PWA hits — `clasp deploy` is what makes a new version live for the crew.
The wrapper always does both.

## Jobber invoicing (built in v4 — needs creds + schema verify before live)

Automatic **Jobber invoicing** is wired into the `drop` handler in
`Code.js`, right after the email/SMS send (`maybeCreateInvoice_`).

Decisions locked in with Joseph (the two old open questions, resolved):

1. **One invoice per +1 tap** — two taps make two invoices.
2. **Price is per-customer, read from the sheet's priority column**
   (`customerRate_` parses `$30`/`$50`/`$30.50`). Not a flat rate.

Behavior: paid tier → invoice at the customer's per-load rate; free
tier → a `$0` invoice (issued for record-keeping). Every invoice is
sent to the customer, and Joseph gets a copy via `notifyInvoice_`.

The Jobber client ID is read from the sheet's Jobber URL column and
encoded for GraphQL (`base64("gid://Jobber/Client/<id>")`). OAuth
creds (`JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`,
`JOBBER_REFRESH_TOKEN`) go in Script Properties — never committed.
No new OAuth scopes were needed (`script.external_request` already
granted). The Jobber MCP is NOT in the runtime path.

⚠ **Before going live:** verify the exact `invoiceCreate` /
`invoiceSendEmail` mutation field names in GraphiQL (or the local
Jobber MCP), set the Script Properties, then `./deploy-apps-script.sh`.
Until creds are set, the invoice step safely no-ops — drops keep working.
See `apps-script/CLAUDE.md` for the full detail.

## Sister projects (do not confuse)

- `github.com/myersmail9-afk/Chip-Drop-Map` — the chip drop MAP app
  (helps the crew FIND places to dump). Different repo, different
  Apps Script, different Sheet.
- The Apps Script behind THIS project is **container-bound** to the
  TTC Chip Drops Live (v2) Sheet
  (`1VLwiva5-3ZHEGjLe_coKDKy5cgRAgGHzDHOz4wOsQPA`). It does NOT show
  up in `clasp list` because clasp only lists standalone scripts.

## Joseph's preferences for code edits

- Concise, direct comments. No fluff.
- Match the existing style in the file you're editing.
- For Apps Script: flag any change that touches `doPost`,
  `appsscript.json` scopes, or the deployment URL before pushing.
- For PWA: bump `CACHE_VERSION` in `sw.js` on EVERY user-facing
  change so installed PWAs auto-update.
- Don't ever commit `.clasprc.json` or anything in `.env*` —
  `apps-script/.gitignore` already blocks them.
