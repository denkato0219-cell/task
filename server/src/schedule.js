// Works out which messages are due for a child at a given local minute.
// Mirrors the timing rules in index.html so the closed-app notifications say
// the same thing at the same time as the open app.

export const DEFAULT_MSGS = {
  pre: "あと {ふん}ふんごに、{なまえ}を はじめるよ",
  start: "いまから、{なまえ}を はじめるよ",
  warn: "あと {ふん}ふんで おわりだよ",
  end: "{なまえ}、おわりだよ",
};
const ORDER = { wake: -1, warn: 0, end: 1, pre: 2, start: 3 };

const toMin = s => { const [h, m] = String(s || "0:0").split(":").map(Number); return h * 60 + m; };

/** Local calendar parts for `date` in `timeZone`, with dayKey in the app's "YYYY-M-D" form. */
export function localParts(date, timeZone = "Asia/Tokyo") {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { dayKey: `${p.year}-${Number(p.month)}-${Number(p.day)}`, wd, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export function todayPattern(c, dayKey, wd) {
  if (c.override?.date === dayKey) return c.patterns?.find(p => p.id === c.override.pattern) || null;
  return c.patterns?.find(p => (p.days || []).includes(wd)) || null;
}

export function todayTasks(c, dayKey, wd) {
  const p = todayPattern(c, dayKey, wd);
  if (!p) return [];
  const shifts = c.day?.date === dayKey ? c.day.shifts || {} : {};
  return (p.tasks || []).map(t => ({ ...t, ...(shifts[t.id] || {}) })).sort((a, b) => toMin(a.start) - toMin(b.start));
}

const shownName = (t, mode) => (mode === "kana" ? t.yomi || t.name : t.name || t.yomi) || "";

/** Messages due at exactly `minute`, ordered endings first. */
export function dueEvents(c, { dayKey, wd, minute }) {
  const p = todayPattern(c, dayKey, wd);
  if (!p) return [];
  const msgs = { ...DEFAULT_MSGS, ...(c.msgs || {}) };
  const pre = Number(c.preMin ?? 5), warn = Number(c.warnMin ?? 5);
  const out = [];
  if (toMin(p.wake) === minute) out.push({ kind: "wake", icon: "⏰", name: "", text: c.wakeMsg || "おきる じかんだよ" });
  for (const t of todayTasks(c, dayKey, wd)) {
    if (t.notify === false) continue;
    const s = toMin(t.start), e = toMin(t.end), name = shownName(t, c.textMode);
    const fill = (kind, min) => msgs[kind].replaceAll("{なまえ}", name).replaceAll("{ふん}", String(min ?? ""));
    const base = { icon: t.icon || "🧩", name };
    if (pre > 0 && s - pre === minute) out.push({ ...base, kind: "pre", text: fill("pre", pre) });
    if (s === minute) out.push({ ...base, kind: "start", text: fill("start") });
    if (warn > 0 && e - s > warn && e - warn === minute) out.push({ ...base, kind: "warn", text: fill("warn", warn) });
    if (e === minute) out.push({ ...base, kind: "end", text: fill("end") });
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

/** One notification for everything due this minute, or null. */
export function notificationFor(c, when) {
  const ev = dueEvents(c, when);
  if (!ev.length) return null;
  const last = ev[ev.length - 1];
  const who = c.name && c.name !== "こども" ? `${c.name}さん ` : "";
  return {
    title: last.kind === "wake" ? `⏰ ${who}おはよう` : `${last.icon} ${who}${last.name}`,
    body: ev.map(e => e.text).join("\n"),
    tag: `${when.dayKey}-${when.minute}`,
  };
}
