/**
 * Dashboard 的仓储：对应 macOS 的 DashboardRepository。
 *
 * 与额度详情同一个道理：一份面板数据要把本机 22 个工具的缓存与账本全过一遍，
 * 而界面每切一次区间就会要一份，所以按区间各留 30 秒新鲜期；同一区间正在算的时候
 * 不并发第二份，只攒一次强制补算（Swift 里是 forcedReloadPending）。
 * 失败时保留上一份结果、只往 stderr 留痕 —— 空白页比旧数据更容易被误读成「没用量」。
 */
import { buildDashboard, DashboardPayload } from "../core/dashboard";

/** 对应 DashboardRepository.freshness */
export const DASHBOARD_FRESH_SECONDS = 30;

export type DashboardPeriod = "1d" | "7d" | "30d" | "365d" | "all";

export interface DashboardSource {
  /** 主进程内存里的扫描缓存；日账保留键就写在这张表里 */
  cache(): Record<string, any>;
}

export function isDashboardPeriod(value: unknown): value is DashboardPeriod {
  return value === "1d" || value === "7d" || value === "30d" || value === "365d" || value === "all";
}

export class DashboardStore {
  private readonly payloads = new Map<string, DashboardPayload>();
  private readonly loadedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<DashboardPayload | null>>();
  private readonly pendingForce = new Set<string>();

  constructor(private readonly source: DashboardSource) {}

  /** 对应 payload(for:)：算过的区间直接给 */
  peek(period: DashboardPeriod): DashboardPayload | null {
    return this.payloads.get(period) ?? null;
  }

  /** 对应 load(period, force:)：新鲜期内复用；正在算时强制请求攒一次补算，绝不并发第二轮 */
  load(period: DashboardPeriod, force = false): Promise<DashboardPayload | null> {
    const running = this.inFlight.get(period);
    if (running) {
      if (force) this.pendingForce.add(period);
      // 等的是「这一整轮」，补算也算在内：Swift 那边大家看的是同一份发布出来的 payload，
      // 不能让排队的调用者拿到补算之前的旧那份。
      return running;
    }
    const cycle = this.run(period, force);
    this.inFlight.set(period, cycle);
    void cycle.finally(() => this.inFlight.delete(period));
    return cycle;
  }

  private async run(period: DashboardPeriod, force: boolean): Promise<DashboardPayload | null> {
    const now = Math.floor(Date.now() / 1000);
    if (!force && this.payloads.has(period) && now - (this.loadedAt.get(period) ?? 0) < DASHBOARD_FRESH_SECONDS) {
      return this.payloads.get(period) ?? null;
    }
    const payload = await this.build(period, now);
    if (this.pendingForce.delete(period)) {
      // 跑起来的这一轮用的是发起时的缓存，强制请求得拿刷新后的缓存重算一次
      return this.run(period, true);
    }
    return payload;
  }

  private async build(period: DashboardPeriod, now: number): Promise<DashboardPayload | null> {
    try {
      const payload = buildDashboard(this.source.cache(), period, new Date(now * 1000));
      this.payloads.set(period, payload);
      this.loadedAt.set(period, now);
      return payload;
    } catch (e: any) {
      console.error(`[tokei] 面板数据构建失败 ${e?.name ?? "Error"}: ${e?.message ?? e}`);
      return this.payloads.get(period) ?? null;
    }
  }
}
