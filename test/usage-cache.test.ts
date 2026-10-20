/**
 * 开机垫的那份读数（main/usageCache.ts ← DataLoader.swift 的 loadCachedUsage）。
 * 夹具一律写在临时目录，绝不读开发者本机 ~/.tokei 里那份真实快照。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadCachedUsage } from "../src/main/usageCache";

let root: string;
let file: string;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function write(payload: unknown): void {
  fs.writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-usage-cache-"));
  file = path.join(root, "last_usage.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadCachedUsage 的取数", () => {
  it("没有快照、坏 JSON、顶层不是对象都算「没垫上」", () => {
    expect(loadCachedUsage(file)).toBeNull(); // 文件还不存在
    write("{ 不是 JSON");
    expect(loadCachedUsage(file)).toBeNull();
    write([1, 2, 3]);
    expect(loadCachedUsage(file)).toBeNull();
    write("42");
    expect(loadCachedUsage(file)).toBeNull();
  });

  it("剥掉所有下划线开头的内部键，其余原样端出来", () => {
    write({
      claude: { tokens: 10 },
      codex: { tokens: 20 },
      _ok: true,
      _at: 1234,
      _refresh_ms: 900,
      _device: { id: "pc" },
      _errors: { claude: "上一轮的错" },
      _pricing: { count: 507 },
    });
    const usage = loadCachedUsage(file)!;
    // 磁盘那份带着上一轮的 _ok/_at，留着就把旧时刻显示成「更新 HH:mm:ss」
    expect(Object.keys(usage).sort()).toEqual(["claude", "codex"]);
    expect(usage.codex).toEqual({ tokens: 20 });
  });

  it("claude 不是对象时不碰它，也不崩", () => {
    write({ claude: null, codex: { tokens: 1 } });
    expect(loadCachedUsage(file)).toEqual({ claude: null, codex: { tokens: 1 } });
    write({ claude: [1, 2] });
    expect(loadCachedUsage(file)).toEqual({ claude: [1, 2] });
  });
});

describe("垫进来前重算 Claude 的过期标记", () => {
  it("超 TTL 的旧读数在磁盘上写着 fresh，读回来必须判过期", () => {
    // 31 分钟前落盘：过了 1800 秒 TTL，但文件里那三个 stale 键是当时算的，全写着 false
    write({
      claude: {
        q_updated: nowSeconds() - 31 * 60,
        q5: 12, q5_reset: nowSeconds() + 3600, q5_stale: false,
        q7: 40, q7_reset: nowSeconds() + 86400, q7_stale: false,
        qf: 7, qf_reset: nowSeconds() + 86400, qf_stale: false,
      },
    });
    const claude = loadCachedUsage(file)!.claude;
    expect(claude.q5_stale).toBe(true);
    expect(claude.q7_stale).toBe(true);
    expect(claude.qf_stale).toBe(true);
    // 读数本身不动：垫的是上一轮的数值，托盘照旧画，只是画淡
    expect(claude.q5).toBe(12);
  });

  it("重置点已过的窗口判过期，即使整源还新鲜", () => {
    write({
      claude: {
        q_updated: nowSeconds() - 60,
        q5: 8, q5_reset: nowSeconds() - 5, q5_stale: false,
        q7: 33, q7_reset: nowSeconds() + 3600, q7_stale: true,
      },
    });
    const claude = loadCachedUsage(file)!.claude;
    expect(claude.q5_stale).toBe(true);
    // 整源没过期，磁盘上那句 stale=true 也按事实改回 false
    expect(claude.q7_stale).toBe(false);
  });

  it("q_updated 缺失、为零或落在未来都算整源过期", () => {
    for (const qUpdated of [undefined, 0, nowSeconds() + 600]) {
      write({ claude: { q5: 1, q5_reset: nowSeconds() + 3600, ...(qUpdated === undefined ? {} : { q_updated: qUpdated }) } });
      expect(loadCachedUsage(file)!.claude.q5_stale).toBe(true);
    }
  });

  it("值不在的窗口不会被造出读数，过期标记落回 false", () => {
    write({ claude: { q_updated: nowSeconds() - 60, q5_stale: true } });
    const claude = loadCachedUsage(file)!.claude;
    expect(claude.q5).toBeUndefined();
    expect(claude.q5_stale).toBe(false);
  });
});
