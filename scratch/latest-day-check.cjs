/**
 * 临时自检：本机 claude/codex 原始记录里最近的日期是哪天 ——
 * 用来判断 today/week 归零是「数据本来就旧」还是「区间分类算错」。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { rangeBounds, parseTs, classifyDate } = require("../dist/core/ranges");

const b = rangeBounds(new Date());
console.log("区间边界:", JSON.stringify(b));

function newest(dir, depth) {
  const out = [];
  const walk = (d, level) => {
    if (level > depth) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, level + 1);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
}

function tsFrom(file) {
  const raw = fs.readFileSync(file, "utf8").split("\n");
  const tail = raw.slice(-400);
  const seen = [];
  for (const line of tail) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const t = parseTs(obj.timestamp);
    if (t) seen.push(t);
  }
  return seen;
}

for (const [label, dir] of [["claude", path.join(os.homedir(), ".claude", "projects")],
                             ["codex", path.join(os.homedir(), ".codex", "sessions")]]) {
  console.log(`\n== ${label} ${dir} 存在=${fs.existsSync(dir)} ==`);
  if (!fs.existsSync(dir)) continue;
  const files = newest(dir, 3).slice(0, 6);
  let max = null; const hits = {};
  for (const f of files) {
    const seen = tsFrom(f);
    const last = seen[seen.length - 1];
    console.log(`  ${path.basename(f)} 末条=${last?.day ?? "-"} 命中区间=${last ? classifyDate(last.date, b).join("/") : "-"}`);
    for (const t of seen) {
      hits[t.day] = (hits[t.day] ?? 0) + 1;
      if (!max || t.day > max.day) max = t;
    }
  }
  console.log("  最晚一条:", JSON.stringify(max && { day: max.day, hour: max.hour }));
  console.log("  按天计数(近8天):", JSON.stringify(Object.entries(hits).sort().slice(-8)));
}
