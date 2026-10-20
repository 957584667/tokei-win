/** 无 UI 的命令行入口：用于验证采集结果（`node dist/cli.js --json`、`--projects`、`--quota-detail`）。 */
import { compute } from "./core/compute";
import { attachPorts, projectTrail } from "./core/trail";
import { initPricing, pricingMeta } from "./core/price";
import { buildQuotaDetail } from "./core/quotaDetail";
import { runPriceUpdate, runUnknownUpdate } from "./main/pricingFetch";
import { detectLocalServers } from "./main/localPorts";
import * as path from "path";

// 产物是 dist/cli.js，所以 resources 就在上一级；写成两级会退到仓库外面，静默改用回退价表。
const resourceDir = process.env.TOKEI_RESOURCE_DIR || path.resolve(__dirname, "..", "resources");
initPricing(resourceDir);

// 对应 usage.30s.py:17750 那条 argv 短路：抓价这趟不扫描、不出 payload，只把摘要打到
// stdout（失败走 stderr）再以返回码退出，主进程和人都能用同一个入口。
if (process.argv.includes("--update-prices")) {
  void runPriceUpdate(resourceDir).then((result) => {
    (result.code === 0 ? console.log : console.error)(result.message);
    process.exit(result.code);
  });
} else if (process.argv.includes("--update-unknown")) {
  // 对应 17752：这一条打的是 update_unknown() 那行 JSON，Swift 侧靠它取 count
  const result = runUnknownUpdate(resourceDir);
  if (result.code === 0) console.log(result.stdout);
  else console.error(result.message);
  process.exit(result.code);
} else {
  void runScan();
}

async function runScan(): Promise<void> {
  // 缓存必须由 compute() 焐热：项目足迹是从扫描缓存里聚合出来的，不自己读日志
  const cache: Record<string, any> = {};
  const { payload, errors } = compute(cache);
  if (process.argv.includes("--errors")) {
    for (const [tool, message] of Object.entries(errors)) console.error(`[error] ${tool}: ${message}`);
  }
  if (process.argv.includes("--projects")) {
    // 对应 usage.30s.py 的 projects()：紧凑 JSON，按 last_active 倒序；端口探测也在这一趟里做
    const list = projectTrail(cache);
    attachPorts(list, await detectLocalServers(list.map((item) => item.path)));
    console.log(JSON.stringify(list));
  } else {
    // 对应 main_json()（usage.30s.py:13795-13801）：--json 的输出额外挂一份价表水位，
    // 设置页的诊断段就靠这行报「pricing: 条数 更新时间」。
    payload._pricing = pricingMeta(resourceDir);
    console.log(JSON.stringify(payload, null, process.argv.includes("--compact") ? 0 : 2));
  }
}
