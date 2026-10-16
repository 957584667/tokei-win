/**
 * 千问办公（QwenWork）额度读取器：对应 usage.30s.py 的 scan_qwenwork_quota(5635) /
 * _read_qwenwork_mcp_config(5285) / _qwenwork_mcp_rpc(5362) / _qwenwork_mcp_data(5406) /
 * _normalize_qwenwork_usage(5535)。只读额度，不参与 Qwen Code 的 token/成本/模型统计。
 *
 * 安全边界（CALCULATION.md §5 千问办公）：URL 只允许 `http://127.0.0.1:<port>`，
 * 其它（0.0.0.0、localhost、任何外网主机、https、带 path/query/fragment/内嵌凭据）一律拒绝。
 * 工具名固定 `qw_query`、参数固定 `{"key":"qwenwork.usage"}`，不读取 auth-v2.dat、不读浏览器 Cookie。
 *
 * 记账口径：
 * - `segments` 是 canonical 明细；`planCredits` / `addOnCredits` 只是同数据的镜像别名，
 *   仅在 segments 缺失时用来生成 segment，绝不与 segments 相加；
 * - `sharedResourcePackage` / `sharedAddOnCredits`（共享资源包）单独展示，不并入个人余额；
 * - `aggregateRemainingPercent` 是**剩余**百分比，允许 null → 只显示绝对积分，不反推已用%；
 * - `total=0 且 remaining>0` 是合法的「未知总额」状态，不折算成 0% 剩余条。
 *
 * 网络请求默认关闭：由 ~/.tokei/config.json 的 `qwenwork_quota_enabled` 或
 * TOKEI_QWENWORK_QUOTA=1 显式打开（=0 强制关闭）；测试中不得打开。
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { HOME, TOKEI_DIR, expandPath, loadJson, saveJson } from "../core/paths";

/** 对应 QWENWORK_HOME：env 在调用时读取，便于测试注入（与 qwencode/kimicode 一致） */
export function qwenworkHome(): string {
  return expandPath(process.env.TOKEI_QWENWORK_HOME) || path.join(HOME, ".qwenworkcn");
}
export function qwenworkMcpConfigPath(): string {
  return path.join(qwenworkHome(), "mcp-adaptor.config");
}
export function qwenworkStatusPath(): string {
  return path.join(qwenworkHome(), ".status.json");
}
const QWENWORK_QUOTA_CACHE = path.join(TOKEI_DIR, "qwenwork_quota_cache.json");

const QUOTA_TTL = 300;
const QUOTA_FALLBACK_TTL = 3600;
const MCP_TIMEOUT_MS = 3000;
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// ---------------- 开关 ----------------

/** 对应 _qwenwork_quota_enabled()：默认关闭，环境变量优先级最高 */
export function qwenworkQuotaEnabled(nowConfig?: Record<string, any>): boolean {
  const env = process.env.TOKEI_QWENWORK_QUOTA;
  if (env === "0") return false;
  if (env === "1") return true;
  const config = nowConfig ?? loadJson<Record<string, any>>(path.join(TOKEI_DIR, "config.json"), {});
  return !!(config && typeof config === "object" && config.qwenwork_quota_enabled);
}

// ---------------- 配置解析与 URL 校验 ----------------

export interface QwenworkMcpConfig {
  port: number;
  token: string;
  marker: string;
}

/**
 * 对应 URL 校验：只接受 http://127.0.0.1:<port>，其它一律 null。
 * 这是安全边界，单独导出给测试直接打各种恶意 URL。
 */
export function resolveQwenworkLoopbackUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "127.0.0.1") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (parsed.port === "") return null;
  return `http://127.0.0.1:${port}`;
}

/** 对应 _qwenwork_private_file_marker()：只取文件 generation 元数据，不读内容 */
export function qwenworkFileMarker(file: string): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "untrusted";
  if (isPosix() && !isPrivateMode(st.mode)) return "untrusted";
  return `${Number(st.ino)}:${Math.trunc(st.mtimeMs)}:${st.size}`;
}

function isPosix(): boolean {
  return process.platform !== "win32";
}

/** 0600 风格私有文件；Windows 的 ACL 不体现在 mode 位上，NTFS 上靠 ACL 保证 */
function isPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** 对应 _read_qwenwork_mcp_config()；configPath 省略时调用时才解析 env，便于测试注入 */
export function readQwenworkMcpConfig(configPath?: string): QwenworkMcpConfig | null {
  const file = configPath ?? qwenworkMcpConfigPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size <= 0 || st.size > MAX_CONFIG_BYTES) return null;
  if (isPosix() && !isPrivateMode(st.mode)) return null;
  let config: Record<string, any>;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const url = resolveQwenworkLoopbackUrl(config.url);
  if (!url) return null;
  const port = Number(new URL(url).port);
  const token = typeof config.token === "string" ? config.token.trim() : "";
  // x-api-key 能调用适配器其它工具，只信任 64 位十六进制的本机私有 token
  if (!/^[0-9a-fA-F]{64}$/.test(token)) return null;
  const marker = `${Number(st.ino)}:${Math.trunc(st.mtimeMs)}:${st.size}:${port}:${qwenworkFileMarker(qwenworkStatusPath())}`;
  return { port, token, marker };
}

// ---------------- 响应归一化 ----------------

export interface QwenworkSegment {
  id: string;
  kind: string;
  total: number | null;
  used: number | null;
  remaining: number | null;
  percentage_used: number | null;
  unit: string | null;
  renews_at: number | null;
  expires_at: number | null;
}

export interface QwenworkShared {
  total: number | null;
  used: number | null;
  remaining: number | null;
  percentage_used: number | null;
  unit: string | null;
  expires_at: number | null;
}

/**
 * 本模块输出键位：
 * - 与 macOS Swift `QwenWorkQuota`（Model.swift 841）同名的权威键：
 *   available / remaining / remaining_pct / exceeded / is_team / expires_at /
 *   plan_expiration / segments / shared / source / updated / stale；
 * - compute.ts 占位补充的便捷别名：plan_credits / add_on_credits /
 *   shared_add_on_credits / aggregate_remaining_percent（与权威键同值，只读展示用）。
 */
export interface QwenworkQuotaPayload {
  available: boolean;
  /** credit 单位 segment 的 remaining 求和；无则取 data.remaining/balance，可为 null */
  remaining: number | null;
  /** aggregateRemainingPercent（剩余百分比），接口没给时为 null → 只显示绝对积分 */
  remaining_pct: number | null;
  exceeded: boolean;
  is_team: boolean;
  expires_at: number | null;
  plan_expiration: number | null;
  segments: QwenworkSegment[];
  shared: QwenworkShared | null;
  plan_credits: QwenworkSegment | null;
  add_on_credits: QwenworkSegment | null;
  shared_add_on_credits: QwenworkShared | null;
  aggregate_remaining_percent: number | null;
  source: string | null;
  updated: number | null;
  stale: boolean | null;
}

function qwenworkNumber(value: unknown, options: { percent?: boolean } = {}): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const upper = options.percent ? 100 : 1e15;
  return Math.min(upper, Math.max(0, n));
}

function qwenworkEpoch(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const epoch = value > 1_000_000_000_000 ? value / 1000 : value;
    return epoch > 0 && epoch < 253_402_300_800 ? Math.trunc(epoch) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) return qwenworkEpoch(asNumber);
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return null;
    return Math.trunc(date.getTime() / 1000);
  }
  return null;
}

function safeName(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return SAFE_NAME.test(text) ? text : fallback;
}

/** 对应 _normalize_qwenwork_segment() */
export function normalizeQwenworkSegment(
  item: Record<string, any> | null | undefined,
  index: number,
  defaults: { id?: string; kind?: string } = {},
): QwenworkSegment | null {
  if (!item || typeof item !== "object") return null;
  const id = safeName(item.id, defaults.id || `segment_${index + 1}`);
  const kind = safeName(item.kind, defaults.kind || id);
  const rawUnit = item.unit;
  let unit: string | null = rawUnit === undefined || rawUnit === null ? null : safeName(rawUnit, "");
  if (!unit) unit = null;
  const total = qwenworkNumber(item.total);
  let percentageUsed = qwenworkNumber(item.percentageUsed ?? item.percentage, { percent: true });
  // total=0 在当前响应里表示分母未知：保留绝对余额，但不把 percentageUsed=0 变成假的 0% 剩余条
  if (total === null || total <= 0) percentageUsed = null;
  const segment: QwenworkSegment = {
    id, kind, total,
    used: qwenworkNumber(item.used),
    remaining: qwenworkNumber(item.remaining),
    percentage_used: percentageUsed,
    unit,
    renews_at: qwenworkEpoch(item.renewsAt ?? item.renews_at),
    expires_at: qwenworkEpoch(item.expiresAt ?? item.planExpiration ?? item.expires_at),
  };
  if (segment.total === null && segment.used === null && segment.remaining === null && segment.percentage_used === null) return null;
  return segment;
}

/** 对应 _normalize_qwenwork_shared()：共享资源包，独立展示 */
export function normalizeQwenworkShared(item: Record<string, any> | null | undefined): QwenworkShared | null {
  if (!item || typeof item !== "object") return null;
  const rawUnit = item.unit;
  let unit: string | null = rawUnit === undefined || rawUnit === null ? null : safeName(rawUnit, "");
  if (!unit) unit = null;
  const total = qwenworkNumber(item.total ?? item.cap ?? item.allowance);
  let percentageUsed = qwenworkNumber(item.percentageUsed ?? item.percentage, { percent: true });
  if (total === null || total <= 0) percentageUsed = null;
  const shared: QwenworkShared = {
    total,
    used: qwenworkNumber(item.used),
    remaining: qwenworkNumber(item.remaining),
    percentage_used: percentageUsed,
    unit,
    expires_at: qwenworkEpoch(item.expiresAt ?? item.expires_at),
  };
  if ([shared.total, shared.used, shared.remaining, shared.percentage_used, shared.expires_at].every((v) => v === null)) return null;
  return shared;
}

function findKind(segments: QwenworkSegment[], ...needles: string[]): QwenworkSegment | null {
  for (const segment of segments) {
    const haystack = `${segment.kind} ${segment.id}`.toLowerCase();
    if (needles.some((needle) => haystack.includes(needle))) return segment;
  }
  return null;
}

export function emptyQwenworkPayload(): QwenworkQuotaPayload {
  return {
    available: false, remaining: null, remaining_pct: null, exceeded: false, is_team: false,
    expires_at: null, plan_expiration: null,
    segments: [], plan_credits: null, add_on_credits: null, shared: null, shared_add_on_credits: null,
    aggregate_remaining_percent: null, source: null, updated: null, stale: null,
  };
}

/** 对应 _normalize_qwenwork_usage()，别名与 canonical 二选一，绝不双算 */
export function normalizeQwenworkUsage(
  data: Record<string, any> | null | undefined,
  options: { updated?: number | null; source?: string } = {},
): QwenworkQuotaPayload | null {
  if (!data || typeof data !== "object" || data.available === false) return null;

  const segments: QwenworkSegment[] = [];
  const rawSegments = Array.isArray(data.segments) ? data.segments : null;
  if (rawSegments) {
    for (let index = 0; index < Math.min(rawSegments.length, 8); index++) {
      const segment = normalizeQwenworkSegment(rawSegments[index], index);
      if (segment) segments.push(segment);
    }
  }
  // planCredits / addOnCredits 是 segments 的镜像，只有没有 canonical 明细时才用它俩
  if (!segments.length) {
    const aliases: Array<[string, string, string]> = [
      ["planCredits", "plan", "plan_credits"],
      ["addOnCredits", "add_on", "add_on_credits"],
    ];
    for (const [key, id, kind] of aliases) {
      const segment = normalizeQwenworkSegment(data[key], segments.length, { id, kind });
      if (segment) segments.push(segment);
    }
  }

  const sharedSource = data.sharedResourcePackage && typeof data.sharedResourcePackage === "object"
    ? data.sharedResourcePackage
    : data.sharedAddOnCredits; // 共享包只作 fallback，不并入个人套餐/加购余额
  const shared = normalizeQwenworkShared(sharedSource as Record<string, any> | null);
  const aggregate = qwenworkNumber(data.aggregateRemainingPercent, { percent: true });

  // 对应 Python 5559-5568：个人余额 = credit 单位 segment 的 remaining 求和，
  // 没有 credit segment 时才退回顶层 remaining/balance；共享包绝不并入。
  const remainingValues: number[] = [];
  for (const segment of segments) {
    const unit = (segment.unit || "").toLowerCase();
    const isCredit = unit ? (unit === "credit" || unit === "credits") : segment.kind.toLowerCase().includes("credit");
    if (segment.remaining !== null && isCredit) remainingValues.push(segment.remaining);
  }
  let remaining: number | null = remainingValues.length ? remainingValues.reduce((a, b) => a + b, 0) : null;
  if (remaining === null) remaining = qwenworkNumber(data.remaining ?? data.balance);

  if (remaining === null && aggregate === null && !segments.length && shared === null) return null;

  const plan = findKind(segments, "plan");
  const addOn = findKind(segments, "add_on", "addon", "add on", "booster");
  return {
    // null 是「接口没给剩余百分比」，界面显示绝对积分，不反推已用%
    available: true,
    remaining,
    remaining_pct: aggregate,
    exceeded: data.isQuotaExceeded === true,
    is_team: data.isTeamPlan === true,
    expires_at: qwenworkEpoch(data.expiresAt),
    plan_expiration: qwenworkEpoch(data.planExpiration),
    segments,
    shared,
    plan_credits: plan,
    add_on_credits: addOn,
    shared_add_on_credits: shared,
    aggregate_remaining_percent: aggregate,
    source: options.source || "mcp",
    updated: Math.trunc(options.updated ?? Date.now() / 1000),
    stale: false,
  };
}

/** 对应 _qwenwork_mcp_data()：拆 MCP 信封 */
export function qwenworkMcpData(payload: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!payload || typeof payload !== "object") return null;
  const result = payload.result;
  if (!result || typeof result !== "object") return null;
  let envelope: Record<string, any> | null = result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : null;
  if (!envelope) {
    for (const item of Array.isArray(result.content) ? result.content : []) {
      if (!item || typeof item !== "object" || typeof item.text !== "string") continue;
      try {
        const candidate = JSON.parse(item.text);
        if (candidate && typeof candidate === "object") {
          envelope = candidate;
          break;
        }
      } catch { /* 非 JSON 文本忽略 */ }
    }
  }
  if (!envelope || envelope.ok === false) return null;
  if (envelope.key !== null && envelope.key !== undefined && envelope.key !== "qwenwork.usage") return null;
  if (envelope.data && typeof envelope.data === "object") return envelope.data;
  if (["available", "segments", "planCredits"].some((key) => key in envelope)) return envelope;
  return null;
}

// ---------------- 缓存 ----------------

function cachedQwenwork(marker: string, maxAge: number, options: { stale?: boolean } = {}, nowEpoch = Date.now() / 1000): QwenworkQuotaPayload | null {
  const cached = loadJson<Record<string, any>>(QWENWORK_QUOTA_CACHE, {});
  if (!cached || typeof cached !== "object" || cached.config_marker !== marker) return null;
  const quota = cached.quota;
  const fetchedAt = Number(cached.fetched_at);
  if (!quota || typeof quota !== "object" || !Number.isFinite(fetchedAt)) return null;
  const age = nowEpoch - fetchedAt;
  if (age < -60 || age > maxAge) return null;
  const out = { ...quota } as QwenworkQuotaPayload;
  if (options.stale) {
    out.source = "cache";
    out.stale = true;
  }
  return out;
}

function saveQwenworkCache(quota: QwenworkQuotaPayload, marker: string): void {
  if (!quota || !quota.available) return;
  saveJson(QWENWORK_QUOTA_CACHE, { fetched_at: Date.now() / 1000, config_marker: marker, quota });
}

function clearQwenworkCache(): void {
  try {
    fs.unlinkSync(QWENWORK_QUOTA_CACHE);
  } catch { /* 本来就没有缓存 */ }
}

// ---------------- 网络（默认关闭） ----------------

/**
 * 对应 _qwenwork_mcp_rpc()：固定 POST 到 127.0.0.1:<port>，不走代理、不跟随重定向。
 * 只有 qwenworkQuotaEnabled() 为真时才会被调用；测试全程不触发。
 */
export function qwenworkMcpRpc(config: QwenworkMcpConfig): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "qw_query", arguments: { key: "qwenwork.usage" } },
    });
    const request = http.request({
      host: "127.0.0.1",
      port: config.port,
      path: "/",
      method: "POST",
      timeout: MCP_TIMEOUT_MS,
      headers: {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": "Tokei",
        "x-api-key": config.token,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          response.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => resolve(null));
      response.on("end", () => {
        const contentType = String(response.headers["content-type"] || "").toLowerCase();
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          if (contentType.includes("text/event-stream")) {
            for (const line of text.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const candidate = line.slice(5).trim();
              if (!candidate) continue;
              resolve(JSON.parse(candidate));
              return;
            }
            resolve(null);
            return;
          }
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.end(body);
  });
}

/** 对应 scan_qwenwork_quota() */
export async function scanQwenworkQuota(): Promise<QwenworkQuotaPayload> {
  if (!qwenworkQuotaEnabled()) return emptyQwenworkPayload();
  const config = readQwenworkMcpConfig();
  if (!config) return emptyQwenworkPayload();
  const cached = cachedQwenwork(config.marker, QUOTA_TTL);
  if (cached) return cached;

  let latest = config;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      const refreshed = readQwenworkMcpConfig();
      if (!refreshed) break;
      latest = refreshed;
    }
    const payload = await qwenworkMcpRpc(latest);
    const data = qwenworkMcpData(payload);
    if (data && data.available === false) {
      clearQwenworkCache();
      return emptyQwenworkPayload();
    }
    const quota = normalizeQwenworkUsage(data);
    if (quota) {
      saveQwenworkCache(quota, latest.marker);
      return quota;
    }
  }
  return cachedQwenwork(latest.marker, QUOTA_FALLBACK_TTL, { stale: true }) || emptyQwenworkPayload();
}

/**
 * compute() 用的同步入口：只读配置与短缓存，不发网络请求。
 * 实时查询由主进程定时器调 scanQwenworkQuota()（同样受 qwenwork_quota_enabled 约束），
 * 成功后写 QWENWORK_QUOTA_CACHE，这里再按缓存代际取回。
 */
export function scanQwenwork(): QwenworkQuotaPayload {
  if (!qwenworkQuotaEnabled()) return emptyQwenworkPayload();
  const config = readQwenworkMcpConfig();
  if (!config) return emptyQwenworkPayload();
  const fresh = cachedQwenwork(config.marker, QUOTA_TTL);
  if (fresh) return fresh;
  return cachedQwenwork(config.marker, QUOTA_FALLBACK_TTL, { stale: true }) || emptyQwenworkPayload();
}
