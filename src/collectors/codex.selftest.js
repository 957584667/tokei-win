/* 一次性自检脚本（跑完即删）
 *   node --expose-gc src/collectors/codex.selftest.js      → 真实日志数值 + 增量行为
 *   node src/collectors/codex.selftest.js --synthetic      → 合成日志：额度映射/翻篇/Reserve/前缀去重/双写/诱饵行
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const B = path.join(__dirname, "..", "..", "dist-codex-check");
const SYNTH = process.argv.includes("--synthetic");

function pad(n, w = 2) { return String(n).padStart(w, "0"); }
function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T`
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function check(label, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra === undefined ? "" : "  " + JSON.stringify(extra)}`);
  return ok;
}

// ---------- 合成场景（必须在 require codex 之前把环境变量摆好）----------
function buildSynthetic() {
  const root = path.join(os.tmpdir(), "tokei-codex-synth");
  const sessions = path.join(root, "sessions");
  const archived = path.join(root, "archived");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const config = path.join(root, "config.toml");
  fs.writeFileSync(config, 'model_provider = "openai"\n\n[model_providers.custom]\nname = "custom"\n');

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
  const ts = (h, m, s = 0) => isoLocal(new Date(dayStart.getTime() + h * 3600e3 + m * 60e3 + s * 1000));
  const future = Math.floor((now.getTime() + 3 * 3600e3) / 1000);
  const past = Math.floor((now.getTime() - 36 * 3600e3) / 1000);
  const U = (i, c, o, r) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, reasoning_output_tokens: r });
  const mainLimits = {
    limit_id: "codex", plan_type: "pro",
    primary: { window_minutes: 300, used_percent: 62.5, resets_at: future },
    secondary: { window_minutes: 10080, used_percent: 80, resets_at: past },
  };
  const reserveLimits = {
    limit_id: "base_model_inference", limit_name: "gpt-reserve", plan_type: "pro",
    primary: { window_minutes: 10080, used_percent: 40, resets_at: future },
  };
  const meta = (id, model, extra) => JSON.stringify({ timestamp: ts(0, 0), type: "session_meta", payload: Object.assign({ id, model }, extra || {}) });
  const turn = (t, model) => JSON.stringify({ timestamp: t, type: "turn_context", payload: { huge: "x".repeat(2048), model } });
  const tc = (t, total, last, rl, rid) => JSON.stringify({
    timestamp: t, type: "event_msg",
    payload: Object.assign({ type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
      rl ? { rate_limits: rl } : {}, rid ? { response_id: rid } : {}),
  });
  const tur = (t, usage, threadTotal, rid) => JSON.stringify({
    timestamp: t, type: "token_usage_record", payload: { response_id: rid, usage, thread_token_usage: threadTotal },
  });

  // 1) 父会话：3 条真实调用（第 2 条走 Reserve 事件级额度）+ 重复累计快照 + 巨型诱饵行
  const parent = [
    meta("P", "gpt-5.5"),
    tc(ts(1, 0), U(1000, 200, 100, 30), U(1000, 200, 100, 30), mainLimits, "resp-1"),
    tc(ts(1, 5), U(2000, 400, 250, 80), U(1000, 200, 150, 50), reserveLimits, "resp-2"),
    tc(ts(1, 10), U(3000, 600, 300, 90), U(1000, 200, 50, 10), mainLimits, "resp-3"),
    tc(ts(1, 11), U(3000, 600, 300, 90), U(1000, 200, 50, 10), null, "resp-4"),
    JSON.stringify({ timestamp: ts(1, 12), type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ blob: "x".repeat(4096), note: '"type":"token_count"' }) } }),
  ];
  // 2) fork：整段回放父会话前 4 条，再新增 1 条 → drop_count 应为 4
  const fork = [
    meta("F", "gpt-5.5", { forked_from_id: "P" }),
    turn(ts(2, 0), "gpt-5.5"),
    ...parent.slice(1, 5),
    tc(ts(2, 30), U(4000, 800, 400, 120), U(1000, 200, 100, 30), mainLimits, "resp-9"),
  ];
  // 3) 双写：旧式通知先计入、token_usage_record 后到且数字一致（规则 B）；反向（规则 C）
  const dual = [
    meta("D", "gpt-5.5"),
    tc(ts(3, 0), U(5000, 1000, 500, 150), U(5000, 1000, 500, 150), null),
    tur(ts(3, 1), U(5000, 1000, 500, 150), U(5000, 1000, 500, 150), "resp-d1"),
    tur(ts(3, 2), U(6000, 1200, 600, 180), U(11000, 2200, 1100, 330), "resp-d2"),
    tc(ts(3, 3), U(11000, 2200, 1100, 330), U(6000, 1200, 600, 180), null),
  ];
  // 4) 同 thread id 两段（resume）：响应带 id 且部分重叠 → 两段都保留，重叠只算一次
  const segA = [
    meta("S", "gpt-5.5"),
    tur(ts(4, 0), U(100, 10, 5, 1), U(100, 10, 5, 1), "resp-s1"),
    tur(ts(4, 1), U(200, 20, 10, 2), U(300, 30, 15, 3), "resp-s2"),
  ];
  const segB = [
    meta("S", "gpt-5.5"),
    tur(ts(4, 30), U(200, 20, 10, 2), U(300, 30, 15, 3), "resp-s2"),
    tur(ts(4, 31), U(300, 30, 15, 3), U(600, 60, 30, 6), "resp-s3"),
  ];
  // 5) 旧式分页（无 response id，靠 history_base 区分续页）→ 两页都保留
  const page1 = [
    meta("L", "gpt-5.5", { history_base: { seq: 1 } }),
    tc(ts(6, 0), U(200, 20, 10, 2), U(200, 20, 10, 2), mainLimits),
  ];
  const page2 = [
    meta("L", "gpt-5.5", { history_base: { seq: 2 } }),
    tc(ts(6, 30), U(500, 50, 25, 5), U(300, 30, 15, 3), mainLimits),
  ];
  const write = (name, rows) => fs.writeFileSync(path.join(sessions, name), rows.join("\n") + "\n");
  write("rollout-2026-09-25T10-00-00-P.jsonl", parent);
  write("rollout-2026-09-25T11-00-00-F.jsonl", fork);
  write("rollout-2026-09-25T12-00-00-D.jsonl", dual);
  fs.mkdirSync(path.join(sessions, "nested"), { recursive: true });
  write(path.join("nested", "rollout-2026-09-25T13-00-00-S1.jsonl"), segA);
  write(path.join("nested", "rollout-2026-09-25T13-00-30-S2.jsonl"), segB);
  write(path.join("nested", "rollout-2026-09-25T14-00-00-L1.jsonl"), page1);
  write(path.join("nested", "rollout-2026-09-25T14-00-30-L2.jsonl"), page2);
  return { sessions, config, now, future, past, dayStart };
}

// ---------- 纯函数单测（不需要日志目录）----------
const FIXED = new Date(1700000000000);
const FISO = isoLocal(FIXED);
const FDAY = localDay(FIXED);
const FHOUR = FIXED.getHours();
const mk = (li, lc, lo, lr, model, rid) => [FISO, FDAY, li, lc, lo, lr, li, lc, lo, lr, 0, model, rid || null];
function entryOf(id, events, fork) {
  return {
    sig: "s", events, days: {}, deduped_days: {}, session_id: id, forked_from_id: fork || null,
    history_base: null, limits: null, limits_ts: null, plan: null, g_limits: null, g_ts: null, g_plan: null,
    reserve_limits: null, reserve_limits_ts: null, last_total: null, prev_total_key: null, active_model: "gpt-5.5",
    parser_version: 8, accounting_version: 7, response_ids: [], pending_responses: [], last_legacy_snapshot: null,
    file_id: "1:1", parsed_size: 0, parsed_guard: "", event_count: events.length,
    first_keys: events.map((e) => C.codexEventKey(e)).filter((k) => k).slice(0, 2),
    first_event_ts: events[0] ? events[0][0] : null, last_event_ts: events.length ? events[events.length - 1][0] : null,
    drop_count: 0, dedupe_open: false, canonical: true,
  };
}
function dayWithRows(rows) {
  const days = {};
  for (const [li, lc, lo, lr, model] of rows) C.codexAddEvent(days, mk(li, lc, lo, lr, model, null));
  return days[FDAY];
}

let C;
let SYNTH_INFO;
if (SYNTH) {
  SYNTH_INFO = buildSynthetic();
  process.env.TOKEI_CODEX_DIR = SYNTH_INFO.sessions;
  process.env.TOKEI_CODEX_ARCHIVED_DIR = SYNTH_INFO.sessions;
  process.env.TOKEI_CODEX_CONFIG = SYNTH_INFO.config;
}
C = require(path.join(B, "collectors", "codex.js"));
const { initPricing } = require(path.join(B, "core", "price.js"));
const { rangeBounds, RANGE_KEYS } = require(path.join(B, "core", "ranges.js"));
initPricing(path.resolve(__dirname, "..", "..", "resources"));
const bounds = rangeBounds();

function pureHelperTests() {
  console.log("== 纯函数单测 ==");
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 3600;
  const now = Math.floor(Date.now() / 1000);
  const q = (l, consumed) => C.codexQuotaValues(l, now, consumed);
  const both = { primary: { window_minutes: 300, used_percent: 10, resets_at: future }, secondary: { window_minutes: 10080, used_percent: 20, resets_at: future } };
  check("primary=5h / secondary=周", q(both).p5 === 10 && q(both).pw === 20);
  const weekOnly = { primary: { window_minutes: 10080, used_percent: 33, resets_at: future } };
  check("只有 primary=周 时按时长认窗口", q(weekOnly).pw === 33 && q(weekOnly).p5 === null, q(weekOnly));
  const legacy = { primary: {}, secondary: { used_percent: 44, resets_at: future } };
  check("缺 window_minutes 的 secondary 兜底为周", q(legacy).pw === 44);
  const stale = { primary: { window_minutes: 300, used_percent: 55, resets_at: past } };
  check("翻篇且有消耗 → 标失真", q(stale, { p5: 100 }).p5_stale === true && q(stale, { p5: 100 }).p5 === 55);
  check("翻篇且零消耗 → 归零并清 reset", (() => { const v = q(stale, { p5: 0 }); return v.p5 === 0 && v.r5 === null && v.p5_stale === false; })());
  check("consumed 未知也标失真（与 Python 一致：宁可承认过期）", q(stale).p5_stale === true && q(stale).p5 === 55);
  check("ISO 串 resets_at 不炸", (() => { const v = q({ primary: { window_minutes: 300, used_percent: 5, resets_at: "2020-01-01T00:00:00+00:00" } }, { p5: 9 }); return v.p5 === 5 && v.p5_stale === false; })());
  check("空 limits", q(null).p5 === null && q(undefined).pw === null);
  check("nowEpoch=0 只做槽位归类", (() => { const v = C.codexQuotaValues(stale, 0, null); return v.p5 === 55 && v.p5_stale === false; })());

  check("Reserve 模型识别", C.codexIsReserveModel("gpt-reserve") && C.codexIsReserveModel("openai/GPT-Reserve ") && !C.codexIsReserveModel("gpt-5.5"));
  check("Reserve 额度识别(name 或 id)", C.codexIsReserveLimits({ limit_name: "gpt-reserve" }) && C.codexIsReserveLimits({ limit_id: "base_model_inference" }) && !C.codexIsReserveLimits({ limit_id: "codex" }));
  check("价格模型：Reserve→Luna、无价→gpt-5.5", C.codexPriceModel("gpt-reserve") === C.CODEX_RESERVE_PRICE_MODEL
    && C.codexPriceModel("definitely-not-priced") === "openai/gpt-5.5" && C.codexPriceModel("openai/gpt-5.5") === "openai/gpt-5.5");
  const high = C.codexEstimatedCost("openai/gpt-5.5", 300000, 100000, 100000);
  const edge = C.codexEstimatedCost("openai/gpt-5.5", 272000, 100000, 100000);
  // 价目（gpt-5.5）：in 5 / out 30 / cache_read 0.5；加价后输入/缓存 ×2、输出 ×1.5
  check(">272K 加价，阈值本身不加价",
    Math.abs(high - (200000 * 10 + 100000 * 1 + 100000 * 45) / 1e6) < 1e-9
    && Math.abs(edge - (172000 * 5 + 100000 * 0.5 + 100000 * 30) / 1e6) < 1e-9, { high, edge });

  check("eventKey 需要完整累计快照", C.codexEventKey([FISO, FDAY, null, 1, 2, 3, 1, 2, 3, 4, 0, "m", null]) === null
    && C.codexEventKey(mk(1, 2, 3, 4, "gpt-5.5")) === JSON.stringify([1, 2, 3, 4, 1, 2, 3, 4]));
  check("eventsMatch 优先 response_id", C.codexEventsMatch(mk(1, 1, 1, 1, "gpt-5.5", "a"), mk(9, 9, 9, 9, "gpt-5.5", "a")) === true
    && C.codexEventsMatch(mk(1, 1, 1, 1, "gpt-5.5", "a"), mk(1, 1, 1, 1, "gpt-5.5", "b")) === false
    && C.codexEventsMatch(mk(1, 1, 1, 1, "gpt-5.5"), mk(1, 1, 1, 1, "gpt-5.5")) === true);
  check("probe 不被嵌套诱饵骗到", (() => {
    const decoy = '{"timestamp":"t","type":"response_item","payload":{"type":"function_call","arguments":"{\\"note\\":\\"type\\":\\"token_count\\"}"}}';
    const h = C.codexProbeRecordHeader(decoy);
    return h.rootType === "response_item" && h.payloadType === "function_call";
  })());
  check("probe 挑出 payload.model/timestamp", C.codexProbeRecordHeader('{"timestamp":"T","type":"turn_context","payload":{"sandbox":"x","model":"gpt-5.5"}}').model === "gpt-5.5");

  // 前缀去重：子会话整段回放父会话 + 1 条新增
  const parentEvents = [mk(1, 0, 1, 0, "gpt-5.5", "r1"), mk(2, 0, 2, 0, "gpt-5.5", "r2"), mk(3, 0, 3, 0, "gpt-5.5", "r3")];
  const childEvents = parentEvents.map((e) => e.slice()).concat([mk(4, 0, 4, 0, "gpt-5.5", "r4")]);
  const fcx = { "/p.jsonl": entryOf("P", parentEvents), "/c.jsonl": entryOf("C", childEvents, "P") };
  const dropped = C.codexCachedDropCount("/c.jsonl", fcx["/c.jsonl"], fcx);
  check("fork 父前缀整段扣除", dropped[0] === 3 && dropped[1] === false, dropped);
  const only = C.codexDaysFromCachedEvents(fcx["/c.jsonl"], dropped[0], fcx["/c.jsonl"].event_count, null);
  check("扣除后只剩新增", only[FDAY].in === 4 && only[FDAY].out === 4, { in: only[FDAY].in });
  // 缺父元数据：≥2 事件同前缀才认
  const fcx2 = {
    "/a.jsonl": entryOf("A", [mk(1, 0, 1, 0, "gpt-5.5"), mk(2, 0, 2, 0, "gpt-5.5"), mk(3, 0, 3, 0, "gpt-5.5")]),
    "/b.jsonl": entryOf("B", [mk(1, 0, 1, 0, "gpt-5.5"), mk(2, 0, 2, 0, "gpt-5.5"), mk(9, 0, 9, 0, "gpt-5.5")]),
  };
  fcx2["/b.jsonl"].first_keys = fcx2["/a.jsonl"].first_keys;
  fcx2["/a.jsonl"].first_event_ts = "1"; fcx2["/b.jsonl"].first_event_ts = "9";
  check("缺父元数据时保守前缀(≥2)生效", C.codexCachedDropCount("/b.jsonl", fcx2["/b.jsonl"], fcx2)[0] === 2,
    C.codexCachedDropCount("/b.jsonl", fcx2["/b.jsonl"], fcx2));
  // 同秒 ≥5 条无 id 回放
  const burst = [0, 1, 2, 3, 4, 5].map((i) => mk(i + 1, 0, 1, 0, "gpt-5.5")).map((e) => { e[0] = "2023-11-14T10:00:00.000+00:00"; return e; });
  check("同秒 ≥5 条无 id 判为回放", C.codexCachedBurstCount(burst, 0, burst.length) === 6);
  check("同秒但带 id 不算回放", C.codexCachedBurstCount(burst.map((e, i) => e.slice(0, 12).concat("id" + i)), 0, burst.length) === 0);
  // 跨段镜像
  const src = mk(7, 0, 7, 0, "gpt-5.5", "rid-m");
  const dup = mk(7, 0, 7, 0, "gpt-5.5");
  C.codexLinkSegmentMirrors({ "/m1.jsonl": entryOf("M", [src]), "/m2.jsonl": entryOf("M", [dup]) });
  check("跨段镜像补上 response_id", dup[12] === "rid-m", { id: dup[12] });
  const ev2 = mk(5, 0, 5, 0, "gpt-5.5");
  check("reclassify 改判 gpt-reserve", C.codexReclassifyReserveEvent(ev2) === true && ev2[11] === "gpt-reserve");
  check("backfill 只在镜像数字命中时改判",
    C.codexBackfillReserveMirror([mk(5, 0, 5, 0, "gpt-5.5")], [5, 0, 5, 0]) === true
    && C.codexBackfillReserveMirror([mk(6, 0, 6, 0, "gpt-5.5")], [5, 0, 5, 0]) === false);
  // 日级拆分 / 合并
  const mixed = dayWithRows([[1000, 100, 10, 0, "gpt-5.5"], [4000, 400, 40, 0, "gpt-reserve"]]);
  const [main, reserve] = C.codexSplitDay(mixed);
  check("按模型拆主/Reserve 且小时不丢",
    main.in === 1000 && main.cached === 100 && reserve.in === 4000 && main.hours[FHOUR] === 1010 && reserve.hours[FHOUR] === 4040,
    { main: main.in, res: reserve.in, mh: main.hours[FHOUR] });
  const m2 = C.mergeCodexDays(mixed, mixed);
  check("merge 标量/模型/小时全部按位相加",
    m2.in === 2 * mixed.in && m2.cached === 2 * mixed.cached
    && m2.models["gpt-5.5"].in === 2 * (1000 - 100) && m2.models["gpt-reserve"].in === 2 * (4000 - 400)
    && m2.model_hours["gpt-5.5"][FHOUR] === 2 * 1010 && m2.hours[FHOUR] === 2 * 5050,
    { g: m2.models["gpt-5.5"].in, mh: m2.model_hours["gpt-5.5"][FHOUR], h: m2.hours[FHOUR] });
  check("day_has_usage", C.codexDayHasUsage(mixed) === true && C.codexDayHasUsage({ in: 0, models: {} }) === false);
  check("used_since 从重置小时切起", (() => {
    const days = { [FDAY]: { in: 1000, cached: 0, out: 1000, reason: 0, cost: 0, models: {}, hours: new Array(24).fill(100), model_hours: {} } };
    const noon = new Date(FIXED.getFullYear(), FIXED.getMonth(), FIXED.getDate(), 12, 0).getTime() / 1000;
    return C.codexUsedSince(days, noon) === (24 - 12) * 100
      && C.codexUsedSince(days, new Date(FIXED.getFullYear(), FIXED.getMonth(), FIXED.getDate(), 0, 0).getTime() / 1000) === 2400;
  })());
  check("used_since 无小时分布按整天", C.codexUsedSince({ "9999-01-01": { in: 5, out: 5, hours: [] } }, FIXED.getTime() / 1000) === 10);
  check("session_meta 取子代理父 id + page_key 稳定", (() => {
    const dir = path.join(os.tmpdir(), "tokei-codex-meta-" + process.pid);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "rollout-x.jsonl");
    fs.writeFileSync(f, JSON.stringify({ type: "session_meta", timestamp: FISO, payload: { id: "SID", source: { subagent: { thread_spawn: { parent_thread_id: "PPID" } } }, history_base: { b: 1, a: 2 } } }) + "\n");
    const [sid, parent, base] = C.codexSessionMeta(f);
    fs.rmSync(dir, { recursive: true, force: true });
    return sid === "SID" && parent === "PPID" && C.codexPageKey(f, { history_base: base }) === '{"a":2,"b":1}';
  })());
  check("complete_offset 停在整行边界 + guard 稳定", (() => {
    const dir = path.join(os.tmpdir(), "tokei-codex-off-" + process.pid);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "a.jsonl");
    fs.writeFileSync(f, '{"a":1}\n{"b":2}\n{"cut":');
    const off = C.codexCompleteOffset(f, fs.statSync(f).size);
    const g = C.codexOffsetGuard(f, off);
    const b = path.join(dir, "b.jsonl");
    fs.writeFileSync(b, '{"a":1}\n');
    const tailOk = C.codexCompleteOffset(b, fs.statSync(b).size) === fs.statSync(b).size;
    fs.rmSync(dir, { recursive: true, force: true });
    return off === 16 && g.length === 64 && tailOk && C.codexOffsetGuard(f, 0) === "";
  })());
  check("canonical：同会话只留最完整一份", (() => {
    const a = entryOf("K", [mk(1, 0, 1, 0, "gpt-5.5", "k1"), mk(2, 0, 2, 0, "gpt-5.5", "k2")]);
    const b = entryOf("K", [mk(1, 0, 1, 0, "gpt-5.5", "k1")]);
    const canon = C.codexCanonicalFileCache({ "/k1.jsonl": a, "/k2.jsonl": b });
    return Object.keys(canon).length === 1 && canon["/k1.jsonl"] === a;
  })());
  check("custom provider：忽略 section 内同名键", (() => {
    const f = path.join(os.tmpdir(), "tokei-codex-cfg-" + process.pid + ".toml");
    fs.writeFileSync(f, 'model = "gpt-5.5"\n\n[model_providers.custom]\nmodel_provider = "custom"\n');
    const a = C.codexIsCustomProvider(f);
    fs.writeFileSync(f, 'model_provider = "openai"\n[x]\n');
    const b = C.codexIsCustomProvider(f);
    fs.writeFileSync(f, 'model_provider = "proxy"\n');
    const d = C.codexIsCustomProvider(f);
    fs.rmSync(f, { force: true });
    return a === false && b === false && d === true;
  })());
}

function runSynthetic() {
  const cache = {};
  const r1 = C.scanCodex(bounds, cache);
  const fc = cache.codex;
  const by = (sid) => Object.values(fc).find((e) => e.session_id === sid);
  const t = r1.ranges.today;
  const tr = r1.reserve_ranges.today;
  console.log("== 合成日志 ==");
  console.log("  files:", JSON.stringify(Object.fromEntries(Object.entries(fc).map(([f, e]) => [path.basename(f).slice(9, 30), { can: e.canonical ? 1 : 0, ev: e.events.length, drop: e.drop_count, peers: (e.dedupe_peers || []).length }]))));
  console.log("  today:", JSON.stringify({ in: t.in, cached: t.cached, out: t.out, reason: t.reason, cost: +t.cost.toFixed(6), sessions: t.sessions, models: t.models.map((m) => m.model_id) }));
  console.log("  reserve.today:", JSON.stringify({ in: tr.in, cached: tr.cached, out: tr.out, cost: +tr.cost.toFixed(6), models: tr.models.map((m) => m.model_id) }));
  console.log("  quota:", JSON.stringify({ p5: r1.p5, pw: r1.pw, r5: r1.r5, rw: r1.rw, plan: r1.plan, p5_stale: r1.p5_stale, pw_stale: r1.pw_stale, limits_updated: r1.limits_updated, consumed: r1.limits_consumed }));
  console.log("  reserve_quota:", JSON.stringify(r1.reserve_quota));
  console.log("  days:", JSON.stringify(r1.days));

  // 期望（主额度，in 含缓存）：P 1000+1000 | F 新增 1000 | D 5000+6000 | S 100+200+300（重叠的 s2 只算一次）| L 200+300
  const wantMain = 1000 + 1000 + 1000 + 5000 + 6000 + 100 + 200 + 300 + 200 + 300;
  const wantCached = 200 + 200 + 200 + 1000 + 1200 + 10 + 20 + 30 + 20 + 30;
  const mine = Object.entries(fc).filter(([f]) => f.startsWith(SYNTH_INFO.sessions));
  const canonicalBy = (sid) => mine.filter(([, e]) => e.session_id === sid && e.canonical).map(([, e]) => e);
  check("诱饵行/重复快照未计入", t.in + t.cached === wantMain, { got: t.in + t.cached, want: wantMain });
  check("cached 累加口径正确", t.cached === wantCached, { got: t.cached, want: wantCached });
  check("Reserve 事件从主额度剥离", tr.in + tr.cached === 1000, { got: tr.in + tr.cached });
  check("Reserve 模型只在 reserve_ranges", t.models.every((m) => m.model_id !== "gpt-reserve") && tr.models.some((m) => m.model_id === "gpt-reserve"));
  check("fork 前缀整段扣掉(回放 3 条，第 4 条在 fork 内也被规则 D 吞掉)", by("F").drop_count === 3, { drop: by("F").drop_count, ev: by("F").events.length });
  check("双写两条各只计一次", by("D").events.length === 2, { events: by("D").events.length });
  check("同 thread id 两段互为 peers", canonicalBy("S").length === 2 && canonicalBy("S")[0].dedupe_peers.length === 2,
    canonicalBy("S").map((e) => e.dedupe_peers.length));
  check("跨段重复响应只计一次(5 个会话)", r1.ranges.today.sessions === 5, { sessions: r1.ranges.today.sessions });
  check("旧式分页按 history_base 区分，两页都保留", canonicalBy("L").length === 2, canonicalBy("L").map((e) => e.session_id));
  check("主窗口按 window_minutes 归类", r1.p5 === 62.5 && r1.pw === 80, { p5: r1.p5, pw: r1.pw });
  check("周窗口翻篇且有消耗 → 失真", r1.pw_stale === true && r1.rw === SYNTH_INFO.past, { pw_stale: r1.pw_stale });
  check("5h 窗口未翻篇 → 原样", r1.p5_stale === false && r1.r5 === SYNTH_INFO.future);
  check("plan 取 rate_limits.plan_type", r1.plan === "pro");
  check("Reserve 额度独立成读", !!r1.reserve_quota && r1.reserve_quota.used_percent === 40 && r1.reserve_quota.window_minutes === 10080 && r1.reserve_quota.plan === "pro", r1.reserve_quota);
  check("nested 目录被扫到（合成 7 个入口）", mine.length === 7, { files: mine.length, total: Object.keys(fc).length });
  check("sessions/archived 指向同一目录不重复计", new Set(mine.map(([f]) => f)).size === 7);

  // 增量：只往父会话追加一条响应
  const p = path.join(SYNTH_INFO.sessions, "rollout-2026-09-25T10-00-00-P.jsonl");
  const before = Object.entries(fc).map(([f, e]) => path.basename(f) + e.sig).sort().join("|");
  // 时间戳必须比现有读数（L2 在 dayStart+6.5h）更新，否则"取最新一条"会保留旧读数
  fs.appendFileSync(p, JSON.stringify({
    timestamp: isoLocal(new Date(SYNTH_INFO.dayStart.getTime() + 7 * 3600e3)), type: "event_msg",
    payload: {
      type: "token_count", response_id: "resp-5",
      rate_limits: {
        limit_id: "codex", plan_type: "pro",
        primary: { window_minutes: 300, used_percent: 75, resets_at: SYNTH_INFO.future },
        secondary: { window_minutes: 10080, used_percent: 80, resets_at: SYNTH_INFO.past },
      },
      info: { total_token_usage: { input_tokens: 4000, cached_input_tokens: 800, output_tokens: 400, reasoning_output_tokens: 120 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 30 } },
    },
  }) + "\n");
  const r2 = C.scanCodex(bounds, cache);
  const after = Object.entries(cache.codex).map(([f, e]) => path.basename(f) + e.sig).sort().join("|");
  const changed = after.split("|").filter((x, i) => x !== before.split("|")[i]).length;
  console.log("  增量后 today:", JSON.stringify({ in: r2.ranges.today.in, cached: r2.ranges.today.cached, cost: +r2.ranges.today.cost.toFixed(6), p5: r2.p5 }));
  check("增量只改动被追加入口", changed === 1, { changed });
  check("增量接上新事件(+1000 含缓存)", r2.ranges.today.in + r2.ranges.today.cached === r1.ranges.today.in + r1.ranges.today.cached + 1000,
    { delta: r2.ranges.today.in + r2.ranges.today.cached - (r1.ranges.today.in + r1.ranges.today.cached) });
  check("额度读数取最新一条", r2.p5 === 75, { p5: r2.p5 });
  const r3 = C.scanCodex(bounds, cache);
  check("无改动再扫数值不变", JSON.stringify(r2.ranges) === JSON.stringify(r3.ranges) && JSON.stringify(r2.reserve_ranges) === JSON.stringify(r3.reserve_ranges));
  pureHelperTests();
}

function runReal() {
  const t0 = Date.now();
  C.scanCodex(bounds, {});
  const coldMs0 = Date.now() - t0;
  const cache = {};
  const ta = Date.now();
  const cold = C.scanCodex(bounds, cache);
  const coldMs = Date.now() - ta;
  const fc = cache.codex || {};
  let events = 0;
  let canonical = 0;
  for (const e of Object.values(fc)) { events += (e.events || []).length; if (e.canonical) canonical++; }
  const tb = Date.now();
  const warm = C.scanCodex(bounds, cache);
  const warmMs = Date.now() - tb;
  if (global.gc) global.gc();
  console.log("== 真实日志 ==");
  console.log(`  files=${Object.keys(fc).length} canonical=${canonical} cached_events=${events} `
    + `cold_ms=${coldMs0}/${coldMs} warm_ms=${warmMs} x=${(coldMs / Math.max(warmMs, 1)).toFixed(1)} `
    + `heap_after_cold_mb=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}`);
  const key = (r) => JSON.stringify(RANGE_KEYS.map((k) => [k, r.ranges[k].in, r.ranges[k].cached, r.ranges[k].out, r.ranges[k].reason, +r.ranges[k].cost.toFixed(9), r.ranges[k].hit, r.ranges[k].sessions, r.ranges[k].models]));
  const rkey = (r) => JSON.stringify(RANGE_KEYS.map((k) => [k, r.reserve_ranges[k].in, r.reserve_ranges[k].cached, r.reserve_ranges[k].cost]));
  check("冷扫/增量数值一致", key(cold) === key(warm) && rkey(cold) === rkey(warm));
  check("增量显著快于冷扫", warmMs * 5 < coldMs, { warmMs, coldMs });
  for (const k of RANGE_KEYS) {
    const b = warm.ranges[k];
    console.log(`  ${k}: in=${b.in} cached=${b.cached} out=${b.out} reason=${b.reason} cost=${b.cost.toFixed(6)} hit=${b.hit.toFixed(2)} sessions=${b.sessions} models=${b.models.length}`);
  }
  for (const k of RANGE_KEYS) {
    const b = warm.reserve_ranges[k];
    if (b.in || b.cached || b.out) console.log(`  reserve.${k}: in=${b.in} cached=${b.cached} out=${b.out} reason=${b.reason} cost=${b.cost.toFixed(6)}`);
  }
  console.log(`  quota: p5=${warm.p5} pw=${warm.pw} r5=${warm.r5} rw=${warm.rw} plan=${warm.plan} p5_stale=${warm.p5_stale} pw_stale=${warm.pw_stale} limits_updated=${warm.limits_updated} reserve_quota=${JSON.stringify(warm.reserve_quota)}`);
  console.log(`  limits 原文: ${JSON.stringify(warm.limits)}`);
  for (const m of warm.ranges.all.models.slice(0, 3)) console.log("  model:", JSON.stringify(m));
  let bad = 0;
  for (const k of RANGE_KEYS) {
    const b = warm.ranges[k];
    const sum = b.models.reduce((a, m) => a + m.cost, 0);
    if (Math.abs(sum - b.cost) > Math.max(1e-9, Math.abs(b.cost) * 1e-12)) bad++;
    if (b.in !== b.models.reduce((a, m) => a + m.in, 0) || b.cached !== b.models.reduce((a, m) => a + m.cr, 0)) bad++;
  }
  check("模型行令牌/成本与区间合计对得上", bad === 0);
  let rawBad = 0;
  for (const d of Object.values(warm.days)) if (d.cached > d.in) rawBad++;
  check("原始累加每日 cached<=in", rawBad === 0, { days: Object.keys(warm.days).length });
  let evIn = 0, evOut = 0, evCached = 0;
  for (const e of Object.values(fc)) {
    if (!e.canonical) continue;
    for (const ev of e.events.slice(e.drop_count)) { evIn += ev[6]; evCached += ev[7]; evOut += ev[8]; }
  }
  check("事件级累加 == 区间装配（真实数据无跨段重复）",
    evIn === warm.ranges.all.in + warm.ranges.all.cached && evCached === warm.ranges.all.cached && evOut === warm.ranges.all.out,
    { evIn, range: warm.ranges.all.in + warm.ranges.all.cached, evOut });
  const snaps = [0, 1, 2].map(() => key(C.scanCodex(bounds, {})));
  check("三次独立冷扫逐字节一致", snaps[0] === snaps[1] && snaps[1] === snaps[2]);
  console.log(`  本机 config 判定为第三方中转: custom=${C.codexIsCustomProvider()}`);
  pureHelperTests();
}

if (SYNTH) runSynthetic(); else runReal();
