// Run: npm test   (Node 22+)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { encryptPayload, b64u } from "../src/push.js";
import { dueEvents, notificationFor, localParts } from "../src/schedule.js";
import worker, { runSchedule } from "../src/index.js";

const ece = createRequire(import.meta.url)("http_ece");

/* A browser-side subscription key pair, as an iPhone would make. */
async function fakeBrowser() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const { createECDH } = await import("node:crypto");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(jwk.d, "base64url"));
  return { p256dh: b64u(pub), auth: b64u(auth), decrypt: body => ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ecdh, authSecret: Buffer.from(auth) }).toString() };
}

test("payload encryption matches the standard (decrypts with http_ece)", async () => {
  const b = await fakeBrowser();
  const body = await encryptPayload(JSON.stringify({ title: "🪥 はみがき", body: "いまから、はみがきを はじめるよ" }), b.p256dh, b.auth);
  assert.deepEqual(JSON.parse(b.decrypt(body)), { title: "🪥 はみがき", body: "いまから、はみがきを はじめるよ" });
});

const child = {
  name: "たろう", textMode: "kana", preMin: 5, warnMin: 5, wakeMsg: "おはよう！",
  msgs: { pre: "あと {ふん}ふんごに、{なまえ}を はじめるよ", start: "いまから、{なまえ}を はじめるよ", warn: "あと {ふん}ふんで おわりだよ", end: "{なまえ}、おわりだよ" },
  patterns: [
    { id: "school", name: "学校の日", days: [1, 2, 3, 4, 5], wake: "06:30", tasks: [
      { id: "a", icon: "🍚", name: "朝ごはん", yomi: "あさごはん", start: "07:00", end: "07:30", notify: true },
      { id: "b", icon: "🪥", name: "歯みがき", yomi: "はみがき", start: "07:30", end: "07:40", notify: true },
      { id: "c", icon: "📺", name: "テレビ", yomi: "てれび", start: "07:40", end: "07:50", notify: false } ] },
    { id: "off", name: "お休みの日", days: [0, 6], wake: "08:00", tasks: [] } ],
  override: null, day: { date: "2026-10-16", done: [], shifts: {} },
};
const fri = m => ({ dayKey: "2026-10-16", wd: 5, minute: m });

test("messages at each moment", () => {
  assert.deepEqual(dueEvents(child, fri(6 * 60 + 30)).map(e => e.text), ["おはよう！"]);
  assert.deepEqual(dueEvents(child, fri(6 * 60 + 55)).map(e => e.text), ["あと 5ふんごに、あさごはんを はじめるよ"]);
  assert.deepEqual(dueEvents(child, fri(7 * 60 + 25)).map(e => e.text), ["あと 5ふんで おわりだよ", "あと 5ふんごに、はみがきを はじめるよ"]);
  assert.deepEqual(dueEvents(child, fri(7 * 60 + 30)).map(e => e.text), ["あさごはん、おわりだよ", "いまから、はみがきを はじめるよ"]);
  assert.deepEqual(dueEvents(child, fri(7 * 60 + 40)).map(e => e.text), ["はみがき、おわりだよ"], "notify:false task stays quiet");
  assert.equal(dueEvents(child, { dayKey: "2026-10-17", wd: 6, minute: 6 * 60 + 30 }).length, 0, "Saturday uses the other pattern");
  assert.equal(notificationFor(child, fri(7 * 60 + 30)).title, "🪥 たろうさん はみがき");
});

test("today's delay and pattern override are honoured", () => {
  const c = structuredClone(child);
  c.day.shifts = { a: { start: "07:00", end: "07:40" }, b: { start: "07:40", end: "07:50" } };
  assert.deepEqual(dueEvents(c, fri(7 * 60 + 30)).map(e => e.kind), [], "old end time no longer fires");
  assert.deepEqual(dueEvents(c, fri(7 * 60 + 40)).map(e => e.kind), ["end", "start"]);
  c.override = { date: "2026-10-16", pattern: "off" };
  assert.deepEqual(dueEvents(c, fri(8 * 60)).map(e => e.kind), ["wake"]);
});

test("local time is Japan time", () => {
  assert.deepEqual(localParts(new Date("2026-10-15T22:30:00Z")), { dayKey: "2026-10-16", wd: 5, minute: 7 * 60 + 30 });
});

/* Minimal D1 stand-in over node:sqlite. */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { prepare: sql => stmt(sql), raw: db };
}

test("API + scheduler deliver an encrypted push at the right minute", async () => {
  const env = { DB: fakeD1(), ORG_KEY: "secret-key", PUSH_SUBJECT: "https://example.org/", ALLOWED_ORIGIN: "*" };
  const call = async (method, path, body, headers = {}) => {
    const r = await worker.fetch(new Request("https://w.example" + path, { method, body: body && JSON.stringify(body), headers }), env);
    return { status: r.status, body: await r.json() };
  };

  assert.equal((await call("POST", "/api/children", { data: child }, { "X-Org-Key": "wrong" })).status, 403);
  const made = await call("POST", "/api/children", { data: child }, { "X-Org-Key": "secret-key" });
  assert.equal(made.status, 201);
  const code = made.body.code;
  assert.match(code, /^[2-9A-Z]{10}$/);
  assert.equal((await call("GET", `/api/children/${code.slice(0, 5)}-${code.slice(5).toLowerCase()}`)).body.data.name, "たろう", "code typed with dash and lower case");

  const stale = await call("PUT", `/api/children/${code}`, { data: { ...child, name: "古い" }, updatedAt: 1 });
  assert.equal(stale.status, 409);

  const cfg = await call("GET", "/api/config");
  assert.equal(cfg.body.vapidPublicKey.length, 87);

  // Local stand-in for Apple's push service.
  const got = [];
  const srv = http.createServer((req, res) => { const parts = []; req.on("data", d => parts.push(d)); req.on("end", () => { got.push({ headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(201).end(); }); });
  await new Promise(r => srv.listen(0, r));
  const b = await fakeBrowser();
  env.DB.raw.prepare("INSERT INTO devices (endpoint, code, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)").run(`http://127.0.0.1:${srv.address().port}/push/1`, code, b.p256dh, b.auth);

  env.DB.raw.prepare("INSERT INTO meta (k, v) VALUES ('last_minute', ?)").run(String(Math.floor(Date.parse("2026-10-15T22:29:00Z") / 60000)));
  const sent = await runSchedule(env, new Date("2026-10-15T22:30:10Z")); // 07:30 in Japan
  srv.close();
  assert.equal(sent, 1);
  assert.equal(got.length, 1);
  assert.match(got[0].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  assert.equal(got[0].headers["content-encoding"], "aes128gcm");
  const msg = JSON.parse(b.decrypt(got[0].body));
  assert.equal(msg.body, "あさごはん、おわりだよ\nいまから、はみがきを はじめるよ");
  assert.equal(await runSchedule(env, new Date("2026-10-15T22:30:40Z")), 0, "same minute is not sent twice");
});
