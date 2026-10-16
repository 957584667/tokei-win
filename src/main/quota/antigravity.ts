/**
 * Antigravity 额度：对应 usage.30s.py 的 7233-7517（含 7238 的扫描 miss TTL）。
 *
 * 这一路不读凭据、不碰 keychain：Antigravity 的 language server 在本机开着
 * Connect-RPC 端口（IDE 侧是自签证书的 https，扩展侧是明文 http），原版用
 * ps + lsof 找到进程与端口，再从命令行里抠出 --csrf_token 直接 POST
 * 127.0.0.1。Windows 化：ps 换成 PowerShell 的 Get-CimInstance Win32_Process
 * （tasklist 拿不到命令行，没有 --csrf_token 就没法认证），lsof 换成
 * netstat -ano。两条命令都收进可注入的 runCommand 接缝，单测喂假输出即可，
 * 不真起任何进程。
 *
 * 原版没装 Antigravity 时每 30 秒一个 tick 都要白付一次全表进程扫描，所以
 * 扫空后 90 秒内直接判"没跑"（~/.tokei/antigravity_scan_cache.json）；这条
 * 照搬，缓存路径留在自己的 deps 上，测试指到临时目录。
 * allowInsecureLoopbackTls 在这里是必须的：IDE 的本地端口是 https 自签证书，
 * 严格校验等于永远连不上——Python 原版就带着 allow_insecure_loopback_tls=True。
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TOKEI_DIR, loadJson, saveJson } from "../../core/paths";
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, cachedProviderQuota, epochSeconds,
  providerCredentialMarker, providerInteger, providerNumber, providerQuotaEnabled,
  providerWindow, saveProviderQuotaCache,
} from "../../core/providerQuota";
import { QuotaDeps } from "./context";

/** 对应 _ANTIGRAVITY_SCAN_MISS_TTL */
const ANTIGRAVITY_SCAN_MISS_TTL = 90;

export type RunCommand = (command: string) => string | null;

export interface AntigravityDeps extends QuotaDeps {
  /** 进程表/netstat 的执行接缝；null 表示命令本身失败（对齐 Python 的 OSError 分支） */
  runCommand?: RunCommand;
  /** 扫描 miss 缓存文件；默认真实的 ~/.tokei/antigravity_scan_cache.json */
  scanCacheFile?: string;
}

export interface AntigravityProcessInfo {
  pid: number;
  kind: "ide" | "cli";
  csrf_token: string;
  extension_port: number | null;
  extension_csrf_token: string | null;
}

/** 对应 Python 的 (scheme, port, csrf, requires_csrf) 四元组，按序解构 */
export type AntigravityEndpoint = ["http" | "https", number, string, boolean];

/**
 * Windows 上等价于 `ps -ax -o pid=,command=` 的整行格式「PID 命令行」：
 * 保持与原版同一个行正则，_antigravity_process_infos 的逻辑就一字不改。
 * tasklist 没有 CommandLine 列，所以只能走 CIM。
 */
export const ANTIGRAVITY_PROCESS_LIST_COMMAND =
  'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
  + ' Get-CimInstance Win32_Process | ForEach-Object { \\"$($_.ProcessId) $($_.CommandLine)\\" }"';

/** 对应 /usr/sbin/lsof -nP -iTCP -sTCP:LISTEN：Windows 用 netstat -ano 全表再按 PID 过滤 */
export const ANTIGRAVITY_NETSTAT_COMMAND = "netstat -ano";

/** 默认实现：2 秒超时对齐 Python 的 timeout=2；返回 null 表示命令失败或被杀 */
function defaultRunCommand(command: string): string | null {
  try {
    return execSync(command, {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      // CIM 全表带完整命令行很容易超过 execSync 默认 1MiB，超限直接 ENOBUFS
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function run(deps: AntigravityDeps, command: string): string | null {
  return (deps.runCommand ?? defaultRunCommand)(command);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 对应 Python 的 re.escape(flag) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 对应 _antigravity_extract_flag：`--flag 值` 与 `--flag=值` 两种写法都收 */
export function antigravityExtractFlag(command: string, flag: string): string | null {
  const match = new RegExp(`${escapeRegExp(flag)}(?:=|\\s+)(\\S+)`, "i").exec(command);
  return match ? match[1] : null;
}

/**
 * 对应 _antigravity_process_kind。macOS 的三个 .app 候选原样保留，追加 Windows
 * 安装目录里的 exe 名；CLI 分支多允许一个 `.exe` 尾缀（agy.exe\ 或行尾），
 * 因为 Windows 上二进制一定带扩展名，原正则会把 `agy.exe` 判成不匹配。
 */
export function antigravityProcessKind(command: string): "ide" | "cli" | null {
  const lower = command.toLowerCase();
  const languageServer = /(^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(?:\s|$)/.test(lower);
  const appMatch = (lower.includes("--app_data_dir") && lower.includes("antigravity"))
    || [
      "antigravity.app/", "/gemini.app/", "antigravity ide.app/", // macOS 候选，保留
      "antigravity.exe", "antigravity ide.exe",                   // Windows 安装目录形态
    ].some((marker) => lower.includes(marker));
  if (languageServer && appMatch) return "ide";
  if (/(^|[/\\])(antigravity-cli|antigravity_cli|agy)(?:\.exe)?(?:\s|[/\\]|$)/.test(lower)) return "cli";
  return null;
}

/** 对应 _antigravity_process_infos：只吃「PID 命令行」行；ide 必须带 csrf，端口越界置空 */
export function antigravityProcessInfos(output: unknown): AntigravityProcessInfo[] {
  const results: AntigravityProcessInfo[] = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    const kind = antigravityProcessKind(command);
    if (!kind) continue;
    const csrf = antigravityExtractFlag(command, "--csrf_token");
    if (kind !== "cli" && !csrf) continue;
    let extensionPort = providerInteger(antigravityExtractFlag(command, "--extension_server_port"));
    if (extensionPort !== null && !(extensionPort > 0 && extensionPort <= 65535)) extensionPort = null;
    results.push({
      pid,
      kind,
      csrf_token: csrf ?? "",
      extension_port: extensionPort,
      extension_csrf_token: antigravityExtractFlag(command, "--extension_server_csrf_token"),
    });
  }
  return results;
}

function scanCacheFileOf(deps: AntigravityDeps): string {
  return deps.scanCacheFile ?? path.join(TOKEI_DIR, "antigravity_scan_cache.json");
}

/** 对应 _antigravity_scan_recently_empty：扫空后 90 秒内不再扫表 */
export function antigravityScanRecentlyEmpty(deps: AntigravityDeps, nowEpoch?: number): boolean {
  const root = loadJson<unknown>(scanCacheFileOf(deps), {});
  const emptyAt = isRecord(root) ? providerNumber(root.empty_at) : null;
  if (emptyAt === null) return false;
  const now = Math.trunc(nowEpoch ?? deps.now());
  const age = now - Math.trunc(emptyAt);
  return age >= 0 && age < ANTIGRAVITY_SCAN_MISS_TTL;
}

/** 对应 _record_antigravity_scan：扫到了就删掉 miss 缓存，扫空则落一个 empty_at */
export function recordAntigravityScan(deps: AntigravityDeps, found: boolean, nowEpoch?: number): void {
  const file = scanCacheFileOf(deps);
  if (found) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 删不掉就算了，下次覆盖写也无害
    }
    return;
  }
  saveJson(file, { empty_at: Math.trunc(nowEpoch ?? deps.now()) });
}

/** 对应 _antigravity_running_processes。注意两个失败分支的不对称：命令本身失败
 * （Python 的 OSError）不落 miss 缓存，跑成功但没匹配到才落。 */
export function antigravityRunningProcesses(deps: AntigravityDeps): AntigravityProcessInfo[] {
  if (antigravityScanRecentlyEmpty(deps)) return [];
  const output = run(deps, ANTIGRAVITY_PROCESS_LIST_COMMAND);
  if (output === null) return [];
  const processes = antigravityProcessInfos(output);
  recordAntigravityScan(deps, processes.length > 0);
  return processes;
}

/**
 * 对应 _antigravity_listening_ports 的正则部分：`:(\d+)\s+\(LISTEN\)` 换行格式。
 * 只认 TCP、LISTENING、且 PID 列等于目标进程的行；`[::1]:40511` 与 `127.0.0.1:40511`
 * 会撞成同一个端口，用 Set 去重后升序，和 Python 的 sorted({...}) 一致。
 */
export function parseNetstatListeningPorts(output: unknown, pid: number): number[] {
  const ports = new Set<number>();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+):(\d{1,5})\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!match || Number.parseInt(match[3], 10) !== pid) continue;
    const port = Number.parseInt(match[2], 10);
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** 对应 _antigravity_listening_ports：Windows 没有「按 PID 过滤的 lsof」，跑全表再筛 */
export function antigravityListeningPorts(deps: AntigravityDeps, pid: number): number[] {
  const output = run(deps, ANTIGRAVITY_NETSTAT_COMMAND);
  if (output === null) return [];
  return parseNetstatListeningPorts(output, pid);
}

/**
 * 对应 _antigravity_endpoints：扩展端口（http）在前，先扩展 token 后主 token；
 * LISTEN 到的端口走 https。元组用 \0 连接做去重键，等价于 Python 的 list 等值去重。
 */
export function antigravityEndpoints(
  deps: AntigravityDeps, process: AntigravityProcessInfo,
): AntigravityEndpoint[] {
  const endpoints: AntigravityEndpoint[] = [];
  const extensionPort = process.extension_port;
  if (extensionPort) {
    for (const token of [process.extension_csrf_token, process.csrf_token]) {
      // 对齐 Python 的 `if token is not None`：空串也收（https 分支同样发空串）
      if (token !== null && token !== undefined) endpoints.push(["http", extensionPort, token, true]);
    }
  }
  for (const port of antigravityListeningPorts(deps, process.pid)) {
    endpoints.push(["https", port, process.csrf_token || "", process.kind !== "cli"]);
  }
  const seen = new Set<string>();
  const unique: AntigravityEndpoint[] = [];
  for (const endpoint of endpoints) {
    const key = endpoint.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(endpoint);
  }
  return unique;
}

/** 对应 _antigravity_request：Connect-RPC 走 POST，IDE 侧自签证书必须放行 */
async function antigravityRequest(
  deps: AntigravityDeps, endpoint: AntigravityEndpoint, endpointPath: string, body: unknown,
): Promise<any> {
  const [scheme, port, csrf, requiresCsrf] = endpoint;
  const headers: Record<string, string> = { "Connect-Protocol-Version": "1" };
  if (requiresCsrf) headers["X-Codeium-Csrf-Token"] = csrf;
  return deps.request(`${scheme}://127.0.0.1:${port}${endpointPath}`, {
    headers,
    method: "POST",
    body,
    timeoutSeconds: 2,
    allowInsecureLoopbackTls: true,
  });
}

/**
 * 对应 _antigravity_remaining：Connect JSON 把 oneof 摊平时直接带
 * remainingFraction；老客户端会包一层 {case, value}。钳到 0-1。
 */
export function antigravityRemaining(value: unknown): number | null {
  if (!isRecord(value)) return null;
  let raw = value.remainingFraction;
  if (raw === undefined || raw === null) {
    if (value.case === "remainingFraction") raw = value.value;
  }
  const number = providerNumber(raw);
  return number !== null ? Math.max(0, Math.min(1, number)) : null;
}

/** 对应 _ANTIGRAVITY_QUOTA_WINDOWS：只认官方共享组，模型变体不能顶替周额度 */
const ANTIGRAVITY_QUOTA_WINDOWS: ReadonlyArray<readonly [string, string, number]> = [
  ["gemini-weekly", "Gemini 周", 10080],
  ["gemini-5h", "Gemini 5h", 300],
  ["3p-weekly", "Claude/GPT 周", 10080],
  ["3p-5h", "Claude/GPT 5h", 300],
];

/** 对应 _normalize_antigravity_quota_summary */
export function normalizeAntigravityQuotaSummary(payload: unknown, updated?: number): Record<string, any> {
  // Connect JSON 有时把结果包在 response 里，摊平后再找 groups
  const unwrapped = isRecord(payload) && isRecord(payload.response) ? payload.response : payload;
  const root = isRecord(unwrapped) ? unwrapped : {};
  const groups = Array.isArray(root.groups) ? root.groups : [];
  const buckets: Record<string, Record<string, any>> = {};
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const display = String(group.displayName || "").toLowerCase();
    const family = display.includes("gemini") ? "gemini"
      : ["claude", "gpt", "third"].some((name) => display.includes(name)) ? "3p" : null;
    if (!family) continue;
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!isRecord(bucket) || bucket.disabled === true) continue;
      const cadence = ["window", "bucketId", "displayName"]
        .map((key) => String(bucket[key] || "")).join(" ").toLowerCase().replace(/_/g, "-");
      let cadenceId: string | null = null;
      if (["weekly", "week", "7d"].some((marker) => cadence.includes(marker))) cadenceId = "weekly";
      else if (["5h", "5-hour", "five hour", "five-hour", "session"].some((marker) => cadence.includes(marker))) cadenceId = "5h";
      if (!cadenceId) continue;
      const id = `${family}-${cadenceId}`;
      if (!(id in buckets)) buckets[id] = bucket; // setdefault：先到先得
    }
  }
  const rows = [];
  if (Object.keys(buckets).length > 0) {
    for (const [bucketId, title, minutes] of ANTIGRAVITY_QUOTA_WINDOWS) {
      const bucket = buckets[bucketId] ?? {};
      // Connect JSON 摊平 oneof；老客户端包在 remaining 里
      let remaining = antigravityRemaining(bucket);
      if (remaining === null) remaining = antigravityRemaining(bucket.remaining);
      rows.push(providerWindow(
        `antigravity-${bucketId}`, title,
        remaining !== null ? (1 - remaining) * 100 : null,
        bucket.resetTime, minutes,
        remaining === null ? "暂时无法读取" : null,
        remaining !== null,
      ));
    }
  }
  return {
    available: rows.length > 0,
    plan: null,
    account: null,
    windows: rows,
    details: [],
    source: "antigravity-local",
    updated: Math.trunc(updated ?? epochSeconds()),
    stale: false,
  };
}

/** 对应 _antigravity_user_identity：tier 先于 planInfo，逐个找第一个非空白串 */
export function antigravityUserIdentity(payload: unknown): { plan: string | null; account: string | null } {
  if (!isRecord(payload)) return { plan: null, account: null };
  const status = isRecord(payload.userStatus) ? payload.userStatus : payload;
  const tier = isRecord(status.userTier) ? status.userTier : {};
  const planStatus = isRecord(status.planStatus) ? status.planStatus : {};
  const planInfo = isRecord(planStatus.planInfo) ? planStatus.planInfo : {};
  const plan = [
    tier.name, planInfo.planName, planInfo.planDisplayName,
    planInfo.displayName, planInfo.productName, planInfo.planShortName,
  ].find((value) => typeof value === "string" && value.trim() !== "");
  return {
    plan: typeof plan === "string" ? plan.trim() : null,
    account: typeof status.email === "string" ? status.email : null,
  };
}

const ENDPOINT_PATHS = {
  summary: "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
  status: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
};

const IDENTITY_METADATA = {
  metadata: {
    ideName: "antigravity", extensionName: "antigravity",
    ideVersion: "unknown", locale: "en",
  },
};

/** 对应 fetch_antigravity_quota */
export async function fetchAntigravityQuota(deps: AntigravityDeps): Promise<Record<string, any>> {
  let lastError: unknown = null;
  for (const process of antigravityRunningProcesses(deps)) {
    const endpoints = antigravityEndpoints(deps, process);
    if (endpoints.length === 0) continue;
    const marker = providerCredentialMarker(
      "antigravity", "quota-summary-v3", process.pid, process.csrf_token, endpoints);
    const now = Math.trunc(deps.now());
    const cached = cachedProviderQuota("antigravity", marker, PROVIDER_QUOTA_TTL, now);
    if (cached) return cached;
    for (const endpoint of endpoints) {
      try {
        const summaryPayload = await antigravityRequest(deps, endpoint, ENDPOINT_PATHS.summary, { forceRefresh: true });
        const quota = normalizeAntigravityQuotaSummary(summaryPayload);
        if (quota.available) {
          try {
            const identityPayload = await antigravityRequest(deps, endpoint, ENDPOINT_PATHS.status, IDENTITY_METADATA);
            const identity = antigravityUserIdentity(identityPayload);
            quota.plan = identity.plan;
            quota.account = identity.account;
          } catch {
            // 身份拿不到不影响额度本身，照原版继续
          }
          saveProviderQuotaCache("antigravity", marker, quota, deps.now());
          return quota;
        }
      } catch (error) {
        lastError = error;
      }
    }
    const fallback = cachedProviderQuota("antigravity", marker, PROVIDER_QUOTA_FALLBACK_TTL, now, true);
    if (fallback) return fallback;
  }
  if (lastError) throw lastError;
  return {};
}

/** 对应 scan_antigravity_quota：antigravity 在 Python 里是默认开的两路之一 */
export async function scanAntigravityQuota(deps: AntigravityDeps): Promise<Record<string, any>> {
  if (!providerQuotaEnabled("antigravity", deps)) return {};
  return fetchAntigravityQuota(deps);
}
