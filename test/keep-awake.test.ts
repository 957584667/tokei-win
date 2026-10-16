/**
 * 防休眠的行为规格：逐条对应 KeepAwake.swift。
 * 电源断言、电池读数都注成假件 —— 跑测试既不需要 Electron，也不需要真电池。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockerType, createKeepAwake } from "../src/main/keepAwake";

interface Fake {
  ka: ReturnType<typeof createKeepAwake>;
  started: BlockerType[];
  stopped: number[];
  changes: number;
  battery: ReturnType<typeof vi.fn>;
  setGuard: (on: boolean) => void;
}

function makeFake(battery: { pct: number; charging: boolean } | null): Fake {
  let nextId = 1;
  let guard = true;
  const f: Partial<Fake> = { started: [], stopped: [], changes: 0, battery: vi.fn(async () => battery) };
  const ka = createKeepAwake({
    startBlocker: (t) => { (f.started as BlockerType[]).push(t); return nextId++; },
    stopBlocker: (id) => { (f.stopped as number[]).push(id); },
    readBattery: f.battery!,
    lowBatteryGuard: () => guard,
    onChange: () => { f.changes = (f.changes as number) + 1; },
  });
  f.ka = ka;
  f.setGuard = (on: boolean) => { guard = on; };
  return f as Fake;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00"));
});

describe("防休眠断言", () => {
  it("保持亮屏时同时挡住关屏与系统睡眠（KA:41-46）", () => {
    const f = makeFake(null);
    f.ka.start(null);
    expect(f.started).toEqual(["prevent-display-sleep", "prevent-app-suspension"]);
    expect(f.ka.snapshot()).toMatchObject({ active: true, endsAt: null, allowDisplaySleep: false });
  });

  it("允许关屏只留一条系统睡眠断言（KA:44 的 if 分支）", () => {
    const f = makeFake(null);
    f.ka.setMode(true);
    f.ka.start(null);
    expect(f.started).toEqual(["prevent-app-suspension"]);
  });

  it("stop 会把起过的断言全部释放", () => {
    const f = makeFake(null);
    f.ka.start(null);
    f.ka.stop();
    expect(f.stopped).toEqual([1, 2]);
    expect(f.ka.snapshot().active).toBe(false);
  });

  it("左键：关→开→关（KA:31 的 toggle）", () => {
    const f = makeFake(null);
    f.ka.toggle();
    expect(f.ka.snapshot().active).toBe(true);
    f.ka.toggle();
    expect(f.ka.snapshot().active).toBe(false);
  });

  it("定时到点自己关，无限期不受定时器影响", async () => {
    const f = makeFake(null);
    f.ka.start(15);
    expect(f.ka.snapshot().endsAt).toBe(Date.now() + 15 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(f.ka.snapshot()).toMatchObject({ active: false, endsAt: null });

    f.ka.start(null);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.ka.snapshot().active).toBe(true);
  });

  it("运行中换模式：重建断言并保留剩余时长（KA:88-95）", () => {
    const f = makeFake(null);
    f.ka.start(60);
    const endsAt = f.ka.snapshot().endsAt;
    vi.advanceTimersByTime(10 * 60_000);
    f.started = [];
    f.ka.setMode(true);
    expect(f.started).toEqual(["prevent-app-suspension"]);
    // 剩 50 分钟，按分钟取整后落到新的 endsAt 上，误差只来自毫秒取整
    expect(Math.abs((f.ka.snapshot().endsAt as number) - (endsAt as number))).toBeLessThan(60_000);
  });

  it("低电量保护：未充电且 ≤20% 就自动关（KA:100-103）", async () => {
    const f = makeFake({ pct: 18, charging: false });
    f.ka.start(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.ka.snapshot().active).toBe(false);
  });

  it("接着电源或电量充足都不关", async () => {
    const charging = makeFake({ pct: 18, charging: true });
    charging.ka.start(null);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(charging.ka.snapshot().active).toBe(true);

    const plenty = makeFake({ pct: 80, charging: false });
    plenty.ka.start(null);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(plenty.ka.snapshot().active).toBe(true);
  });

  it("关掉保护后不再轮询电池（KA:64-67）", async () => {
    const f = makeFake({ pct: 18, charging: false });
    f.setGuard(false);
    f.ka.start(null);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.battery).not.toHaveBeenCalled();
    expect(f.ka.snapshot().active).toBe(true);
  });

  it("台式机读不到电池时保护形同不存在", async () => {
    const f = makeFake(null);
    f.ka.start(null);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.ka.snapshot().active).toBe(true);
  });
});
