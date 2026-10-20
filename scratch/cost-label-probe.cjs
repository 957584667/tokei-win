/**
 * 成本文案取证：renderer/app.js 是浏览器脚本，没有导出，这里按大括号配对把纯函数原样抠出来跑，
 * 免得为了三条字符串在测试里另抄一份实现（抄的那份就不是被测代码了）。
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.resolve(__dirname, "../renderer/app.js"), "utf8");

function grab(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error("找不到 " + name);
  let depth = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(at, i + 1);
}

const code = ["nativeMoney", "unpricedModels", "estimatedCostLabel"].map(grab).join("\n");
const fns = new Function(`${code}; return { nativeMoney, unpricedModels, estimatedCostLabel };`)();
const m = fns.nativeMoney, label = fns.estimatedCostLabel, unpriced = fns.unpricedModels;

const cases = [
  ["1 分以下写 <$0.01", m(0.0032), "<$0.01"],
  ["正好 1 分照常两位", m(0.005), "$0.01"],
  ["零成本还是 $0.00（Swift 只在 >0 时降级）", m(0), "$0.00"],
  ["美元人民币并列，各自判子分", m(0.0021, 0.004), "<$0.01 + <¥0.01"],
  ["只有人民币", m(0, 12.5), "¥12.50"],
  ["负数不降级", m(-0.002), "$-0.00"],
];
let fail = 0;
for (const [name, got, want] of cases) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} → ${JSON.stringify(got)}${ok ? "" : " 期望 " + JSON.stringify(want)}`);
}

const model = (over) => Object.assign({ name: "x", in: 100, out: 10, cr: 0, cw: 0, reason: 0, cost: 0, cost_cny: 0, credits: 0 }, over);
const range = (over) => Object.assign({ cost: 0, cost_cny: 0, models: [] }, over);
const labelCases = [
  ["用到的模型全无公开价 → —", label(range({ models: [model({ name: "Auto Yyjz" }), model({ name: "第二个" })] })), "—"],
  ["有一个带价就照常印金额", label(range({ cost: 1.2345, models: [model({ cost: 1.2345 }), model()] })), "$1.23"],
  ["没有模型明细时不算「全无公开价」", label(range({})), "$0.00"],
  ["人民币也算有价，且美元为 0 时不并列（Swift 只在 usd>0 或没有人民币时印美元）", label(range({ cost_cny: 8.5, models: [model({ cost_cny: 8.5 })] })), "¥8.50"],
  ["Credits 抵扣的模型不算未定价", label(range({ models: [model({ credits: 12 })] })), "$0.00"],
  ["只有 0 token 的模型不进 used", label(range({ models: [model({ in: 0, out: 0, reason: 0 })] })), "$0.00"],
  ["成本不足 1 分且模型有价 → 走 <$0.01", label(range({ cost: 0.004, models: [model({ cost: 0.004 })] })), "<$0.01"],
];
for (const [name, got, want] of labelCases) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} → ${JSON.stringify(got)}${ok ? "" : " 期望 " + JSON.stringify(want)}`);
}
const picked = unpriced([model({ name: "有价", cost: 2 }), model({ name: "无价" }), model({ name: "零token", in: 0, out: 0 })]);
console.log(`${picked.length === 1 && picked[0].name === "无价" ? "ok  " : "FAIL"} unpricedModels 只留有 token 又没价的 → ${picked.map((x) => x.name).join(",")}`);
if (picked.length !== 1) fail++;
console.log(fail ? `!! ${fail} 条不符` : "全部符合");
process.exit(fail ? 1 : 0);
