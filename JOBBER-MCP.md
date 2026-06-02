# Jobber MCP — Claude Code context

> The Jobber MCP is the substrate Claude Code uses to research, query,
> and prototype against Joseph's Jobber data — clients, requests,
> quotes, visits, notes. It's a Claude-only tool. **It is NOT in the
> runtime path of the Chip.-Drop-App PWA.** Runtime invoicing goes
> directly from the Apps Script to Jobber's GraphQL endpoint via
> `UrlFetchApp`.

## What it is, in one sentence

A local Python MCP server (Joseph's own, lives at
`~/Documents/ClaudeCowork-Setup/2-PROJECTS/Bid-scheduling/jobber-mcp/`)
that wraps Jobber's GraphQL API as tool calls Claude Code can invoke.

## How it's wired into this repo

| File | Purpose |
|---|---|
| `.mcp.json` (repo root) | Tells Claude Code how to launch the MCP — points at the Python venv and server script. Committed. |
| `.claude/settings.json` (repo root) | Pre-approves read-only Jobber tools so Claude Code doesn't prompt per call. Write tools still ask first. Committed. |
| Jobber OAuth credentials | Live INSIDE the MCP server's own config (`~/Documents/ClaudeCowork-Setup/2-PROJECTS/Bid-scheduling/jobber-mcp/`), NOT in this repo. Never committed here. |

When Claude Code opens this repo, it reads `.mcp.json`, starts the
local MCP server as a child process, and the Jobber tools appear in
its tool list as `mcp__jobber__jobber_*`. No browser, no API keys in
the repo, no extra install.

## Tool inventory

Read-only (auto-approved in `.claude/settings.json`):

| Tool | Use for |
|---|---|
| `mcp__jobber__jobber_search_clients` | Fuzzy-find clients by name / phone / address. |
| `mcp__jobber__jobber_get_client` | Pull a full client record by ID — incl. properties, contact info. |
| `mcp__jobber__jobber_get_request` | Pull a single Request (intake) by ID. |
| `mcp__jobber__jobber_list_requests` | List Requests with filters. |
| `mcp__jobber__jobber_list_quotes` | List Quotes with filters. |
| `mcp__jobber__jobber_list_visits` | List Visits (scheduled work) — used by review-pipeline to identify which crew earned credit for a job. |

Write — requires per-call confirmation:

| Tool | Use for |
|---|---|
| `mcp__jobber__jobber_create_client` | New customer record. |
| `mcp__jobber__jobber_create_client_note` | Client-level pinned/unpinned notes (e.g. follow-up call summaries). |
| `mcp__jobber__jobber_create_job_note` | Job-level notes. |
| `mcp__jobber__jobber_create_request` | New service intake (used by call-intake-request-mcp skill). |
| `mcp__jobber__jobber_create_request_note` | Request-level notes (e.g. the pinned call summary). |
| `mcp__jobber__jobber_create_assessment` | Books an assessment / on-site visit. |
| `mcp__jobber__jobber_archive_request` | Closes / archives a Request. |
| `mcp__jobber__jobber_raw_query` | Escape hatch — runs arbitrary GraphQL against Jobber. Use when no helper exists (e.g. there is no `jobber_create_invoice` — invoicing must go through `jobber_raw_query` with the `invoiceCreate` mutation). |

## When to use this MCP

**Use for:**
- Looking up a real Jobber client to test against (e.g. "what's the client ID for IsaBelle Obray?")
- Researching Jobber GraphQL — `jobber_raw_query` is the cheapest way to test a mutation shape before transplanting it into Apps Script.
- Reading data Joseph wants summarized ("what bids are open right now?")

**Do NOT use for:**
- Running the production +1-load logic. That stays in the Apps Script, calling Jobber via `UrlFetchApp` directly. The MCP is dev-time only.
- Bulk migrations or destructive operations without explicit user confirmation, even for write-tools.

## How this maps to the planned Jobber invoicing change

The plan in `apps-script/CLAUDE.md` adds an automatic Jobber invoice
to the `drop` handler. Workflow inside Claude Code:

1. Use `jobber_search_clients` / `jobber_get_client` to find a real
   test client (probably one of the early VIP entries in the sheet).
2. Use `jobber_raw_query` to test the `invoiceCreate` GraphQL mutation
   end-to-end against that client. Confirm the response shape.
3. Translate the working GraphQL into a `UrlFetchApp.fetch()` call in
   `apps-script/Code.js`. Store OAuth creds in
   `PropertiesService.getScriptProperties()` (NOT in this repo).
4. Deploy via `./deploy-apps-script.sh`. Verify the next real +1 tap
   produces both an email AND a Jobber invoice.

The MCP is the research tool. The Apps Script is the runtime.

## Security notes

- The MCP server holds Jobber OAuth tokens locally on Joseph's Mac.
  They never leave that machine, never appear in this repo, and are
  not accessible to Claude Code except indirectly via tool calls.
- `.mcp.json` only contains the path to the Python interpreter and the
  server script — safe to commit.
- `.claude/settings.json` pre-approves read-only tools by name. Writes
  still prompt. Do not add write-tools to the `allow` list without a
  conscious decision.
- If anyone else ever clones this repo, the `command` path in
  `.mcp.json` (`/Users/josephmyers/...`) will not exist on their
  machine and the MCP will simply fail to start. That's fine — Claude
  Code degrades gracefully with no MCP available.

## How to verify the wiring after restart

After dropping the files in and restarting Claude Code, ask it:

> "What tools do you have from the Jobber MCP, and what's a good
> example query to confirm the connection works?"

It should list the `mcp__jobber__jobber_*` tools and offer to run a
read-only call like `jobber_search_clients` against a real client name.
If it can't see the tools, the MCP didn't start — check the path in
`.mcp.json` is still accurate.
