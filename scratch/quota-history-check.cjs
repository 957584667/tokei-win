/**
 * 临时自检：把本机真实扫描结果喂给额度历史，确认「payload → 捕获 → 快照 → 曲线帧」
 * 这条链路在自己机器上跑得通、数字合理。写的是临时文件，不碰 ~/.tokei。
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { compute } = require("../dist/core/compute");
const { initPricing } = require("../dist/core/price");
const { QuotaHistoryStore, captureFromPayload } = require("../dist/main/quotaHistory");
const { QUOTA_HISTORY_TOOL_ORDER, QuotaHistoryProjection, buildQuotaHistoryFrame, normalizeQuotaSpan } =
  require("../dist/core/quotaProjection");

initPricing(path.resolve(__dirname, "..", "resources"));
const cache = {};
const { payload, errors } = compute(cache);
console.log("采集异常:", Object.keys(errors));

const capture = captureFromPayload(payload);
console.log("捕获读数:", JSON.stringify(capture, null, 1));

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokei-qh-")), "quota_history.json");
const store = new QuotaHistoryStore(file);
store.record(capture);
store.record(capture);
console.log("两次同分钟刷新后的快照:", JSON.stringify(store.points, null, 1));

for (const tool of QUOTA_HISTORY_TOOL_ORDER) {
  const p = new QuotaHistoryProjection(store.points, tool);
  console.log(tool.id, "线点", p.lineData.length, "标记", p.markerData.length,
    "掉量", p.dropEvents.length, "hover", p.hoverSamples.length,
    "最新", JSON.stringify(p.latestValues),
    "按天", QuotaHistoryProjection.dailyConsumption(store.points, tool).length);
}

/**
 * 复刻主进程 get-quota-history 那一条（去掉 Electron 依赖），确认 IPC 边界上：
 * 帧结构是渲染进程读的那些键、能过 JSON、跨度非法时退回默认档。
 */
for (const raw of [24, "1", 168, 999, undefined]) {
  const span = normalizeQuotaSpan(raw);
  const end = Math.floor(Date.now() / 1000);
  const ranged = store.pointsSince(new Date((end - span * 3600) * 1000));
  const frame = buildQuotaHistoryFrame(ranged, store.points, span, end);
  const round = JSON.parse(JSON.stringify(frame));
  const keys = ["span", "start", "end", "sampleCount", "tools"];
  const toolKeys = ["id", "title", "windowNames", "chart", "daily"];
  const chartKeys = ["windowNames", "lineData", "markerData", "latestValues", "latestDatumIDs",
    "dropEvents", "activityEvents", "hoverSamples"];
  const missing = [
    ...keys.filter((k) => round[k] === undefined),
    ...round.tools.flatMap((t) => [
      ...toolKeys.filter((k) => t[k] === undefined),
      ...chartKeys.filter((k) => t.chart[k] === undefined),
    ]),
  ];
  console.log(`跨度 ${JSON.stringify(raw)} → ${span}h 点=${round.sampleCount}`
    + ` 序列化=${JSON.stringify(round).length}B 缺键=${missing.length ? missing.join(",") : "无"}`
    + ` 工具=${round.tools.map((t) => `${t.id}:${t.chart.lineData.length}线/${t.chart.dropEvents.length}掉/${t.daily.length}天`).join(" ")}`);
}
