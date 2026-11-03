var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// functions/api/_middleware.js
async function onRequest(context) {
  const { request } = context;
  if (request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch (e) {
        originHost = null;
      }
      const reqHost = request.headers.get("Host") || new URL(request.url).host;
      if (!originHost || originHost !== reqHost) {
        return json({ error: "bad_origin" }, 403);
      }
    }
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders() });
  }
  let res;
  try {
    res = await context.next();
  } catch (e) {
    return json({ error: "internal" }, 500);
  }
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  const ct = headers.get("Content-Type") || "";
  if (!/^text\/csv/i.test(ct)) headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
function baseHeaders() {
  return { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: baseHeaders() });
}

// functions/api/event.js
var event_exports = {};
__export(event_exports, {
  onRequestGet: () => onRequestGet,
  onRequestPost: () => onRequestPost
});
var TYPES = /* @__PURE__ */ new Set(["visit", "trial_start", "trial_done", "buy_click", "signup", "study_open", "exam_done"]);
var SOURCE_RE = /^[A-Za-z0-9_-]{1,32}$/;
var EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
var MAX_BODY = 2048;
var MAX_META_KEYS = 12;
async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.EVENTS || typeof env.EVENTS.put !== "function") {
    return json2({ error: "storage_not_configured" }, 503);
  }
  let text;
  try {
    text = await request.text();
  } catch (e) {
    return json2({ error: "bad_body" }, 400);
  }
  if (!text || text.length > MAX_BODY) return json2({ error: "bad_body" }, 400);
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return json2({ error: "bad_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json2({ error: "bad_json" }, 400);
  const type = typeof body.type === "string" ? body.type : "";
  if (!TYPES.has(type)) return json2({ error: "bad_type" }, 400);
  let source = typeof body.source === "string" ? body.source : "direct";
  if (!SOURCE_RE.test(source)) return json2({ error: "bad_source" }, 400);
  let email = null;
  if (type === "signup") {
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) return json2({ error: "bad_email" }, 400);
  }
  const meta = {};
  if (body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
    for (const k of Object.keys(body.meta).slice(0, MAX_META_KEYS)) {
      const v = body.meta[k];
      const key2 = String(k).slice(0, 32);
      if (typeof v === "number" && Number.isFinite(v)) meta[key2] = v;
      else if (typeof v === "boolean") meta[key2] = v;
      else if (typeof v === "string") meta[key2] = v.slice(0, 64);
    }
  }
  const ts = Date.now();
  const record = {
    type,
    source,
    email,
    meta,
    ua: (request.headers.get("User-Agent") || "").slice(0, 80),
    ts
  };
  const key = `ev:${ts}:${randomId()}`;
  try {
    await env.EVENTS.put(key, JSON.stringify(record));
  } catch (e) {
    return json2({ error: "storage_error" }, 500);
  }
  return new Response(null, { status: 204 });
}
async function onRequestGet() {
  return json2({ error: "method_not_allowed" }, 405);
}
function randomId() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function json2(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// functions/api/stats.js
var stats_exports = {};
__export(stats_exports, {
  onRequestGet: () => onRequestGet2
});
var MAX_KEYS = 5e3;
var DAY = 24 * 60 * 60 * 1e3;
async function onRequestGet2(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (!env.STATS_KEY || key.length === 0 || !timingSafeEqual(key, env.STATS_KEY)) {
    return json3({ error: "unauthorized" }, 401);
  }
  if (!env.EVENTS || typeof env.EVENTS.list !== "function") {
    return json3({ error: "storage_not_configured" }, 503);
  }
  const events = await loadEvents(env.EVENTS);
  if (url.searchParams.get("format") === "csv") {
    const withEmails = url.searchParams.get("emails") === "1";
    return new Response(toCsv(events, withEmails), {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="einb-events.csv"' }
    });
  }
  return json3(aggregate(events, Date.now()), 200);
}
async function loadEvents(kv) {
  const events = [];
  let cursor;
  let fetched = 0;
  do {
    const page = await kv.list({ prefix: "ev:", cursor, limit: 1e3 });
    const keys = page.keys || [];
    fetched += keys.length;
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const values = await Promise.all(chunk.map((k) => kv.get(k.name).catch(() => null)));
      values.forEach((v, j) => {
        if (!v) return;
        try {
          const ev = JSON.parse(v);
          if (ev && typeof ev === "object") {
            ev._key = chunk[j].name;
            events.push(ev);
          }
        } catch (e) {
        }
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && fetched < MAX_KEYS);
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return events;
}
function aggregate(events, now) {
  const byType = {};
  const bySource = {};
  const signupEmails = /* @__PURE__ */ new Set();
  const visitorIds = /* @__PURE__ */ new Set();
  let first = null, last = null;
  const window7 = emptyWindow(), window14 = emptyWindow();
  const daily = {};
  for (const ev of events) {
    const t = ev.type || "unknown";
    const s = ev.source || "direct";
    byType[t] = (byType[t] || 0) + 1;
    bySource[s] = bySource[s] || {};
    bySource[s][t] = (bySource[s][t] || 0) + 1;
    if (t === "signup" && ev.email) signupEmails.add(String(ev.email).toLowerCase());
    if (t === "visit" && ev.meta && ev.meta.vid) visitorIds.add(String(ev.meta.vid));
    const ts = typeof ev.ts === "number" ? ev.ts : null;
    if (ts !== null) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
      const age = now - ts;
      if (age <= 7 * DAY) bump(window7, t, ev);
      if (age <= 14 * DAY) bump(window14, t, ev);
      const day = new Date(ts).toISOString().slice(0, 10);
      daily[day] = daily[day] || {};
      daily[day][t] = (daily[day][t] || 0) + 1;
    }
  }
  const funnel = {
    visits: byType.visit || 0,
    unique_visitors_estimate: visitorIds.size,
    trial_start: byType.trial_start || 0,
    trial_done: byType.trial_done || 0,
    buy_click: byType.buy_click || 0,
    signups: byType.signup || 0,
    unique_signup_emails: signupEmails.size
  };
  funnel.rates = {
    visit_to_trial: ratio(funnel.trial_start, funnel.unique_visitors_estimate || funnel.visits),
    trial_completion: ratio(funnel.trial_done, funnel.trial_start),
    visit_to_buy_click: ratio(funnel.buy_click, funnel.unique_visitors_estimate || funnel.visits),
    buy_click_to_signup: ratio(funnel.unique_signup_emails, funnel.buy_click)
  };
  return {
    generated_at: new Date(now).toISOString(),
    events_total: events.length,
    truncated: events.length >= MAX_KEYS,
    first_event: first ? new Date(first).toISOString() : null,
    last_event: last ? new Date(last).toISOString() : null,
    notes: {
      visits: "visit = pageview, no dedupe; unique_visitors_estimate = distinct per-device random ids (einb.vid) seen on visit events",
      emails: "aggregate never includes email addresses; use format=csv&emails=1 for the raw export"
    },
    funnel,
    by_type: byType,
    by_source: bySource,
    last_7_days: finishWindow(window7),
    last_14_days: finishWindow(window14),
    daily
  };
}
function emptyWindow() {
  return { by_type: {}, signup_emails: /* @__PURE__ */ new Set(), visitor_ids: /* @__PURE__ */ new Set() };
}
function bump(w, type, ev) {
  w.by_type[type] = (w.by_type[type] || 0) + 1;
  if (type === "signup" && ev.email) w.signup_emails.add(String(ev.email).toLowerCase());
  if (type === "visit" && ev.meta && ev.meta.vid) w.visitor_ids.add(String(ev.meta.vid));
}
function finishWindow(w) {
  return { by_type: w.by_type, unique_signup_emails: w.signup_emails.size, unique_visitors_estimate: w.visitor_ids.size };
}
function ratio(a, b) {
  return b ? Math.round(1e3 * a / b) / 1e3 : null;
}
function toCsv(events, withEmails) {
  const cols = ["ts_iso", "ts", "type", "source"].concat(withEmails ? ["email"] : []).concat(["meta", "ua", "key"]);
  const lines = [cols.map(csvCell).join(",")];
  for (const ev of events) {
    const row = [
      ev.ts ? new Date(ev.ts).toISOString() : "",
      ev.ts || "",
      ev.type || "",
      ev.source || ""
    ];
    if (withEmails) row.push(ev.email || "");
    row.push(JSON.stringify(ev.meta || {}), ev.ua || "", ev._key || "");
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
function csvCell(v) {
  const s = String(v == null ? "" : v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
}
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
function json3(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// functions/api/unlock.js
var unlock_exports = {};
__export(unlock_exports, {
  onRequestGet: () => onRequestGet3,
  onRequestPost: () => onRequestPost2
});

// functions/api/_paddle.js
var FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1e3;
function paymentConfigured(env) {
  return !!(env && env.PADDLE_API_KEY && env.PADDLE_PRICE_ID && env.UNLOCK_SECRET);
}
function paddleBase(env) {
  return env.PADDLE_ENV === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
}
async function paddleGet(env, path) {
  const res = await fetch(paddleBase(env) + path, {
    headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}`, Accept: "application/json" }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paddle_${res.status}`);
  return res.json();
}
function transactionUnlocks(txn, priceId) {
  if (!txn) return false;
  const status = String(txn.status || "").toLowerCase();
  if (status !== "completed" && status !== "paid") return false;
  const items = Array.isArray(txn.items) ? txn.items : [];
  return items.some((it) => it && it.price && it.price.id === priceId);
}
function emailFromTransaction(txn) {
  if (!txn) return null;
  if (txn.customer && txn.customer.email) return String(txn.customer.email).toLowerCase();
  if (txn.billing_details && txn.billing_details.email) return String(txn.billing_details.email).toLowerCase();
  if (txn.customer_email) return String(txn.customer_email).toLowerCase();
  return null;
}
async function makeToken(env, email, txnId) {
  const payload = { email: email || null, txn: txnId || null, exp: Date.now() + FIVE_YEARS_MS };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.UNLOCK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return body + "." + b64url(new Uint8Array(sig));
}
function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function readJsonBody(request, maxLen) {
  let text;
  try {
    text = await request.text();
  } catch (e) {
    return null;
  }
  if (!text || text.length > (maxLen || 2048)) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch (e) {
    return null;
  }
}
function json4(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// functions/api/unlock.js
var TXN_RE = /^txn_[A-Za-z0-9]{10,64}$/;
async function onRequestPost2(context) {
  const { request, env } = context;
  if (!paymentConfigured(env)) return json4({ error: "payment_not_configured" }, 503);
  const body = await readJsonBody(request, 1024);
  const txnId = body && typeof body.txn === "string" ? body.txn.trim() : "";
  if (!TXN_RE.test(txnId)) return json4({ error: "bad_txn" }, 400);
  let data;
  try {
    data = await paddleGet(env, `/transactions/${encodeURIComponent(txnId)}?include=customer`);
  } catch (e) {
    return json4({ error: "paddle_unavailable" }, 502);
  }
  if (!data || !data.data) return json4({ error: "not_found" }, 404);
  const txn = data.data;
  if (!transactionUnlocks(txn, env.PADDLE_PRICE_ID)) return json4({ error: "not_paid" }, 402);
  let email = emailFromTransaction(txn);
  if (!email && txn.customer_id) {
    try {
      const c = await paddleGet(env, `/customers/${encodeURIComponent(txn.customer_id)}`);
      if (c && c.data && c.data.email) email = String(c.data.email).toLowerCase();
    } catch (e) {
    }
  }
  const token = await makeToken(env, email, txn.id || txnId);
  return json4({ token }, 200);
}
async function onRequestGet3() {
  return json4({ error: "method_not_allowed" }, 405);
}

// functions/api/restore.js
var restore_exports = {};
__export(restore_exports, {
  onRequestGet: () => onRequestGet4,
  onRequestPost: () => onRequestPost3
});
var EMAIL_RE2 = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
async function onRequestPost3(context) {
  const { request, env } = context;
  if (!paymentConfigured(env)) return json4({ error: "payment_not_configured" }, 503);
  const body = await readJsonBody(request, 1024);
  const email = body && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE2.test(email) || email.length > 254) return json4({ error: "bad_email" }, 400);
  let customers;
  try {
    customers = await paddleGet(env, `/customers?email=${encodeURIComponent(email)}&per_page=10`);
  } catch (e) {
    return json4({ error: "paddle_unavailable" }, 502);
  }
  const list = customers && Array.isArray(customers.data) ? customers.data : [];
  const ids = list.filter((c) => c && c.id && String(c.email || "").toLowerCase() === email).map((c) => c.id);
  if (!ids.length) return json4({ error: "not_found" }, 404);
  for (const customerId of ids) {
    let txns;
    try {
      txns = await paddleGet(env, `/transactions?customer_id=${encodeURIComponent(customerId)}&status=completed&per_page=50`);
    } catch (e) {
      return json4({ error: "paddle_unavailable" }, 502);
    }
    const rows = txns && Array.isArray(txns.data) ? txns.data : [];
    const hit = rows.find((t) => transactionUnlocks(t, env.PADDLE_PRICE_ID));
    if (hit) {
      const token = await makeToken(env, email, hit.id);
      return json4({ token }, 200);
    }
  }
  return json4({ error: "not_found" }, 404);
}
async function onRequestGet4() {
  return json4({ error: "method_not_allowed" }, 405);
}

// worker/entry.js
var ROUTES = { "/api/event": event_exports, "/api/stats": stats_exports, "/api/unlock": unlock_exports, "/api/restore": restore_exports };
var entry_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname.replace(/\/$/, "")];
    if (!mod) {
      if (url.pathname.startsWith("/api/")) return new Response('{"error":"not_found"}', { status: 404, headers: { "Content-Type": "application/json" } });
      return env.ASSETS.fetch(request);
    }
    const context = { request, env, waitUntil: ctx.waitUntil.bind(ctx), next: async () => {
      const m = request.method;
      const h = m === "POST" ? mod.onRequestPost : m === "GET" ? mod.onRequestGet : null;
      if (!h) return new Response('{"error":"method_not_allowed"}', { status: 405 });
      return h({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    } };
    return onRequest(context);
  }
};
export {
  entry_default as default
};
