/**
 * 额度详情的仓储：对应 macOS 的 QuotaDetailRepository。
 *
 * 面板每次进「额度」页都要重算一份，而算这一份要把本机账本、sync/ 里每台 peer 的
 * 快照和锚点文件全过一遍，属于秒级开销；所以这里加 30 秒的新鲜期，正在算的时候不
 * 并发第二份（Swift 同语义：重入时只留一次强制补算）。失败只在 stderr 留痕，
 * 界面上继续用内存里/磁盘上那一份旧详情 —— 空白页比旧数据更容易被误读成「额度没了」。
 */
import { saveJson, loadJson } from "../core/paths";
import {
  QuotaDetailInput, QuotaDetailPayload, QuotaDetailRecalc, buildQuotaDetail, quotaDetailCacheFile,
} from "../core/quotaDetail";

/** 对应 QuotaDetailRepository 的 freshness：30 秒内的结果直接复用 */
export const QUOTA_DETAIL_FRESH_SECONDS = 30;

/** 主进程把「这一轮的 payload + 扫描缓存」交出来的方式：核心层自己不碰进程外状态 */
export interface QuotaDetailSource {
  payload(): Record<string, any> | null;
  cache(): Record<string, any> | null;
  /** payload 落盘距今秒数（对应 last_usage.json 的 mtime age）；不给就当新鲜 */
  payloadAgeSeconds?(): number | null;
  /** 缓存脏时的重算回调；主进程没有同步的 compute 入口，通常不提供 */
  recalculate?(): QuotaDetailRecalc | null;
}

/**
 * 只在成功时解码：结构不对就当没有，免得半份 payload 把面板的周期表画歪。
 * 键名与 Python 完全一致（used_pct 那套 snake_case），渲染进程按字面解。
 */
export function decodeQuotaDetail(raw: unknown): QuotaDetailPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, any>;
  if (!Array.isArray(value.daily) || !Array.isArray(value.cycles)) return null;
  if (!Array.isArray(value.devices) || !Array.isArray(value.missing)) return null;
  if (typeof value.now !== "number" || !Number.isFinite(value.now)) return null;
  const daily = value.daily.filter((row: any) => row && typeof row.d === "string");
  const cycles = value.cycles.filter((row: any) => row && typeof row.tool === "string"
    && typeof row.start === "number" && typeof row.end === "number");
  if (daily.length !== value.daily.length || cycles.length !== value.cycles.length) return null;
  return {
    daily,
    cycles,
    devices: value.devices.filter((name: any) => typeof name === "string"),
    missing: value.missing.filter((name: any) => typeof name === "string"),
    now: Math.trunc(value.now),
  };
}

export class QuotaDetailStore {
  private cached: QuotaDetailPayload | null = null;
  private builtAt = 0;
  private inFlight: Promise<QuotaDetailPayload | null> | null = null;
  private pendingForce = false;

  constructor(
    private readonly source: QuotaDetailSource,
    private readonly file?: string,
  ) {}

  /** 对应 load(force:)：新鲜期内复用；正在算时强制请求攒一次补算，绝不并发第二轮 */
  async load(force = false): Promise<QuotaDetailPayload | null> {
    if (this.inFlight) {
      if (force) this.pendingForce = true;
      return this.inFlight;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!force && this.cached && now - this.builtAt < QUOTA_DETAIL_FRESH_SECONDS) return this.cached;

    const running = this.build(now);
    this.inFlight = running;
    let result: QuotaDetailPayload | null = null;
    try {
      result = await running;
    } finally {
      this.inFlight = null;
    }
    if (this.pendingForce) {
      this.pendingForce = false;
      // 跑起来的这一轮用的是发起时的 payload，强制请求得拿刷新后的那份重算一次
      return this.load(true);
    }
    return result;
  }

  private cacheFile(): string {
    return this.file ?? quotaDetailCacheFile();
  }

  private async build(now: number): Promise<QuotaDetailPayload | null> {
    try {
      const input: QuotaDetailInput = {
        payload: this.source.payload(),
        cache: this.source.cache(),
        payloadAgeSeconds: this.source.payloadAgeSeconds?.() ?? null,
        recalculate: this.source.recalculate ? () => (this.source.recalculate as () => QuotaDetailRecalc | null)() : null,
        now,
      };
      const detail = buildQuotaDetail(input);
      this.cached = detail;
      this.builtAt = now;
      if (!saveJson(this.cacheFile(), detail)) {
        console.error(`[tokei] 额度详情缓存写入失败: ${this.cacheFile()}`);
      }
      return detail;
    } catch (e: any) {
      console.error(`[tokei] 额度详情构建失败 ${e?.name ?? "Error"}: ${e?.message ?? e}`);
      return this.cached ?? this.readDisk();
    }
  }

  /** 失败兜底：磁盘那一份是上次成功的结果，读不出来才算真没有 */
  private readDisk(): QuotaDetailPayload | null {
    const decoded = decodeQuotaDetail(loadJson<unknown>(this.cacheFile(), null));
    if (!decoded) return null;
    this.cached = decoded;
    return decoded;
  }
}
