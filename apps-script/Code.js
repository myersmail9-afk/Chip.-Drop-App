/**
 * TTC Chip Drops — write endpoint v4
 *
 * v4 adds:
 *  - Auto-invoice via Jobber on every drop (handleDrop → maybeCreateInvoice_)
 *    One invoice per +1 tap. Rate read per-customer from the priority column
 *    ($30/$50/etc); free tier issues a $0 invoice. Invoice is sent to the
 *    customer and a copy/confirmation emails Joseph.
 *  - No new OAuth scopes: script.external_request was already granted.
 *  - Jobber OAuth creds live in Script Properties, never in this file:
 *    JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN.
 *    Until those are set, the invoice step safely no-ops — drops still work.
 *  ⚠ VERIFY before going live: the exact invoiceCreate / send mutation field
 *    names in createJobberInvoice_ / sendJobberInvoice_ were written without
 *    live schema access. Confirm them in Jobber GraphiQL, then clasp deploy.
 *
 * v3 adds:
 *  - Auto-flip Status → Inactive when loadsDelivered ≥ loadsWanted (drop)
 *  - Auto-flip Status → Active when undo brings loads below the threshold (undo)
 *  - makePhotosPublic() — shares form-uploaded Drive photos so the app can show them
 *  - setupFormSubmitTrigger() — schedules makePhotosPublic on every new submission
 *
 * v2 added:
 *  - Email + SMS (via carrier gateway) notifications on every drop and undo
 *  - 'undo_drop' action — reverses a recent drop and updates audit log
 *  - dailySummary() — sends end-of-day summary email + SMS at 8 PM
 *
 * Deploy as: Web app, Execute as = "Me", Who has access = "Anyone"
 * After updating: Deploy → Manage deployments → Edit → New version → Deploy
 *
 * One-time setup after deploying v3:
 *   - run setupDailyTrigger()       — schedules the 8 PM summary
 *   - run setupFormSubmitTrigger()  — auto-publishes new photos on submit
 *   - run makePhotosPublic()        — one-time pass to publish existing photos (Cory, Ashley, etc.)
 */

// === CONFIG ===
const SHEET_ID = '1VLwiva5-3ZHEGjLe_coKDKy5cgRAgGHzDHOz4wOsQPA';
const RESPONSES_TAB = 'Form Responses 1';
const LOG_TAB = 'Drop Log';

// Shared secret. Same value goes into index.html so anonymous web traffic
// can't spam fake drops. Change this to your own random string.
const SECRET = 'TTC_CHIP_DROP_2026_xK9pQ3vN7m';

// === NOTIFICATIONS ===
const JOSEPH_EMAIL = 'myersmail9@gmail.com';

// SMS via email-to-SMS gateway. T-Mobile (Joseph's carrier) was confirmed working
// briefly, then started silently dropping messages — carriers have been throttling
// these gateways aggressively since ~2023. Email notifications are the reliable
// path; SMS is disabled here to avoid bounce-back clutter in Gmail inbox.
//
// To re-enable SMS later: uncomment the lines and the loops in notifyDrop_,
// notifyUndo_, and sendDailySummary_ below.
const JOSEPH_SMS_GATEWAYS = [
  // '3853068780@tmomail.net',      // T-Mobile (was working, then throttled)
  // '3853068780@vtext.com',        // Verizon
  // '3853068780@txt.att.net'       // AT&T
];

const TIME_ZONE = 'America/Denver';

// === JOBBER INVOICING ===
// OAuth creds are NEVER committed — set them in Script Properties:
//   Project Settings → Script Properties → add JOBBER_CLIENT_ID,
//   JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN. Run checkJobberConfig_ to
//   confirm they're present (it logs set/MISSING, never the values).
const JOBBER_TOKEN_URL   = 'https://api.getjobber.com/api/oauth/token';
const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
// X-JOBBER-GRAPHQL-VERSION is required on every request. Must be an active
// version (date format) per Jobber's changelog — bump as versions retire.
const JOBBER_API_VERSION = '2025-01-20';

// === ENTRY POINTS ===

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    if (data.secret !== SECRET) {
      return jsonResponse({ ok: false, error: 'Invalid secret' });
    }
    const action = (data.action || 'log_drop').toString();
    if (action === 'undo_drop') return handleUndo(data);
    return handleDrop(data);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Server error: ' + err.toString() });
  }
}

function doGet(e) {
  return jsonResponse({
    ok: true,
    status: 'TTC Chip Drop endpoint is live (v2)',
    deployed_at: new Date().toISOString()
  });
}

// === DROP HANDLER ===

function handleDrop(data) {
  const customerName = (data.customer_name || '').toString().trim();
  const loads = parseFloat(data.loads);
  const dropDate = (data.date || '').toString() || todayStr_();
  const sourceUser = (data.source || 'crew').toString().slice(0, 100);

  if (!customerName) {
    return jsonResponse({ ok: false, error: 'Missing customer_name' });
  }
  if (isNaN(loads) || loads <= 0) {
    return jsonResponse({ ok: false, error: 'Missing or invalid loads value' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(RESPONSES_TAB);
    if (!sheet) {
      return jsonResponse({ ok: false, error: 'Responses sheet not found: ' + RESPONSES_TAB });
    }

    const data2d = sheet.getDataRange().getValues();
    const headers = data2d[0].map(h => String(h).toLowerCase().trim());
    const findCol = (...needles) => {
      for (let i = 0; i < headers.length; i++) {
        for (const n of needles) {
          if (headers[i].indexOf(n.toLowerCase()) !== -1) return i;
        }
      }
      return -1;
    };

    const firstNameCol    = findCol('first name');
    const lastNameCol     = findCol('last name');
    const loadsCol        = findCol('loads delivered');
    const lastDropCol     = findCol('last drop date', 'last drop');
    const streetCol       = findCol('street address', 'street');
    const cityCol         = findCol('city');
    const tierCol         = findCol('select priority', 'priority level', 'priority');
    const statusCol       = findCol('status');
    const loadsWantedCol  = findCol('how many loads', 'loads wanted');
    const jobberCol       = findCol('jobber url', 'jobber');
    const mapsCol         = findCol('google maps url', 'maps url', 'maps');

    if (firstNameCol < 0 || lastNameCol < 0 || loadsCol < 0 || lastDropCol < 0) {
      return jsonResponse({ ok: false, error: 'Missing required columns' });
    }

    let foundRow = -1;
    const targetName = customerName.toLowerCase();
    for (let i = 1; i < data2d.length; i++) {
      const fullName = `${data2d[i][firstNameCol]} ${data2d[i][lastNameCol]}`.toLowerCase().trim();
      if (fullName === targetName) { foundRow = i; break; }
    }
    if (foundRow === -1) {
      return jsonResponse({ ok: false, error: 'Customer not found: ' + customerName });
    }

    const existingLoads = parseFloat(data2d[foundRow][loadsCol]) || 0;
    const newLoads = +(existingLoads + loads).toFixed(2);
    const street     = streetCol  >= 0 ? String(data2d[foundRow][streetCol]  || '') : '';
    const city       = cityCol    >= 0 ? String(data2d[foundRow][cityCol]    || '') : '';
    const tier       = tierCol    >= 0 ? String(data2d[foundRow][tierCol]    || '') : '';
    const jobberUrl  = jobberCol  >= 0 ? String(data2d[foundRow][jobberCol]  || '') : '';
    const mapsUrl    = mapsCol    >= 0 ? String(data2d[foundRow][mapsCol]    || '') : '';

    sheet.getRange(foundRow + 1, loadsCol + 1).setValue(newLoads);
    sheet.getRange(foundRow + 1, lastDropCol + 1).setValue(dropDate);

    // Auto-flip Status to Inactive when fulfilled
    // (loadsWanted has special values: number, "10+", "as many as you can give me")
    let nowFulfilled = false;
    if (statusCol >= 0 && loadsWantedCol >= 0) {
      const wantedRaw = String(data2d[foundRow][loadsWantedCol] || '').toLowerCase();
      const isOpen = wantedRaw.includes('as many') || wantedRaw.includes('many as you');
      const wantedMatch = wantedRaw.match(/(\d+)/);
      const loadsWanted = isOpen ? Infinity : (wantedMatch ? parseInt(wantedMatch[1], 10) : 1);
      if (loadsWanted !== Infinity && newLoads >= loadsWanted && loadsWanted > 0) {
        sheet.getRange(foundRow + 1, statusCol + 1).setValue('Inactive');
        nowFulfilled = true;
      }
    }

    // Audit log
    let logSheet = ss.getSheetByName(LOG_TAB);
    if (!logSheet) {
      logSheet = ss.insertSheet(LOG_TAB);
      logSheet.appendRow(['Timestamp', 'Customer', 'Loads Added', 'New Total', 'Drop Date', 'Source', 'Status']);
      logSheet.getRange(1, 1, 1, 7).setFontWeight('bold');
    }
    logSheet.appendRow([new Date(), customerName, loads, newLoads, dropDate, sourceUser, 'logged']);
    const logRow = logSheet.getLastRow();

    SpreadsheetApp.flush();

    // Notify Joseph (email + SMS)
    notifyDrop_(customerName, loads, newLoads, street, city, tier, jobberUrl, mapsUrl);

    // Auto-invoice via Jobber. One invoice per tap. No-ops (returns a skip
    // reason) if creds aren't configured, so a Jobber outage never blocks a
    // drop from being logged.
    let invoice = null;
    try {
      invoice = maybeCreateInvoice_(customerName, loads, tier, jobberUrl, dropDate);
    } catch (e) {
      Logger.log('Invoice step threw: ' + e);
      invoice = { ok: false, error: String(e) };
    }

    return jsonResponse({
      ok: true,
      customer: customerName,
      added: loads,
      new_total: newLoads,
      last_drop_date: dropDate,
      log_row: logRow,
      now_fulfilled: nowFulfilled,
      invoice: invoice
    });
  } finally {
    lock.releaseLock();
  }
}

// === UNDO HANDLER ===

function handleUndo(data) {
  const customerName = (data.customer_name || '').toString().trim();
  const logRow = parseInt(data.log_row, 10);

  if (!customerName) return jsonResponse({ ok: false, error: 'Missing customer_name for undo' });
  if (!logRow || logRow < 2) return jsonResponse({ ok: false, error: 'Missing/invalid log_row for undo' });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const logSheet = ss.getSheetByName(LOG_TAB);
    if (!logSheet) return jsonResponse({ ok: false, error: 'Drop Log not found' });
    if (logRow > logSheet.getLastRow()) return jsonResponse({ ok: false, error: 'log_row out of range' });

    const logEntry = logSheet.getRange(logRow, 1, 1, 7).getValues()[0];
    const logName = String(logEntry[1] || '').toLowerCase().trim();
    const logLoads = parseFloat(logEntry[2]) || 0;
    const logStatus = String(logEntry[6] || '');

    if (logStatus === 'undone') return jsonResponse({ ok: false, error: 'Already undone' });
    if (logName !== customerName.toLowerCase()) {
      return jsonResponse({ ok: false, error: 'Customer name mismatch on undo' });
    }

    // Reverse in main sheet
    const sheet = ss.getSheetByName(RESPONSES_TAB);
    const data2d = sheet.getDataRange().getValues();
    const headers = data2d[0].map(h => String(h).toLowerCase().trim());
    const findCol = (...needles) => {
      for (let i = 0; i < headers.length; i++) {
        for (const n of needles) {
          if (headers[i].indexOf(n.toLowerCase()) !== -1) return i;
        }
      }
      return -1;
    };
    const firstNameCol    = findCol('first name');
    const lastNameCol     = findCol('last name');
    const loadsCol        = findCol('loads delivered');
    const statusCol       = findCol('status');
    const loadsWantedCol  = findCol('how many loads', 'loads wanted');

    let foundRow = -1;
    for (let i = 1; i < data2d.length; i++) {
      const fullName = `${data2d[i][firstNameCol]} ${data2d[i][lastNameCol]}`.toLowerCase().trim();
      if (fullName === customerName.toLowerCase()) { foundRow = i; break; }
    }
    if (foundRow === -1) return jsonResponse({ ok: false, error: 'Customer not found for undo' });

    const existingLoads = parseFloat(data2d[foundRow][loadsCol]) || 0;
    const newTotal = Math.max(0, +(existingLoads - logLoads).toFixed(2));
    sheet.getRange(foundRow + 1, loadsCol + 1).setValue(newTotal);

    // If this undo brings them back under their wanted count, flip Status back to Active
    if (statusCol >= 0 && loadsWantedCol >= 0) {
      const wantedRaw = String(data2d[foundRow][loadsWantedCol] || '').toLowerCase();
      const isOpen = wantedRaw.includes('as many') || wantedRaw.includes('many as you');
      const wantedMatch = wantedRaw.match(/(\d+)/);
      const loadsWanted = isOpen ? Infinity : (wantedMatch ? parseInt(wantedMatch[1], 10) : 1);
      const currentStatus = String(data2d[foundRow][statusCol] || '').toLowerCase();
      if (currentStatus === 'inactive' && (loadsWanted === Infinity || newTotal < loadsWanted)) {
        sheet.getRange(foundRow + 1, statusCol + 1).setValue('Active');
      }
    }

    // Mark original log entry undone (preserve audit trail)
    logSheet.getRange(logRow, 7).setValue('undone');
    // Append a paired undo-entry so the log reads chronologically
    logSheet.appendRow([new Date(), customerName, -logLoads, newTotal, todayStr_(), 'undo', 'undo-entry']);

    SpreadsheetApp.flush();

    // Notify
    notifyUndo_(customerName, logLoads, newTotal);

    return jsonResponse({
      ok: true,
      undone: true,
      customer: customerName,
      reversed: logLoads,
      new_total: newTotal
    });
  } finally {
    lock.releaseLock();
  }
}

// === NOTIFICATIONS ===

function notifyDrop_(name, loads, total, street, city, tier, jobberUrl, mapsUrl) {
  const tz = TIME_ZONE;
  const when = Utilities.formatDate(new Date(), tz, "MMM d, h:mm a");
  const loadsStr = (loads === 0.5) ? '½' : String(loads);
  const subject = `🪵 Drop: ${name} +${loadsStr} load${loads === 1 ? '' : 's'}`;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

  // Plain text body — Gmail and most clients auto-link bare URLs, so no HTML
  // escaping needed. Tap the link, jump straight to Jobber or Maps.
  const lines = [name];
  if (street) lines.push(`${street}, ${city}`);
  lines.push(`+${loadsStr} load${loads === 1 ? '' : 's'} dropped (new total: ${total})`);
  if (tier) lines.push(`Tier: ${tier}`);
  lines.push(`Time: ${when}`);
  if (jobberUrl || mapsUrl) {
    lines.push('');
    if (jobberUrl) lines.push(`Jobber: ${jobberUrl}`);
    if (mapsUrl)   lines.push(`Maps:   ${mapsUrl}`);
  }
  lines.push('');
  lines.push(`Sheet: ${sheetUrl}`);
  const emailBody = lines.join('\n');

  // HTML body for clients that prefer rich — clickable buttons, easier to tap on mobile
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const btn = (href, label, color) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:10px 16px;margin:4px 6px 4px 0;background:${color};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;">${esc(label)}</a>`;
  const htmlBody = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px;">`,
    `<p style="margin:0 0 8px;font-size:18px;font-weight:600;">${esc(name)}</p>`,
    street ? `<p style="margin:0 0 6px;color:#666;">${esc(street)}, ${esc(city)}</p>` : '',
    `<p style="margin:0 0 6px;"><strong>+${loadsStr} load${loads === 1 ? '' : 's'}</strong> dropped (new total: <strong>${total}</strong>)</p>`,
    tier ? `<p style="margin:0 0 6px;color:#555;">Tier: ${esc(tier)}</p>` : '',
    `<p style="margin:0 0 14px;color:#888;font-size:13px;">${esc(when)}</p>`,
    `<div style="margin:14px 0;">`,
      jobberUrl ? btn(jobberUrl, '📋 Open Jobber', '#1f6cb0') : '',
      mapsUrl   ? btn(mapsUrl,   '📍 Open Maps',   '#2a3a25') : '',
      btn(sheetUrl, '📊 Sheet', '#888'),
    `</div>`,
    `</div>`
  ].filter(Boolean).join('');

  try {
    MailApp.sendEmail({ to: JOSEPH_EMAIL, subject, body: emailBody, htmlBody });
  } catch (e) {
    Logger.log('notifyDrop_ email failed: ' + e);
  }

  // Short SMS body — under 160 chars for clean delivery
  const smsBody = `Drop: ${name} +${loadsStr}L (total ${total}) ${when}`;
  for (const gw of JOSEPH_SMS_GATEWAYS) {
    try { MailApp.sendEmail({ to: gw, subject: '', body: smsBody }); } catch (e) {}
  }
}

function notifyUndo_(name, reversedLoads, newTotal) {
  const tz = TIME_ZONE;
  const when = Utilities.formatDate(new Date(), tz, "MMM d, h:mm a");
  const loadsStr = (reversedLoads === 0.5) ? '½' : String(reversedLoads);
  const subject = `↩️ UNDONE: ${name} -${loadsStr}`;
  const body =
    `${name}\n` +
    `Reversed: -${loadsStr} load${reversedLoads === 1 ? '' : 's'}\n` +
    `New total: ${newTotal}\n` +
    `Time: ${when}`;
  try { MailApp.sendEmail({ to: JOSEPH_EMAIL, subject, body }); } catch (e) {}
  const sms = `UNDO: ${name} -${loadsStr}L (now ${newTotal}) ${when}`;
  for (const gw of JOSEPH_SMS_GATEWAYS) {
    try { MailApp.sendEmail({ to: gw, subject: '', body: sms }); } catch (e) {}
  }
}

// === JOBBER INVOICING ===

// Parse the per-load rate from the priority/tier column text.
// "$30" → 30, "$50" → 50, "$30.50" → 30.5, anything without a price → 0 (free).
function customerRate_(tierRaw) {
  const m = String(tierRaw || '').match(/\$\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// The sheet stores a Jobber client URL like .../clients/12345678. Jobber's
// GraphQL API references a client by an encoded global ID:
// base64("gid://Jobber/Client/<numericId>"). Returns null if no id is found.
function jobberEncodedClientId_(jobberUrl) {
  const m = String(jobberUrl || '').match(/clients?\/(\d+)/i);
  if (!m) return null;
  return Utilities.base64Encode('gid://Jobber/Client/' + m[1]);
}

// Get a valid Jobber access token, refreshing via the stored refresh token.
// Caches the access token in Script Properties until ~2 min before expiry.
// Returns null (never throws) when creds are missing or the refresh fails —
// callers treat null as "not configured / unavailable" and skip invoicing.
// NEVER logs token values (hard rule).
function getJobberAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('JOBBER_CLIENT_ID');
  const clientSecret = props.getProperty('JOBBER_CLIENT_SECRET');
  const refreshToken = props.getProperty('JOBBER_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) return null;

  const cached    = props.getProperty('JOBBER_ACCESS_TOKEN');
  const expiresAt = parseInt(props.getProperty('JOBBER_TOKEN_EXPIRES_AT') || '0', 10);
  if (cached && Date.now() < expiresAt - 120000) return cached;

  let resp;
  try {
    resp = UrlFetchApp.fetch(JOBBER_TOKEN_URL, {
      method: 'post',
      muteHttpExceptions: true,
      payload: {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      }
    });
  } catch (e) {
    Logger.log('Jobber token request threw: ' + e);
    return null;
  }
  if (resp.getResponseCode() >= 300) {
    Logger.log('Jobber token refresh failed: HTTP ' + resp.getResponseCode());
    return null;
  }
  const body = JSON.parse(resp.getContentText() || '{}');
  if (!body.access_token) return null;
  props.setProperty('JOBBER_ACCESS_TOKEN', body.access_token);
  props.setProperty('JOBBER_TOKEN_EXPIRES_AT', String(Date.now() + (body.expires_in || 3600) * 1000));
  // Jobber rotates refresh tokens — persist the new one so we don't get locked out.
  if (body.refresh_token) props.setProperty('JOBBER_REFRESH_TOKEN', body.refresh_token);
  return body.access_token;
}

// POST a GraphQL query/mutation to Jobber. Returns {ok, data, errors} or null
// if no token is available. Never throws.
function jobberGraphQL_(query, variables) {
  const token = getJobberAccessToken_();
  if (!token) return null;
  let resp;
  try {
    resp = UrlFetchApp.fetch(JOBBER_GRAPHQL_URL, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Bearer ' + token,
        'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION
      },
      payload: JSON.stringify({ query: query, variables: variables })
    });
  } catch (e) {
    Logger.log('Jobber GraphQL request threw: ' + e);
    return { ok: false, errors: [{ message: String(e) }] };
  }
  const code = resp.getResponseCode();
  const json = JSON.parse(resp.getContentText() || '{}');
  if (code >= 300 || (json.errors && json.errors.length)) {
    Logger.log('Jobber GraphQL error (HTTP ' + code + '): ' + JSON.stringify(json.errors || {}));
    return { ok: false, data: json.data, errors: json.errors };
  }
  return { ok: true, data: json.data };
}

// Orchestrates the invoice for one drop. Returns a small status object that
// gets folded into the JSON response (handy for the PWA + debugging).
function maybeCreateInvoice_(customerName, loads, tier, jobberUrl, dropDate) {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('JOBBER_REFRESH_TOKEN')) return { skipped: 'not_configured' };

  const encodedClientId = jobberEncodedClientId_(jobberUrl);
  if (!encodedClientId) return { skipped: 'no_jobber_client_id', jobber_url: jobberUrl };

  const rate = customerRate_(tier);          // 0 for free tier — we still issue a $0 invoice
  const result = createJobberInvoice_(encodedClientId, rate, loads, customerName, dropDate);
  if (result && result.ok && result.invoice) {
    // Email the customer the invoice (decision: customer gets it + copy to Joseph).
    sendJobberInvoice_(result.invoice.id);
    notifyInvoice_(customerName, loads, rate, result.invoice);   // Joseph's copy
  }
  return result;
}

// ⚠ SCHEMA-DEPENDENT — VERIFY IN JOBBER GRAPHiQL BEFORE GOING LIVE.
// The transport above (OAuth refresh, token caching, GraphQL POST, client-id
// encoding) is solid. The exact field names in this mutation were written
// without live schema access. Open GraphiQL (Developer Center → Test in
// GraphiQL → Documentation) or your local Jobber MCP, confirm the
// invoiceCreate input shape (clientId, lineItems[].name/quantity/unitPrice,
// subject), adjust below, then ./deploy-apps-script.sh.
function createJobberInvoice_(encodedClientId, rate, loads, customerName, dropDate) {
  const mutation = [
    'mutation CreateInvoice($input: InvoiceCreateInput!) {',
    '  invoiceCreate(input: $input) {',
    '    invoice { id invoiceNumber subject }',
    '    userErrors { message }',
    '  }',
    '}'
  ].join('\n');

  const variables = {
    input: {
      clientId: encodedClientId,
      subject: 'Chip drop — ' + customerName + ' (' + dropDate + ')',
      lineItems: [{
        name: 'Wood chip load',
        quantity: loads,
        unitPrice: +rate.toFixed(2)   // $0 line item for free-tier, per spec
      }]
    }
  };

  const res = jobberGraphQL_(mutation, variables);
  if (!res) return { skipped: 'no_token' };
  if (!res.ok) return { ok: false, errors: res.errors };

  const payload = res.data && res.data.invoiceCreate;
  const userErrors = payload && payload.userErrors;
  if (userErrors && userErrors.length) {
    Logger.log('invoiceCreate userErrors: ' + JSON.stringify(userErrors));
    return { ok: false, user_errors: userErrors };
  }
  return { ok: true, invoice: payload && payload.invoice };
}

// ⚠ SCHEMA-DEPENDENT — VERIFY IN JOBBER GRAPHiQL.
// Emails the created invoice to the client. Some Jobber API versions expose
// invoiceSendEmail / a send transition; confirm the exact mutation. If sending
// isn't available via API on your plan, the invoice is still created in Jobber
// and Joseph's copy email (notifyInvoice_) links to it for manual send.
function sendJobberInvoice_(invoiceId) {
  if (!invoiceId) return;
  const mutation = [
    'mutation SendInvoice($id: EncodedId!) {',
    '  invoiceSendEmail(invoiceId: $id) {',
    '    userErrors { message }',
    '  }',
    '}'
  ].join('\n');
  const res = jobberGraphQL_(mutation, { id: invoiceId });
  if (res && !res.ok) Logger.log('sendJobberInvoice_ failed (verify mutation): ' + JSON.stringify(res.errors));
}

// Joseph's copy/confirmation that an invoice fired. Uses MailApp (reliable,
// fully under our control) rather than relying on Jobber's CC.
function notifyInvoice_(customerName, loads, rate, invoice) {
  const loadsStr = (loads === 0.5) ? '½' : String(loads);
  const total = (rate * loads).toFixed(2);
  const num = invoice && (invoice.invoiceNumber || invoice.id) || '(pending)';
  const subject = `🧾 Invoice ${num}: ${customerName} — $${total}`;
  const body =
    `${customerName}\n` +
    `${loadsStr} load${loads === 1 ? '' : 's'} × $${rate.toFixed(2)} = $${total}\n` +
    `Invoice: ${num}\n` +
    (rate === 0 ? '(Free tier — $0 invoice issued for records)\n' : '') +
    `\nJobber: https://secure.getjobber.com/`;
  try { MailApp.sendEmail({ to: JOSEPH_EMAIL, subject, body }); } catch (e) {
    Logger.log('notifyInvoice_ email failed: ' + e);
  }
}

// Diagnostic — logs whether each Jobber cred is present. Never logs values.
function checkJobberConfig_() {
  const p = PropertiesService.getScriptProperties();
  const state = k => p.getProperty(k) ? 'set' : 'MISSING';
  Logger.log('JOBBER_CLIENT_ID: '     + state('JOBBER_CLIENT_ID'));
  Logger.log('JOBBER_CLIENT_SECRET: ' + state('JOBBER_CLIENT_SECRET'));
  Logger.log('JOBBER_REFRESH_TOKEN: ' + state('JOBBER_REFRESH_TOKEN'));
  Logger.log('API version: ' + JOBBER_API_VERSION);
}

// === DAILY SUMMARY (8 PM trigger) ===

function dailySummary() {
  const today = todayStr_();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const logSheet = ss.getSheetByName(LOG_TAB);

  if (!logSheet || logSheet.getLastRow() < 2) {
    sendDailySummary_('No drops today.', 'No drops today.');
    return;
  }

  // Filter today's logged drops (skip undone + undo-entry rows)
  const data = logSheet.getDataRange().getValues().slice(1);
  const todays = data.filter(r => {
    const dateVal = r[4];
    const dateStr = dateVal instanceof Date
      ? Utilities.formatDate(dateVal, TIME_ZONE, 'yyyy-MM-dd')
      : String(dateVal || '');
    return dateStr === today && r[6] === 'logged';
  });

  if (todays.length === 0) {
    sendDailySummary_(`🪵 TTC ${today}: No drops today.`, `No drops today (${today})`);
    return;
  }

  const totalLoads = +todays.reduce((s, r) => s + (parseFloat(r[2]) || 0), 0).toFixed(2);
  const customers = [...new Set(todays.map(r => r[1]))];
  const drops = todays.length;

  // Resolve tier per customer for invoice estimate
  const sheet = ss.getSheetByName(RESPONSES_TAB);
  const sheetData = sheet.getDataRange().getValues();
  const headers = sheetData[0].map(h => String(h).toLowerCase().trim());
  const findCol = (...needles) => {
    for (let i = 0; i < headers.length; i++) {
      for (const n of needles) {
        if (headers[i].indexOf(n.toLowerCase()) !== -1) return i;
      }
    }
    return -1;
  };
  const fnCol = findCol('first name');
  const lnCol = findCol('last name');
  const tierCol = findCol('select priority', 'priority');

  let invoiceTotal = 0;
  const paidCustomers = [];
  const freeCustomers = [];

  for (const cust of customers) {
    const loadsForCust = +todays.filter(r => r[1] === cust)
      .reduce((s, r) => s + (parseFloat(r[2]) || 0), 0).toFixed(2);

    let tierRaw = '';
    for (let i = 1; i < sheetData.length; i++) {
      const fn = `${sheetData[i][fnCol]} ${sheetData[i][lnCol]}`.trim();
      if (fn === cust) {
        tierRaw = String(sheetData[i][tierCol] || '');
        break;
      }
    }
    const rate = customerRate_(tierRaw);

    if (rate > 0) {
      paidCustomers.push(`  ${cust}: ${loadsForCust}× $${rate} = $${(loadsForCust * rate).toFixed(2)}`);
      invoiceTotal += loadsForCust * rate;
    } else {
      freeCustomers.push(`  ${cust}: ${loadsForCust}`);
    }
  }

  const emailBody =
    `Today (${today}): ${drops} drop${drops === 1 ? '' : 's'}, ${totalLoads} total load${totalLoads === 1 ? '' : 's'}, ${customers.length} customer${customers.length === 1 ? '' : 's'}\n\n` +
    (paidCustomers.length > 0
      ? `💰 Paid (invoice $${invoiceTotal.toFixed(2)} total):\n${paidCustomers.join('\n')}\n\n`
      : '💰 No paid drops today.\n\n') +
    (freeCustomers.length > 0
      ? `🟢 Free:\n${freeCustomers.join('\n')}\n\n`
      : '') +
    `Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

  const smsBody = `${drops} drops, ${totalLoads}L, ${customers.length} cust, $${invoiceTotal.toFixed(0)} to invoice (${today})`;

  sendDailySummary_(emailBody, smsBody);
}

function sendDailySummary_(emailBody, smsBody) {
  const subject = `🪵 TTC Daily Summary — ${todayStr_()}`;
  try { MailApp.sendEmail({ to: JOSEPH_EMAIL, subject, body: emailBody }); } catch (e) {}
  for (const gw of JOSEPH_SMS_GATEWAYS) {
    try { MailApp.sendEmail({ to: gw, subject: '', body: smsBody }); } catch (e) {}
  }
}

// === PHOTO PUBLISHING (durable design) ===
// Form-uploaded photos default to Drive Private. Per-file setSharing() is
// fragile — Drive API hiccups, auth-scope drift, or stale file IDs and the
// photo silently breaks. Solution: a single public folder. We copy each
// uploaded photo into that folder once; the folder's "Anyone with link" perm
// inherits to its files. After this, photos solve themselves forever.
//
// On form submit (and any time makePhotosPublic runs), the script:
//   1. Gets-or-creates the public folder, persisting its ID
//   2. Copies any new photos into it
//   3. Rewrites the sheet's photo cell with the public URL of the copy
// Idempotent: a private→public mapping is cached in script properties, so
// reruns don't re-copy.

const PHOTO_FOLDER_NAME = 'TTC Chip Drop Photos — Public';

// Get or create the public photo folder. Set "Anyone with link → Viewer"
// once. The folder ID is persisted in script properties.
function getOrCreatePhotoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      // Folder still exists — keep using it.
      return f;
    } catch (e) {
      Logger.log('Stored folder id ' + id + ' is gone — creating a new one');
    }
  }
  const folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  Logger.log('Created public photo folder: ' + folder.getName() + ' (' + folder.getId() + ')');
  return folder;
}

// Copy a private Drive file into the public folder. Idempotent — caches the
// private→public mapping so reruns don't duplicate. Returns the public file
// ID, or null if the source is inaccessible.
function copyToPublicFolder_(sourceId, folder) {
  const props = PropertiesService.getScriptProperties();
  const mapKey = 'photo_map_' + sourceId;
  const cachedId = props.getProperty(mapKey);
  if (cachedId) {
    try {
      DriveApp.getFileById(cachedId);  // verify it still exists
      return cachedId;
    } catch (e) {
      // Cached copy was deleted — fall through to re-copy
      props.deleteProperty(mapKey);
    }
  }
  let sourceFile;
  try {
    sourceFile = DriveApp.getFileById(sourceId);
  } catch (e) {
    Logger.log('Cannot access source ' + sourceId + ': ' + e);
    return null;
  }
  try {
    const copy = sourceFile.makeCopy('chip-drop-' + sourceId.slice(0, 16), folder);
    props.setProperty(mapKey, copy.getId());
    Logger.log('Copied to public folder: ' + sourceFile.getName() + ' → ' + copy.getId());
    return copy.getId();
  } catch (e) {
    Logger.log('Copy failed for ' + sourceId + ': ' + e);
    return null;
  }
}

// Rewrite a comma-separated photo cell so every URL points to a public copy.
// If a URL is already in our public folder (cached mapping points back to
// itself), it stays unchanged. Returns the new cell text — or the original
// if nothing changed.
function publishPhotoCell_(cell, folder) {
  if (!cell) return cell;
  const props = PropertiesService.getScriptProperties();
  const folderId = folder.getId();
  const urls = String(cell).split(/\s*,\s*/).filter(u => u);
  const out = [];
  let changed = false;
  for (const url of urls) {
    let m = url.match(/[?&]id=([^&]+)/);
    if (!m) m = url.match(/\/d\/([^/]+)/);
    if (!m) {
      // Not a Drive URL — keep as-is
      out.push(url);
      continue;
    }
    const sourceId = m[1];
    // Already a public copy? Skip.
    // We detect "already public" by checking if this source ID was ever
    // recorded as a copy *target* — i.e. some private→public map points to
    // it. Cheap-but-correct: just check if it lives in our public folder.
    let isAlreadyPublic = false;
    try {
      const f = DriveApp.getFileById(sourceId);
      const parents = f.getParents();
      while (parents.hasNext()) {
        if (parents.next().getId() === folderId) { isAlreadyPublic = true; break; }
      }
    } catch (e) {
      // If we can't even open it, leave the URL alone (don't lose data)
      out.push(url);
      continue;
    }
    if (isAlreadyPublic) {
      out.push(url);
      continue;
    }
    const publicId = copyToPublicFolder_(sourceId, folder);
    if (publicId) {
      out.push('https://drive.google.com/open?id=' + publicId);
      changed = true;
    } else {
      // Copy failed — preserve original URL so we don't lose data
      out.push(url);
    }
  }
  return changed ? out.join(', ') : cell;
}

// Walk every row, publish any photos that aren't yet public, rewrite cell.
// Safe to run on demand — idempotent.
function makePhotosPublic() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(RESPONSES_TAB);
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).toLowerCase().trim());

  const photoCol = headers.findIndex(h => h.indexOf('photo') !== -1);
  if (photoCol < 0) {
    Logger.log('No photo column found.');
    return { updated: 0, unchanged: 0, empty: 0 };
  }

  const folder = getOrCreatePhotoFolder_();
  let updated = 0, unchanged = 0, empty = 0;

  for (let i = 1; i < data.length; i++) {
    const cell = String(data[i][photoCol] || '').trim();
    if (!cell) { empty++; continue; }
    const newCell = publishPhotoCell_(cell, folder);
    if (newCell !== cell) {
      sheet.getRange(i + 1, photoCol + 1).setValue(newCell);
      updated++;
    } else {
      unchanged++;
    }
  }
  Logger.log(`Done. Updated ${updated} rows with public URLs, ${unchanged} already public, ${empty} empty.`);
  return { updated, unchanged, empty };
}

// Form-submit trigger — fires when a new submission lands. The form's row
// write happens before this trigger fires, so we just call makePhotosPublic
// (which is idempotent and only touches rows that need updating).
function onFormSubmit_makePhotoPublic(e) {
  // Wait briefly so the photo file is fully ready in Drive
  Utilities.sleep(2000);
  try {
    makePhotosPublic();
  } catch (err) {
    Logger.log('onFormSubmit failed: ' + err);
  }
}

// Run this once after deploying v3 to schedule the auto-publish trigger.
function setupFormSubmitTrigger() {
  const existing = ScriptApp.getProjectTriggers();
  existing.forEach(t => {
    if (t.getHandlerFunction() === 'onFormSubmit_makePhotoPublic') ScriptApp.deleteTrigger(t);
  });
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ScriptApp.newTrigger('onFormSubmit_makePhotoPublic')
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();
  Logger.log('Form-submit trigger created — new photo uploads will be auto-published.');
}

// Run this once after deploying v2 to schedule the 8 PM trigger.
function setupDailyTrigger() {
  const existing = ScriptApp.getProjectTriggers();
  existing.forEach(t => {
    if (t.getHandlerFunction() === 'dailySummary') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySummary')
    .timeBased()
    .atHour(20)            // 8 PM in script timezone
    .everyDays(1)
    .create();
  Logger.log('Daily summary trigger created — runs daily at 8 PM ' + TIME_ZONE);
}

// === HELPERS ===

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function todayStr_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

// === MANUAL TESTS ===

// Verify the script can write a real drop. Adds 0.5 to Cory Goates,
// sends notifications, returns the response. Run this once to test v2.
function testWriteV2() {
  const result = doPost({
    postData: {
      contents: JSON.stringify({
        secret: SECRET,
        customer_name: 'Cory Goates',
        loads: 0.5,
        date: todayStr_(),
        source: 'manual-test-v2'
      })
    }
  });
  Logger.log(result.getContent());
}

// Send the daily summary right now (instead of waiting for 8 PM).
function testDailySummary() {
  dailySummary();
  Logger.log('Daily summary sent.');
}
