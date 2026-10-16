/** 无 UI 的命令行入口：用于验证采集结果（`node dist/cli.js --json`、`--projects`、`--quota-detail`）。 */
import { compute } from "./core/compute";
import { projectTrail } from "./core/trail";
import { initPricing, pricingMeta } from "./core/price";
import { buildQuotaDetail } from "./core/quotaDetail";
import * as path from "path";

// 产物是 dist/cli.js，所以 resources 就在上一级；写成两级会退到仓库外面，静默改用回退价表。
const resourceDir = process.env.TOKEI_RESOURCE_DIR || path.resolve(__dirname, "..", "resources");
initPricing(resourceDir);

// 缓存必须由 compute() 焐热：项目足迹是从扫描缓存里聚合出来的，不自己读日志
const cache: Record<string, any> = {};
const { payload, errors } = compute(cache);
if (process.argv.includes("--errors")) {
  for (const [tool, message] of Object.entries(errors)) console.error(`[error] ${tool}: ${message}`);
}
if (process.argv.includes("--projects")) {
  // 对应 usage.30s.py 的 projects()：紧凑 JSON，按 last_active 倒序
  console.log(JSON.stringify(projectTrail(cache)));
} else {
  // 对应 main_json()（usage.30s.py:13795-13801）：--json 的输出额外挂一份价表水位，
  // 设置页的诊断段就靠这行报「pricing: 条数 更新时间」。
  payload._pricing = pricingMeta(resourceDir);
  console.log(JSON.stringify(payload, null, process.argv.includes("--compact") ? 0 : 2));
}
