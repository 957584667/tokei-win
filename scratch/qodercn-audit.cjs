/**
 * Qoder CN 用量对账：绕开采集器，直接从 ~/.qoder-cn/projects 的原始 transcript 里
 * 按 request_id 去重累加 usage 字段，和 tokei 统计出的 ranges 对照，看差在哪一层。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = process.argv[2] || path.join(os.homedir(), ".qoder-cn", "projects");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".jsonl")) files.push(p);
  }
})(ROOT);

const seen = new Map();          // request_id -> 该请求的 token/credits
let noReqId = 0, lines = 0, parseFail = 0;
const tokenShape = new Map();    // 出现过的 usage 键组合
let nonzeroTokenEvents = 0;

for (const f of files) {
  const buf = fs.readFileSync(f, "utf8");
  for (const raw of buf.split("\n")) {
    if (!raw.trim()) continue;
    lines++;
    let o;
    try { o = JSON.parse(raw); } catch { parseFail++; continue; }
    const u = o?.message?.usage;
    if (!u || typeof u !== "object") continue;
    const key = Object.keys(u).sort().join(",");
    tokenShape.set(key, (tokenShape.get(key) || 0) + 1);
    const inp = Number(u.input_tokens) || 0;
    const out = Number(u.output_tokens) || 0;
    const cr = Number(u.cache_read_input_tokens) || 0;
    const cw = Number(u.cache_creation_input_tokens) || 0;
    const credits = Number(u.credits) || 0;
    if (inp + out + cr + cw > 0) nonzeroTokenEvents++;
    const id = o.request_id ?? u.request_id ?? o.message?.id ?? null;
    if (id === null || id === "") { noReqId++; continue; }
    if (!seen.has(id)) seen.set(id, { inp, out, cr, cw, credits, day: raw.slice(0, 0) });
  }
}

let sum = { inp: 0, out: 0, cr: 0, cw: 0, credits: 0 };
for (const v of seen.values()) {
  sum.inp += v.inp; sum.out += v.out; sum.cr += v.cr; sum.cw += v.cw; sum.credits += v.credits;
}
console.log(`目录 ${ROOT}`);
console.log(`文件 ${files.length} 行 ${lines} 解析失败 ${parseFail} 带 usage 的独立请求 ${seen.size} 无 request_id ${noReqId}`);
console.log(`token 非零的事件 ${nonzeroTokenEvents} 个`);
console.log(`去重后合计 in=${sum.inp} out=${sum.out} cr=${sum.cr} cw=${sum.cw} credits=${sum.credits.toFixed(2)}`);
console.log("usage 键组合：");
for (const [k, n] of [...tokenShape].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${String(n).padStart(6)}  ${k}`);
