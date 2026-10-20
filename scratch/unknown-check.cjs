/**
 * 查漏补缺（--update-unknown）的离线取证。
 *
 * HOME 钉在临时目录（写的是 <临时>/\.tokei\pricing_overrides.json，绝不碰真的 ~/.tokei），
 * 日志目录只读地指向本机真实 transcript；每一步都挂着 no-net-guard.cjs，
 * 所以「这条路不联网」是进程实测出来的，不是我嘴上说的。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

require("./no-net-guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const GUARD = path.join(__dirname, "no-net-guard.cjs");
const REAL_HOME = os.homedir(); // 必须在钉 HOME 之前取，E 段靠它核对真实 ~/.tokei 有没有被写过
const REAL_CLAUDE = path.join(REAL_HOME, ".claude", "projects");
const REAL_WORKBUDDY = path.join(REAL_HOME, ".workbuddy", "projects");
const line = (label, value) => console.log(`${label}${value}`);

function freshHome(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tokei-${tag}-`));
  return {
    home,
    tokei: path.join(home, ".tokei"),
    overrides: path.join(home, ".tokei", "pricing_overrides.json"),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      TOKEI_RESOURCE_DIR: `${ROOT.replace(/\\/g, "/")}/resources`,
      NODE_OPTIONS: `--require ${GUARD}`,
    },
  };
}

function runCli(env, arg) {
  const r = spawnSync(process.execPath, ["dist/cli.js", arg], { cwd: ROOT, encoding: "utf8", env, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`cli ${arg} 退出码 ${r.status}：${r.stderr}`);
  return r.stdout.trim();
}

// ---------- A. 真日志里到底有哪些名字、哪些没有精确价 ----------
const a = freshHome("unknown-real");
a.env.TOKEI_CLAUDE_DIR = REAL_CLAUDE;
a.env.TOKEI_WORKBUDDY_DIR = REAL_WORKBUDDY;
Object.assign(process.env, a.env);
const price = require(path.join(ROOT, "dist", "core", "price.js"));
const local = require(path.join(ROOT, "dist", "core", "localModels.js"));
price.initPricing(ROOT + "/resources");
const seen = [...local.collectLocalModels()].sort();
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "pricing.json"), "utf8")).models;
line("A1 价目表条目：", `${Object.keys(catalog).length} 条（in 与 out 都非零 ${Object.values(catalog).filter((p) => p && p.in && p.out).length} 条）`);
line("A2 本机扫到的模型名：", `${seen.length} 个 → ${seen.join(" | ")}`);
const unknownNames = seen.filter((m) => !price.isExactMatch(m));
line("A3 非精确匹配：", `${unknownNames.length} 个 → ${unknownNames.join(" | ") || "（无）"}`);
line("A4 其中能借到同族价的：", unknownNames.filter((m) => price.estimateFromSibling(m)).map((m) => `${m}←${price.estimateFromSibling(m).source}`).join(" | ") || "（无）");

// ---------- B. 真数据跑第一趟：写盘内容与 stdout 那行 JSON ----------
const out1 = runCli(a.env, "--update-unknown");
line("B1 第一趟 stdout：", out1);
const parsed1 = JSON.parse(out1);
const raw1 = fs.readFileSync(a.overrides, "utf8");
const ovr1 = JSON.parse(raw1);
line("B2 写入后 overrides：", `models ${Object.keys(ovr1.models || {}).length} 条 / aliases ${Object.keys(ovr1.aliases || {}).length} 条`);
line("B3 文件排版头 3 行：", `\n${raw1.split("\n").slice(0, 3).join("\n")}`);
line("B4 pricing.json 副本：", `${fs.existsSync(path.join(a.tokei, "pricing.json")) ? "已落地（writablePath 复制）" : "没有"}`);

// ---------- C. 第二趟：新进程重读价目表，应当一个都不剩 ----------
fs.writeFileSync(path.join(a.home, "keep1"), raw1, "utf8");
const out2 = runCli(a.env, "--update-unknown");
line("C1 第二趟 stdout：", out2);
line("C2 文件是否一字未动：", fs.readFileSync(a.overrides, "utf8") === fs.readFileSync(path.join(a.home, "keep1"), "utf8") ? "是" : "否");

// ---------- D. 生名字夹具：把「借到价 / 借不到价」两条分支都跑出来 ----------
const d = freshHome("unknown-fixture");
const fixture = path.join(d.home, "claude-fix");
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, "s.jsonl"), [
  JSON.stringify({ message: { model: "qwen4-max-preview" } }),
  JSON.stringify({ message: { model: "claude-fable-9" } }),
  JSON.stringify({ message: { model: "glm-9.9-flash" } }),
  JSON.stringify({ message: { model: "<synthetic>" } }),
].join("\n") + "\n", "utf8");
const dEnv = { ...d.env, TOKEI_CLAUDE_DIR: fixture.replace(/\\/g, "/"), TOKEI_WORKBUDDY_DIR: "", TOKEI_WORKBUDDY_AI_DIR: "", TOKEI_CODEBUDDY_DIR: "", TOKEI_GEMINI_DIR: "", TOKEI_PI_DIR: "" };
const outD = runCli(dEnv, "--update-unknown");
line("D1 夹具第一趟 stdout：", outD);
const ovrD = JSON.parse(fs.readFileSync(d.overrides, "utf8"));
line("D2 写进去的 models：", JSON.stringify(ovrD.models));
line("D3 写进去的 aliases：", JSON.stringify(ovrD.aliases));
line("D4 第二趟：", runCli(dEnv, "--update-unknown"));

// ---------- E. 本机真目录没被写过 ----------
const realTokei = path.join(REAL_HOME, ".tokei", "pricing_overrides.json");
try {
  const st = fs.statSync(realTokei);
  const same = fs.readFileSync(realTokei, "utf8") === fs.readFileSync(path.join(ROOT, "resources", "pricing_overrides.json"), "utf8");
  line("E1 真实 ~/.tokei/pricing_overrides.json：", `${REAL_HOME} 下这份 birth=${st.birthtime.toISOString()} mtime=${st.mtime.toISOString()} size=${st.size}B 与资源内置那份逐字节相同=${same}（本次脚本 HOME 全程指临时目录，没写它）`);
} catch {
  line("E1 真实 ~/.tokei/pricing_overrides.json：", "不存在");
}
fs.rmSync(a.home, { recursive: true, force: true });
fs.rmSync(d.home, { recursive: true, force: true });
