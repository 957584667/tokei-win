/**
 * 「总量」口径测试：Swift 每个族有自己的计算属性，展示层必须逐族对齐，
 * 否则托盘提示与面板卡片会比 macOS 多算或少算一段 token。
 */
import { describe, expect, it } from "vitest";
import { displayTokenTotal } from "../src/core/model";

describe("displayTokenTotal", () => {
  it("Claude：in+out+cr+cw，没有 reason 字段", () => {
    expect(displayTokenTotal({ in: 10, out: 4, cr: 3, cw: 2 }, "claude")).toBe(19);
  });

  it("Codex：in+cached+out，reason 是 out 的子集不算", () => {
    expect(displayTokenTotal({ in: 10, cached: 6, out: 4, reason: 3 }, "codex")).toBe(20);
  });

  it("Gemini：in+out+cached+thoughts", () => {
    expect(displayTokenTotal({ in: 10, out: 4, cached: 6, thoughts: 2 }, "gemini")).toBe(22);
  });

  it("Qoder IDE：in+out+cached", () => {
    expect(displayTokenTotal({ in: 10, out: 4, cached: 6 }, "qoder")).toBe(20);
  });

  it("Qoder CLI 族（QoderRange）：in+out+cr+cw", () => {
    expect(displayTokenTotal({ in: 10, out: 4, cr: 3, cw: 2, credits: 1 }, "qodercli")).toBe(19);
  });

  it("QoderWork：只有 in+out", () => {
    expect(displayTokenTotal({ in: 10, out: 4, duration: 1000 }, "qoderwork")).toBe(14);
  });

  it("Grok / TokenUsage：tokens 优先于分项", () => {
    expect(displayTokenTotal({ tokens: 99, in: 10, out: 4, cr: 3, cw: 2, reason: 1 }, "grok")).toBe(99);
    expect(displayTokenTotal({ tokens: 0, in: 10, out: 4, cr: 3, cw: 2, reason: 1 }, "zed")).toBe(20);
  });

  it("Hermes 计入 reason，OpenClaw / Muse 不计（reason 已在 out 里）", () => {
    const range = { in: 10, out: 4, cr: 3, cw: 2, reason: 5 };
    expect(displayTokenTotal(range, "hermes")).toBe(24);
    expect(displayTokenTotal(range, "openclaw")).toBe(19);
    expect(displayTokenTotal(range, "musecode")).toBe(19);
  });

  it("缺字段按 0 处理，不产生 NaN", () => {
    expect(displayTokenTotal({ in: 7 }, "opencode")).toBe(7);
    expect(displayTokenTotal({}, "pi")).toBe(0);
  });
});
