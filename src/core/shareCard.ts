/**
 * 分享卡的数据：对应 UsageSummaryBuilder 的 toolLines / totals / formatUpdatedLine，
 * 尺寸对应 UsageShareImage 的 multiWidth 380 / singleWidth 340（渲染端再按 2x 放大）。
 *
 * 这里只出原始数值与文案，不碰任何窗口：主进程拿到 spec 后再用隐藏窗口画成 PNG。
 * 工具顺序、每张卡取哪几个数、什么时候省略某一格，都按 Swift 那份 builder 逐条抄。
 */

export const SHARE_MULTI_WIDTH = 380;
export const SHARE_SINGLE_WIDTH = 340;

export const RANGE_LABELS: Record<string, string> = {
  today: "今日", yesterday: "昨日", week: "本周", last_week: "上周", month: "本月", year: "本年",
};

export interface ShareLine {
  id: string;
  name: string;
  /** 卡片圆点与强调色：渲染端不自带调色板 */
  tint: string;
  cost?: number;
  costCny?: number;
  tokens?: number;
  sessions?: number;
  calls?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reason?: number;
  hit?: number;
  extra?: string;
}

export interface ShareTotals {
  cost: number;
  costCny: number;
  tokens: number;
  sessions: number;
  calls: number;
  tools: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reason: number;
}

export interface ShareSpec {
  kind: "overview" | "tool";
  /** 逻辑像素宽度（multiWidth / singleWidth） */
  width: number;
  /** 面板字号倍率（小 1 / 大 1.12），分享卡里的文字跟面板一样缩放 */
  fontScale: number;
  title: string;
  subtitle: string;
  rangeLabel: string;
  updatedLine: string | null;
  lines: ShareLine[];
  totals: ShareTotals | null;
  /** 单工具卡页头那个会话胶囊；0/未给就不画 */
  sessions: number | null;
}

/** 对应 UsageShareImage.tint(for:)：颜色取我们与面板一致的那份色板 */
const META: Record<string, { name: string; tint: string }> = {
  claude: { name: "Claude Code", tint: "#eb8566" },
  codex: { name: "Codex", tint: "#6badfa" },
  codex_reserve: { name: "Luna Reserve", tint: "#6badfa" },
  gemini: { name: "Gemini", tint: "#9e85eb" },
  grok: { name: "Grok", tint: "#a6adbf" },
  grok_bot: { name: "Grok Bot", tint: "#f266a3" },
  qoder: { name: "Qoder Desktop", tint: "#e6bf59" },
  qoderwork: { name: "QoderWork", tint: "#bfa64d" },
  qodercli: { name: "Qoder CLI", tint: "#f5d673" },
  qodercli_cn: { name: "Qoder CN", tint: "#fa9e59" },
  hermes: { name: "Hermes", tint: "#66d199" },
  zcode: { name: "ZCode", tint: "#85cc57" },
  mimocode: { name: "MiMoCode", tint: "#f28042" },
  openclaw: { name: "OpenClaw", tint: "#d973ad" },
  pi: { name: "Pi", tint: "#bd94f2" },
  prime_agent: { name: "Prime Agent", tint: "#f59447" },
  workbuddy: { name: "WorkBuddy", tint: "#40c7b8" },
  workbuddy_ai: { name: "WorkBuddy Intl.", tint: "#5ca8f0" },
  codebuddy: { name: "CodeBuddy", tint: "#7594f5" },
  deepseek_harness: { name: "DeepSeek Harness", tint: "#2e94f0" },
  opencode: { name: "OpenCode", tint: "#8cbfe6" },
  qwencode: { name: "Qwen Code", tint: "#7a8cf2" },
  kimicode: { name: "Kimi Code", tint: "#33c7a8" },
  musecode: { name: "Muse Code", tint: "#1a6beb" },
  cmdcode: { name: "Command Code", tint: "#38ad52" },
  devin: { name: "Devin", tint: "#6b78fa" },
  minimax: { name: "MiniMax Code", tint: "#e84066" },
};

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const positive = (v: unknown): number | undefined => (n(v) > 0 ? n(v) : undefined);

function isDict(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rangeOf(payload: Record<string, any>, tool: string, range: string): Record<string, any> {
  const r = payload?.[tool]?.ranges?.[range];
  return isDict(r) ? r : {};
}

/** 对应 Fmt.credits（Model.swift:1243） */
export function creditsText(value: unknown): string {
  const v = n(value);
  if (Math.abs(Math.round(v) - v) < 1e-6) return String(Math.round(v));
  return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** token 族的通用口径：in+out+cr+cw+reason（含 REASON_INSIDE_OUTPUT 的白名单） */
function tokenLine(id: string, name: string, r: Record<string, any>, opts: {
  includesCost?: boolean; includesCredits?: boolean; reasonIncludedInOutput?: boolean;
} = {}): ShareLine {
  const includesCost = opts.includesCost !== false;
  const total = n(r.in) + n(r.out) + n(r.cr) + n(r.cw)
    + (opts.reasonIncludedInOutput ? 0 : n(r.reason));
  const credits = opts.includesCredits && n(r.credits) > 0 ? `${creditsText(r.credits)} Credits` : undefined;
  return {
    id, name, tint: META[id].tint,
    cost: includesCost ? positive(r.cost) : undefined,
    costCny: includesCost ? positive(r.cost_cny) : undefined,
    tokens: total || undefined,
    sessions: positive(r.sessions),
    input: positive(r.in),
    output: positive(r.out),
    cacheRead: positive(r.cr),
    cacheWrite: positive(r.cw),
    reason: positive(r.reason),
    hit: positive(r.hit),
    extra: credits,
  };
}

/** 对应 Line.isEmpty：一项能讲的数都没有就不上分享卡 */
export function isEmptyLine(line: ShareLine): boolean {
  const parts = n(line.input) + n(line.output) + n(line.cacheRead) + n(line.cacheWrite) + n(line.reason);
  return n(line.tokens) <= 0 && n(line.sessions) <= 0 && n(line.calls) <= 0
    && n(line.cost) <= 0 && n(line.costCny) <= 0 && parts <= 0 && !line.extra;
}

/**
 * 对应 UsageSummaryBuilder.toolLines：顺序与每张卡取的字段照 Swift。
 * disabled 是设置里「显示卡片」勾掉的工具（同 macOS 的 toolVisibility）。
 */
export function shareLines(payload: Record<string, any>, range: string, disabled: string[] = []): ShareLine[] {
  const off = new Set(disabled);
  const vis = (id: string) => !off.has(id) && isDict(payload?.[id]);
  const lines: ShareLine[] = [];
  const push = (line: ShareLine) => { if (!isEmptyLine(line)) lines.push(line); };

  if (vis("claude")) {
    const r = rangeOf(payload, "claude", range);
    push({
      id: "claude", name: "Claude Code", tint: META.claude.tint,
      cost: positive(r.cost) ?? 0, // 成本 0 也画（对应 Swift 的 cost: r.cost）
      tokens: n(r.in) + n(r.out) + n(r.cr) + n(r.cw) || undefined,
      sessions: positive(r.sessions),
      input: positive(r.in), output: positive(r.out),
      cacheRead: positive(r.cr), cacheWrite: positive(r.cw),
      hit: positive(r.hit),
    });
  }
  if (vis("codex")) {
    const codex = (r: Record<string, any>, id: string, name: string) => push({
      id, name, tint: META[id].tint,
      cost: n(r.cost) > 0 ? n(r.cost) : undefined,
      tokens: n(r.in) + n(r.cached) + n(r.out) || undefined,
      sessions: positive(r.sessions),
      input: positive(r.in), output: positive(r.out),
      cacheRead: positive(r.cached),
      reason: positive(r.reason),
      hit: positive(r.hit),
    });
    codex(rangeOf(payload, "codex", range), "codex", "Codex");
    const reserve = payload?.codex?.reserve_ranges?.[range];
    if (isDict(reserve)) codex(reserve, "codex_reserve", "Luna Reserve");
  }
  if (vis("gemini")) {
    const r = rangeOf(payload, "gemini", range);
    push({
      id: "gemini", name: "Gemini", tint: META.gemini.tint,
      cost: n(r.cost) > 0 ? n(r.cost) : undefined,
      tokens: n(r.in) + n(r.cached) + n(r.out) + n(r.thoughts) || undefined,
      sessions: positive(r.sessions),
      input: positive(r.in), output: positive(r.out),
      cacheRead: positive(r.cached),
      reason: positive(r.thoughts),
      hit: positive(r.hit),
    });
  }
  if (vis("grok")) {
    const r = rangeOf(payload, "grok", range);
    const available = r.usage_available === true;
    push({
      id: "grok", name: "Grok", tint: META.grok.tint,
      cost: n(r.cost) > 0 ? n(r.cost) : undefined,
      tokens: (available ? n(r.in) + n(r.out) + n(r.cr) + n(r.reason) : n(r.tokens)) || undefined,
      sessions: Math.max(n(r.sessions), n(r.usage_sessions)) || undefined,
      calls: positive(r.usage_calls),
      input: available ? positive(r.in) : undefined,
      output: available ? positive(r.out) : undefined,
      cacheRead: available ? positive(r.cr) : undefined,
      reason: available ? positive(r.reason) : undefined,
      hit: available ? positive(r.hit) : undefined,
    });
  }
  if (vis("grok_bot")) {
    const r = rangeOf(payload, "grok_bot", range);
    // 账号级 usage 在 payload 里叫 quota.usage；没有就按 Swift 的 TokenUsageRange() 空表走
    const account = payload?.grok_bot?.quota?.usage?.ranges?.[range];
    const a = isDict(account) ? account : {};
    push({
      id: "grok_bot", name: "Grok Bot", tint: META.grok_bot.tint,
      cost: n(a.cost) > 0 ? n(a.cost) : undefined,
      tokens: n(a.totalTokens ?? a.tokens) > 0 ? n(a.totalTokens ?? a.tokens) : undefined,
      sessions: positive(r.sessions),
      calls: n(a.requests) > 0 ? n(a.requests) : positive(r.calls),
      input: n(a.in) > 0 ? n(a.in) : undefined,
      output: n(a.out) > 0 ? n(a.out) : undefined,
      cacheRead: positive(a.cr),
      cacheWrite: positive(a.cw),
      extra: n(r.turns) > 0 ? `${n(r.turns)} 条消息` : undefined,
    });
  }
  if (vis("qoder")) {
    const r = rangeOf(payload, "qoder", range);
    push({
      id: "qoder", name: "Qoder Desktop", tint: META.qoder.tint,
      tokens: n(r.in) + n(r.cached) + n(r.out) || undefined,
      sessions: positive(r.sessions),
      calls: positive(r.calls),
      input: positive(r.in), output: positive(r.out),
      cacheRead: positive(r.cached),
      hit: positive(r.ctx),
    });
  }
  if (vis("qoderwork")) {
    const r = rangeOf(payload, "qoderwork", range);
    push({
      id: "qoderwork", name: "QoderWork", tint: META.qoderwork.tint,
      tokens: n(r.in) + n(r.out) || undefined,
      sessions: positive(r.sessions),
      calls: positive(r.calls),
      input: positive(r.in), output: positive(r.out),
    });
  }
  for (const [id, name] of [["qodercli", "Qoder CLI"], ["qodercli_cn", "Qoder CN"]] as const) {
    if (!vis(id)) continue;
    const r = rangeOf(payload, id, range);
    push({
      id, name, tint: META[id].tint,
      tokens: n(r.in) + n(r.out) + n(r.cr) + n(r.cw) || undefined,
      sessions: positive(r.sessions),
      calls: positive(r.calls),
      input: positive(r.in), output: positive(r.out),
      cacheRead: positive(r.cr), cacheWrite: positive(r.cw),
      hit: positive(r.hit),
      extra: n(r.credits) > 0 ? `${creditsText(r.credits)} Credits` : undefined,
    });
  }
  if (vis("hermes")) {
    const r = rangeOf(payload, "hermes", range);
    push({
      id: "hermes", name: "Hermes", tint: META.hermes.tint,
      cost: positive(r.cost) ?? 0,
      tokens: n(r.in) + n(r.out) + n(r.cr) + n(r.cw) + n(r.reason) || undefined,
      sessions: positive(r.sessions),
      input: positive(r.in), output: positive(r.out),
      cacheRead: positive(r.cr), cacheWrite: positive(r.cw),
      reason: positive(r.reason),
      hit: positive(r.hit),
    });
  }
  for (const [id, name] of [["zcode", "ZCode"], ["mimocode", "MiMoCode"]] as const) {
    if (vis(id)) push(tokenLine(id, name, rangeOf(payload, id, range)));
  }
  if (vis("openclaw")) {
    const r = rangeOf(payload, "openclaw", range);
    push({
      id: "openclaw", name: "OpenClaw", tint: META.openclaw.tint,
      cost: positive(r.cost) ?? 0,
      tokens: n(r.in) + n(r.out) + n(r.cr) + n(r.cw) + n(r.reason) || undefined,
      sessions: positive(r.sessions),
      calls: positive(r.tasks),
      input: positive(r.in), output: positive(r.out),
      cacheRead: positive(r.cr), cacheWrite: positive(r.cw),
      reason: positive(r.reason),
      hit: positive(r.hit),
    });
  }
  for (const [id, name] of [
    ["pi", "Pi"], ["prime_agent", "Prime Agent"], ["workbuddy", "WorkBuddy"],
    ["workbuddy_ai", "WorkBuddy Intl."], ["codebuddy", "CodeBuddy"],
    ["deepseek_harness", "DeepSeek Harness"], ["opencode", "OpenCode"],
    ["qwencode", "Qwen Code"], ["kimicode", "Kimi Code"], ["musecode", "Muse Code"],
    ["cmdcode", "Command Code"], ["devin", "Devin"], ["minimax", "MiniMax Code"],
  ] as const) {
    if (!vis(id)) continue;
    push(tokenLine(id, name, rangeOf(payload, id, range), {
      // Kimi 的卡片刻意不显示成本：分享图里也不能凭空冒出来
      includesCost: id !== "kimicode",
      includesCredits: id === "codebuddy",
      reasonIncludedInOutput: id === "musecode",
    }));
  }
  return lines;
}

/** 对应 UsageSummaryBuilder.totals */
export function shareTotals(lines: ShareLine[]): ShareTotals {
  const sum = (pick: (line: ShareLine) => number | undefined) => lines.reduce((acc, line) => acc + n(pick(line)), 0);
  return {
    cost: sum((l) => l.cost),
    costCny: sum((l) => l.costCny),
    tokens: sum((l) => l.tokens),
    sessions: sum((l) => l.sessions),
    calls: sum((l) => l.calls),
    tools: lines.length,
    input: sum((l) => l.input),
    output: sum((l) => l.output),
    cacheRead: sum((l) => l.cacheRead),
    cacheWrite: sum((l) => l.cacheWrite),
    reason: sum((l) => l.reason),
  };
}

/**
 * 对应 formatUpdatedLine：只认「更新 …」这种成功读数；加载中/预览/失败一律不写。
 * 这里不做多语言前缀表，只处理我们自己产生的「更新 HH:mm:ss」。
 */
export function formatUpdatedLine(updated?: string | null): string | null {
  const text = (updated ?? "").trim();
  if (!text) return null;
  if (text === "加载失败" || text === "预览" || text.startsWith("加载中")) return null;
  let body = text;
  for (const prefix of ["更新于 ", "更新 "]) {
    if (body.startsWith(prefix)) { body = body.slice(prefix.length).trim(); break; }
  }
  return body ? `更新于 ${body}` : null;
}

export interface ShareSpecInput {
  payload: Record<string, any> | null;
  range: string;
  disabled?: string[];
  kind: "overview" | "tool";
  toolId?: string | null;
  /** 表头「更新 HH:mm:ss」那一句（对应 store.lastUpdated） */
  updated?: string | null;
  fontScale?: number;
}

/** 组出一张分享卡要画的全部内容；数据来自主进程手上的 payload，不经过渲染进程 */
export function buildShareSpec(input: ShareSpecInput): ShareSpec {
  const range = input.range in RANGE_LABELS ? input.range : "today";
  const rangeLabel = RANGE_LABELS[range];
  const payload = isDict(input.payload) ? input.payload : {};
  const lines = shareLines(payload, range, input.disabled ?? []);
  const updatedLine = formatUpdatedLine(input.updated);
  const base = { rangeLabel, updatedLine, fontScale: input.fontScale ?? 1 };

  if (input.kind === "tool") {
    const line = lines.find((item) => item.id === input.toolId);
    return {
      ...base,
      kind: "tool",
      width: SHARE_SINGLE_WIDTH,
      title: line?.name ?? "Tokei",
      subtitle: `Tokei · ${rangeLabel}`,
      lines: line ? [line] : [],
      totals: null,
      sessions: line?.sessions ?? null,
    };
  }
  return {
    ...base,
    kind: "overview",
    width: SHARE_MULTI_WIDTH,
    title: "Tokei 用量",
    subtitle: rangeLabel,
    lines,
    totals: lines.length ? shareTotals(lines) : null,
    sessions: null,
  };
}
