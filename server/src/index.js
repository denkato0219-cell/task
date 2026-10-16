// きょうのよてい notification server (Cloudflare Worker + D1).
//
// API (JSON):
//   GET    /api/config                      -> { vapidPublicKey }
//   POST   /api/children                    (X-Org-Key header) { data } -> { code }
//   GET    /api/children/:code              -> { data, updatedAt }
//   PUT    /api/children/:code              { data, updatedAt } -> { updatedAt }
//   POST   /api/children/:code/devices      { subscription } -> { ok }
//   DELETE /api/children/:code/devices      { endpoint } -> { ok }
//   POST   /api/children/:code/test         -> { sent }
// Cron (every minute): sends the messages due for each child to that child's devices.

import { generateVapidKeys, sendPush } from "./push.js";
import { localParts, notificationFor } from "./schedule.js";

const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
const MAX_BODY = 900_000;
const TZ = "Asia/Tokyo";

const normCode = s => String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(r, b => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Org-Key",
    "Access-Control-Max-Age": "86400",
  };
}
const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(env) } });
const fail = (env, status, message) => json(env, { error: message }, status);

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("データが大きすぎます。写真を減らしてください。"), { status: 413 });
  try { return JSON.parse(text || "{}"); } catch { throw Object.assign(new Error("JSONの形式が正しくありません"), { status: 400 }); }
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function meta(env, k) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first();
  return row ? row.v : null;
}
const setMeta = (env, k, v) => env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();

/** Push keys are created on first use and kept in the database, so setup needs no key handling. */
let vapidCache = null;
async function vapid(env) {
  if (vapidCache) return vapidCache;
  const stored = await meta(env, "vapid");
  if (stored) return (vapidCache = JSON.parse(stored));
  const keys = await generateVapidKeys();
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('vapid', ?) ON CONFLICT(k) DO NOTHING").bind(JSON.stringify(keys)).run();
  return (vapidCache = JSON.parse(await meta(env, "vapid")));
}

async function pushToChild(env, code, payload) {
  const { results } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM devices WHERE code = ?").bind(code).all();
  if (!results.length) return 0;
  const keys = await vapid(env);
  let sent = 0;
  await Promise.all(results.map(async sub => {
    try {
      const r = await sendPush(sub, payload, keys, env.PUSH_SUBJECT);
      if (r.ok) sent++;
      else if (r.gone) await env.DB.prepare("DELETE FROM devices WHERE endpoint = ?").bind(sub.endpoint).run();
      else console.log("push failed", r.status, new URL(sub.endpoint).host);
    } catch (e) { console.log("push error", e.message); }
  }));
  return sent;
}

async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
  if (url.pathname === "/" || url.pathname === "/api/health") return json(env, { ok: true, app: "kyou-yotei" });
  if (url.pathname === "/api/config" && req.method === "GET") return json(env, { vapidPublicKey: (await vapid(env)).publicKey });

  if (url.pathname === "/api/children" && req.method === "POST") {
    if (!env.ORG_KEY) return fail(env, 503, "サーバーに事業所キー（ORG_KEY）が設定されていません");
    if (!sameSecret(req.headers.get("X-Org-Key") || "", env.ORG_KEY)) return fail(env, 403, "事業所キーが違います");
    const { data } = await readJson(req);
    if (!data || typeof data !== "object") return fail(env, 400, "data がありません");
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const r = await env.DB.prepare("INSERT OR IGNORE INTO children (code, data, updated_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(code, JSON.stringify({ ...data, code }), now, now).run();
      if (r.meta.changes) return json(env, { code, updatedAt: now }, 201);
    }
    return fail(env, 500, "コードを作れませんでした。もう一度ためしてください");
  }

  const m = url.pathname.match(/^\/api\/children\/([^/]+)(\/devices|\/test)?$/);
  if (!m) return fail(env, 404, "見つかりません");
  const code = normCode(decodeURIComponent(m[1]));
  const row = await env.DB.prepare("SELECT data, updated_at FROM children WHERE code = ?").bind(code).first();
  if (!row) return fail(env, 404, "このコードの こどもは 見つかりません");

  if (!m[2] && req.method === "GET") return json(env, { data: JSON.parse(row.data), updatedAt: row.updated_at });

  if (!m[2] && req.method === "PUT") {
    const { data, updatedAt } = await readJson(req);
    if (!data || typeof data !== "object") return fail(env, 400, "data がありません");
    const at = Number(updatedAt) || Date.now();
    // Last edit wins: an older copy from a phone that was offline does not overwrite a newer one.
    if (at < row.updated_at) return json(env, { stale: true, data: JSON.parse(row.data), updatedAt: row.updated_at }, 409);
    await env.DB.prepare("UPDATE children SET data = ?, updated_at = ? WHERE code = ?").bind(JSON.stringify({ ...data, code }), at, code).run();
    return json(env, { updatedAt: at });
  }

  if (m[2] === "/devices" && req.method === "POST") {
    const { subscription: s } = await readJson(req);
    if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth || !/^https:\/\//.test(s.endpoint)) return fail(env, 400, "通知の登録情報が正しくありません");
    await env.DB.prepare(`INSERT INTO devices (endpoint, code, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint, code) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`)
      .bind(s.endpoint, code, s.keys.p256dh, s.keys.auth, Date.now()).run();
    return json(env, { ok: true });
  }
  if (m[2] === "/devices" && req.method === "DELETE") {
    const { endpoint } = await readJson(req);
    await env.DB.prepare("DELETE FROM devices WHERE endpoint = ? AND code = ?").bind(String(endpoint || ""), code).run();
    return json(env, { ok: true });
  }
  if (m[2] === "/test" && req.method === "POST") {
    const sent = await pushToChild(env, code, { title: "🔔 テスト", body: "つうちが とどきました", tag: "test-" + Date.now() });
    return json(env, { sent });
  }
  return fail(env, 405, "この操作はできません");
}

/** Every minute: catch up on any minutes the scheduler missed (up to 5), then send what is due. */
export async function runSchedule(env, now = new Date()) {
  const nowMin = Math.floor(now.getTime() / 60000);
  const last = Number(await meta(env, "last_minute")) || nowMin - 1;
  await setMeta(env, "last_minute", String(nowMin));
  const minutes = [];
  for (let t = Math.max(last + 1, nowMin - 4); t <= nowMin; t++) minutes.push(t);
  if (!minutes.length) return 0;

  const { results } = await env.DB.prepare("SELECT code, data FROM children WHERE code IN (SELECT DISTINCT code FROM devices)").all();
  let sent = 0;
  for (const row of results) {
    const child = JSON.parse(row.data);
    for (const t of minutes) {
      const n = notificationFor(child, localParts(new Date(t * 60000), child.timeZone || TZ));
      if (n) sent += await pushToChild(env, row.code, n);
    }
  }
  return sent;
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return fail(env, e.status || 500, e.status ? e.message : "サーバーでエラーが起きました"); }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  },
};
