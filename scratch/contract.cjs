// Swift Usage 解码器的必填键校验：任何缺键都会让 macOS 端 decode 抛错、面板空白
const { spawnSync } = require("child_process");
const r = spawnSync(process.execPath, ["dist/cli.js"], { encoding: "utf8", maxBuffer: 1 << 28 });
const p = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
const SIX = ["today", "yesterday", "week", "last_week", "month", "year"];
const problems = [];
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

function checkRange(where, rng, required) {
  for (const k of required) if (!has(rng, k)) problems.push(`${where}.${k} 缺失`);
}
const tokenKeys = ["in", "out", "cr", "cw"];
const models = (where, list, required) => {
  if (!Array.isArray(list)) { if (list !== undefined) problems.push(`${where} 不是数组`); return; }
  list.forEach((m, i) => {
    for (const k of required) if (!has(m, k)) problems.push(`${where}[${i}].${k} 缺失`);
    if (has(m, "name") && typeof m.name !== "string") problems.push(`${where}[${i}].name 不是字符串`);
  });
};

// 六个严格解码的顶层工具：缺一个 macOS 就整包解码失败
for (const t of ["claude", "codex", "gemini", "grok", "hermes", "openclaw", "opencode"]) {
  if (!has(p, t)) { problems.push(`顶层 ${t} 缺失`); continue; }
  if (p[t] === null) { problems.push(`顶层 ${t} 为 null`); continue; }
}
if (!has(p, "qwenwork")) problems.push("顶层 qwenwork 缺失");

const rangesOf = t => (p[t] && p[t].ranges) || null;
for (const [tool, rngKeys] of [
  ["claude", ["hit", "in", "out", "cr", "cw", "cost"]],
  ["codex", []], ["gemini", ["hit", "in", "out", "cached", "thoughts", "cost"]],
  ["grok", []], ["hermes", ["hit", "in", "out", "cr", "cw", "reason", "cost"]],
  ["openclaw", ["tasks", "completed", "failed"]], ["opencode", []],
  ["zcode", []], ["mimocode", []], ["pi", []], ["prime_agent", []], ["workbuddy", []],
  ["workbuddy_ai", []], ["codebuddy", []], ["deepseek_harness", []], ["qwencode", []],
  ["kimicode", []], ["musecode", []], ["cmdcode", []], ["devin", []], ["minimax", []],
  ["grok_bot", []], ["qoder", ["in", "out"]], ["qoderwork", []], ["qodercli", []], ["qodercli_cn", []],
]) {
  const rn = rangesOf(tool);
  if (!rn) { problems.push(`${tool}.ranges 缺失`); continue; }
  for (const k of SIX) if (!has(rn, k)) problems.push(`${tool}.ranges.${k} 缺失`);
  for (const [k, v] of Object.entries(rn)) {
    checkRange(`${tool}.ranges.${k}`, v, rngKeys);
    models(`${tool}.ranges.${k}.models`, v && v.models, ["name", ...tokenKeys]);
  }
  if (tool === "claude") {
    for (const k of ["session_name", "session_total"]) if (!has(p.claude, k)) problems.push(`claude.${k} 缺失`);
    for (const k of ["in", "out", "cr", "cw", "cost", "pin", "pout"]) {
      const m = (((rn.month || {}).models) || [])[0];
      if (m && !has(m, k)) { problems.push(`claude month models[].${k} 缺失`); break; }
    }
  }
  if (tool === "gemini") {
    const m = (((rn.month || {}).models) || [])[0];
    for (const k of ["in", "out", "cached", "thoughts", "cost", "pin", "pout"]) {
      if (m && !has(m, k)) { problems.push(`gemini month models[].${k} 缺失`); break; }
    }
  }
}
console.log(`顶层键 ${Object.keys(p).length} 个：${Object.keys(p).join(", ")}`);
console.log(problems.length ? `发现问题 ${problems.length}:\n` + problems.join("\n") : "Swift 必填键全部齐备");
