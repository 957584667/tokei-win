/**
 * z.ai / 智谱 GLM 额度：对应 usage.30s.py 的 6978-7230。
 *
 * 与 sub2api 同骨架，但有两个额外门：region 只认 global / bigmodel-cn，scope 只认
 * personal / team，任何一个非法都直接返回 {}（原版如此，宁可不取也不发错请求）。
 * team 作用域还必须同时填了 organization 与 project —— 少一个就没有可查的团队。
 *
 * 域名钉死在代码里（api.z.ai / open.bigmodel.cn / www.bigmodel.cn），用户配置只能
 * 在两个白名单区域之间切换，不能注入任意 URL；这也是本路唯一的 SSRF 防线。
 * bigmodel-cn 区域会多打一次账户余额接口、失败静默；模型用量曲线再补一次 15 秒
 * 超时的 model-usage 请求（放宽到 8MiB），同样失败就退回空曲线。
 */
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, cachedProviderQuota, epochSeconds,
  providerConfigString, providerCredentialMarker, providerEpoch, providerInteger,
  providerNumber, providerPercent, providerQuotaEnabled, providerUsageFromDays, providerUsageInt,
  providerWindow, saveProviderQuotaCache,
} from "../../core/providerQuota";
import { Bounds, dayKey } from "../../core/ranges";
import { QuotaDeps, secretValue } from "./context";

type Dict = Record<string, any>;

function asDict(value: unknown): Dict | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Dict : null;
}

/** 对应 urlencode 的 quote_plus：与 sub2api 同一处理，空格编码成 + */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/** 对应 Python 的 f"{v:g}"：最多 6 位有效数字，≥1e6 或 <1e-4 用科学计数法 */
function gFormat(value: number): string {
  const rounded = Number(value.toPrecision(6));
  const abs = Math.abs(rounded);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) {
    const [mantissa, exponent] = rounded.toExponential().split("e");
    const exp = Number(exponent);
    return `${Number(mantissa)}e${exp >= 0 ? "+" : "-"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return String(rounded);
}

/** 对应 _zai_quota_url：team 作用域把 type 换成 2 追加进去，个人作用域原样返回 */
export function zaiQuotaUrl(url: string, scope = "personal"): string {
  if (scope !== "team") return url;
  const parsed = new URL(url);
  const pairs: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, key) => {
    if (key !== "type") pairs.push([key, value]);
  });
  pairs.push(["type", "2"]);
  parsed.search = pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
  return parsed.toString();
}

/** 对应 Python 的 strftime("%Y-%m-%d %H:%M:%S")，本地时区 */
function strftime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 对应 _zai_model_usage_url：窗口固定近 30 天；end 只把分/秒钉到 59:59（保留原时），
 * 这是原版的怪写法，照抄不改。team 作用域 type=3。
 */
export function zaiModelUsageUrl(base: string, scope = "personal", now = new Date()): string {
  const start = new Date(now.getTime() - 30 * 86400_000);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setMinutes(59, 59, 0);
  const pairs: Array<[string, string]> = [
    ["startTime", strftime(start)],
    ["endTime", strftime(end)],
  ];
  if (scope === "team") pairs.push(["type", "3"]);
  const query = pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
  return `${base.replace(/\/+$/, "")}/api/monitor/usage/model-usage?${query}`;
}

/**
 * 对应 datetime.fromisoformat(label).astimezone()：naive 串按本地时区解释，
 * 带 ±HH:MM / Z 的按偏移折算成绝对时刻。只认接口实际会发的日期/日期时间形态。
 */
function parseIsoLocal(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, offset] = m;
  if (!h) return new Date(Number(y), Number(mo) - 1, Number(d));
  const seconds = s ? Number(s) : 0;
  if (!offset) return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), seconds);
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.replace(/^[+-Z]|:/g, "").padEnd(4, "0");
  const offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), seconds);
  return new Date(utcMs - offsetMinutes * 60_000);
}

/** 对应 _normalize_zai_model_usage：把 x_time × modelDataList 摊成按天桶再进区间汇总 */
export function normalizeZaiModelUsage(
  payload: unknown, opts?: { bounds?: Bounds },
): ReturnType<typeof providerUsageFromDays> {
  const root = asDict(payload);
  const empty = () => providerUsageFromDays({}, { bounds: opts?.bounds, limitedCoverage: "近30天" });
  if (!root || root.success !== true || providerNumber(root.code) !== 200) return empty();
  const data = asDict(root.data) ?? {};
  const labels = Array.isArray(data.x_time) ? data.x_time : [];
  const models = Array.isArray(data.modelDataList) ? data.modelDataList : [];
  const parsedLabels: Array<Date | null> = labels.map(
    (label) => (typeof label === "string" ? parseIsoLocal(label) : null));

  const days: Dict = {};
  for (const rawModel of models) {
    const model = asDict(rawModel);
    if (!model) continue;
    const rawName = typeof model.modelName === "string" ? model.modelName.trim() : "";
    const name = rawName || "unknown";
    const values = Array.isArray(model.tokensUsage) ? model.tokensUsage : [];
    parsedLabels.forEach((dt, index) => {
      if (!dt || index >= values.length) return;
      const tokens = providerUsageInt(values[index]);
      if (tokens <= 0) return;
      const dayKeyStr = dayKey(dt);
      const day = (days[dayKeyStr] ??= {
        tokens: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, requests: 0,
        models: {} as Dict, hours: new Array(24).fill(0),
      });
      day.tokens += tokens;
      day.hours[dt.getHours()] += tokens;
      const usage = (day.models[name] ??= { tokens: 0 });
      usage.tokens += tokens;
    });
  }
  return providerUsageFromDays(days, { bounds: opts?.bounds, limitedCoverage: "近30天" });
}

/** 对应 _zai_limit：把一条 limit 原始记录折成展示所需字段；类型不对或缺三元组就判 null */
function zaiLimit(raw: unknown): Dict | null {
  const item = asDict(raw);
  if (!item || !["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(String(item.type))) return null;
  const unit = providerInteger(item.unit);
  const number = providerInteger(item.number);
  const percent = providerPercent(providerInteger(item.percentage));
  if (unit === null || number === null || percent === null) return null;
  const usage = providerNumber(item.usage);
  const current = providerNumber(item.currentValue);
  const remaining = providerNumber(item.remaining);
  let finalPercent = percent;
  if (usage !== null && usage > 0) {
    // 用量口径优先于接口给的 percentage：能推出 used 就重算，夹到 [0, usage]
    let used: number | null = null;
    if (remaining !== null) {
      used = Math.max(usage - remaining, current !== null ? current : usage - remaining);
    } else if (current !== null) {
      used = current;
    }
    if (used !== null) {
      finalPercent = providerPercent(Math.max(0, Math.min(usage, used)) / usage * 100) ?? percent;
    }
  }

  // unit→分钟倍率表照原版抄：1=天、3=分、5=秒、6=周
  const multipliers: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
  let minutes = number > 0 && multipliers[unit] !== undefined ? number * multipliers[unit] : null;
  if (item.type === "TIME_LIMIT" && unit === 5 && number === 1) minutes = 30 * 24 * 60;
  const details = Array.isArray(item.usageDetails) ? item.usageDetails : [];
  return {
    raw: item, usage, current, remaining, percent: finalPercent, window_minutes: minutes,
    reset: providerEpoch(item.nextResetTime), details,
  };
}

/** 对应 _zai_limit_detail */
function zaiLimitDetail(limit: Dict): string | null {
  const parts: string[] = [];
  if (limit.usage !== null) parts.push(`${gFormat(limit.usage)} limit`);
  if (limit.remaining !== null) parts.push(`${gFormat(limit.remaining)} remaining`);
  return parts.join(" · ") || null;
}

/** 对应 _normalize_zai_quota */
export function normalizeZaiQuota(
  payload: unknown,
  opts?: { region?: string; balance?: unknown; updated?: number },
): Dict {
  const region = opts?.region ?? "global";
  const root = asDict(payload);
  if (!root || root.success !== true || providerNumber(root.code) !== 200) return {};
  const data = asDict(root.data) ?? {};
  const limitItems = (Array.isArray(data.limits) ? data.limits : [])
    .map((item) => zaiLimit(item)).filter((item): item is Dict => item !== null);
  // 窗口从小到大排序：最短的是「会话额度」，最长的才是「周期额度」
  const tokenLimits = limitItems
    .filter((item) => ["TOKENS_LIMIT", "CREDIT_LIMIT"].includes(String(item.raw.type)))
    .sort((a, b) => (a.window_minutes ?? Number.MAX_SAFE_INTEGER)
      - (b.window_minutes ?? Number.MAX_SAFE_INTEGER));
  const timeLimits = limitItems.filter((item) => item.raw.type === "TIME_LIMIT");
  const tokenLimit = tokenLimits.length ? tokenLimits[tokenLimits.length - 1] : null;
  const sessionLimit = tokenLimits.length >= 2 ? tokenLimits[0] : null;
  const timeLimit = timeLimits.length ? timeLimits[timeLimits.length - 1] : null;
  const primary = sessionLimit || tokenLimit || timeLimit;

  const windows: ReturnType<typeof providerWindow>[] = [];
  if (primary) {
    windows.push(providerWindow(
      "zai-primary", sessionLimit ? "会话额度" : "额度", primary.percent,
      primary.reset, primary.window_minutes, zaiLimitDetail(primary)));
  }
  if (sessionLimit && tokenLimit) {
    windows.push(providerWindow(
      "zai-secondary", "周期额度", tokenLimit.percent, tokenLimit.reset,
      tokenLimit.window_minutes, zaiLimitDetail(tokenLimit)));
  }
  if (timeLimit && (tokenLimit || sessionLimit)) {
    windows.push(providerWindow(
      "zai-mcp", "MCP", timeLimit.percent, timeLimit.reset,
      timeLimit.window_minutes, zaiLimitDetail(timeLimit)));
  }

  const details: Array<Dict> = [];
  if (tokenLimit) {
    details.push({
      label: tokenLimit.raw.type === "CREDIT_LIMIT" ? "Credit quota" : "Token quota",
      value: `${gFormat(tokenLimit.percent)}% used`,
      secondary: zaiLimitDetail(tokenLimit),
    });
  }
  if (sessionLimit) {
    details.push({
      label: sessionLimit.raw.type === "CREDIT_LIMIT" ? "Session credit quota" : "Session token quota",
      value: `${gFormat(sessionLimit.percent)}% used`,
      secondary: zaiLimitDetail(sessionLimit),
    });
  }
  if (timeLimit) {
    details.push({
      label: "MCP quota", value: `${gFormat(timeLimit.percent)}% used`,
      secondary: zaiLimitDetail(timeLimit),
    });
    for (const rawItem of (timeLimit.details as unknown[]).slice(0, 20)) {
      const item = asDict(rawItem);
      if (!item || typeof item.modelCode !== "string") continue;
      const value = providerNumber(item.usage);
      if (value !== null && value >= 0) {
        details.push({ label: item.modelCode, value: Math.trunc(value).toLocaleString("en-US") });
      }
    }
  }

  // 只有 bigmodel-cn 才展示人民币账户余额；余额接口挂了不影响额度本身
  const balance = asDict(opts?.balance);
  if (region === "bigmodel-cn" && balance && balance.success === true) {
    const balanceData = asDict(balance.data) ?? {};
    const available = providerNumber(balanceData.availableBalance);
    const current = providerNumber(balanceData.balance);
    const amount = available !== null ? available : current;
    if (amount !== null) {
      const secondary: string[] = [];
      for (const [key, label] of [
        ["rechargeAmount", "recharged"], ["giveAmount", "granted"], ["totalSpendAmount", "spent"],
      ] as const) {
        const value = providerNumber(balanceData[key]);
        if (value !== null && (key !== "giveAmount" || value > 0)) {
          secondary.push(`${label} ¥${value.toFixed(2)}`);
        }
      }
      const row: Dict = { label: "Account balance", value: `¥${amount.toFixed(2)}` };
      if (secondary.length) row.secondary = secondary.join(" · ");
      details.push(row);
    }
  }

  let planName: string | null = null;
  for (const key of ["planName", "plan", "plan_type", "packageName", "level"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      planName = value.trim();
      break;
    }
  }
  return {
    available: Boolean(windows.length || details.length || planName),
    plan: planName,
    account: null,
    windows,
    details,
    source: "zai-api",
    updated: Math.trunc(opts?.updated ?? epochSeconds()),
    stale: false,
  };
}

/** 对应 fetch_zai_quota */
export async function fetchZaiQuota(deps: QuotaDeps): Promise<Dict> {
  const region = (providerConfigString("Z_AI_REGION", "zai_region", deps) || "global").toLowerCase();
  if (region !== "global" && region !== "bigmodel-cn") return {};
  const scope = (providerConfigString("Z_AI_USAGE_SCOPE", "zai_usage_scope", deps) || "personal").toLowerCase();
  if (scope !== "personal" && scope !== "team") return {};
  let apiKey = secretValue(deps, "Z_AI_API_KEY", "zai", "zai_api_key");
  // 国内区历史上叫 BIGMODEL_API_KEY，保留兜底 env 名（config 键同一个）
  if (!apiKey && region === "bigmodel-cn") apiKey = providerConfigString("BIGMODEL_API_KEY", "zai_api_key", deps);
  const organization = providerConfigString("Z_AI_ORGANIZATION", "zai_organization", deps);
  const project = providerConfigString("Z_AI_PROJECT", "zai_project", deps);
  if (!apiKey || (scope === "team" && (!organization || !project))) return {};

  const base = region === "bigmodel-cn" ? "https://open.bigmodel.cn" : "https://api.z.ai";
  const quotaUrl = zaiQuotaUrl(`${base}/api/monitor/usage/quota/limit`, scope);
  // marker 前缀是 zai-usage-v1：口径升版（比如窗口选择规则变了）时旧缓存自动作废
  const marker = providerCredentialMarker(
    "zai-usage-v1", apiKey, region, scope, organization, project, quotaUrl);
  const now = Math.trunc(deps.now());
  const cached = cachedProviderQuota("zai", marker, PROVIDER_QUOTA_TTL, now);
  if (cached) return cached;

  const headers: Dict = { Authorization: `Bearer ${apiKey}` };
  if (scope === "team") {
    headers["Bigmodel-Organization"] = organization as string;
    headers["Bigmodel-Project"] = project as string;
  }
  try {
    const payload = await deps.request(quotaUrl, { headers });
    let balance: unknown = null;
    if (region === "bigmodel-cn") {
      try {
        balance = await deps.request(
          "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
          { headers, timeoutSeconds: 5 });
      } catch {
        // 余额只是明细行，取不到不额度作废
      }
    }
    const quota = normalizeZaiQuota(payload, { region, balance });
    let usage = providerUsageFromDays({}, { limitedCoverage: "近30天" });
    try {
      // 模型曲线接口响应可能很大：15 秒超时 + 8MiB 上限，都高于默认档
      const modelPayload = await deps.request(zaiModelUsageUrl(base, scope, new Date(deps.now() * 1000)), {
        headers, timeoutSeconds: 15, maxBytes: 8 * 1024 * 1024,
      });
      usage = normalizeZaiModelUsage(modelPayload);
    } catch {
      // 曲线失败退回空用量
    }
    quota.usage = usage;
    saveProviderQuotaCache("zai", marker, quota, deps.now());
    return quota;
  } catch (error) {
    const fallback = cachedProviderQuota("zai", marker, PROVIDER_QUOTA_FALLBACK_TTL, now, true);
    if (fallback) return fallback;
    throw error;
  }
}

/** 对应 scan_zai_quota */
export async function scanZaiQuota(deps: QuotaDeps): Promise<Dict> {
  if (!providerQuotaEnabled("zai", deps)) return {};
  return fetchZaiQuota(deps);
}
