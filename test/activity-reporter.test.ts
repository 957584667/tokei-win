/**
 * 活跃安装统计（activityReporter.ts ← ActivityReporter.swift）。
 * 传输层一律注入假实现，一次真实请求都不发；状态文件写在临时目录。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ACTIVITY_ENDPOINT, ActivityReporter, HeartbeatRequest, releaseVersion, utcDay,
} from "../src/main/activityReporter";

let root: string;
let stateFile: string;
const FIXED_NOW = new Date("2026-10-20T23:41:07Z");

interface Seen { url: string; request: HeartbeatRequest }

function reporter(seen: Seen[], reply: { status: number; url: string } = { status: 204, url: ACTIVITY_ENDPOINT }) {
  return new ActivityReporter({
    stateFile,
    clock: () => FIXED_NOW,
    system: () => ({ name: "Windows", version: "10.0.26300" }),
    request: async (url, request) => {
      seen.push({ url, request });
      return reply;
    },
  });
}

function readState(): any {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-activity-"));
  stateFile = path.join(root, "Telemetry", "state.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("时间与版本的小工具", () => {
  it("utcDay 按 UTC 切日、releaseVersion 只剥开头那个 v", () => {
    expect(utcDay(new Date("2026-10-20T23:59:59Z"))).toBe("2026-10-20");
    expect(utcDay(new Date("2026-10-21T00:00:00Z"))).toBe("2026-10-21");
    expect(releaseVersion("v0.1.0")).toBe("0.1.0");
    expect(releaseVersion("0.1.0")).toBe("0.1.0");
    expect(releaseVersion("vfox")).toBe("fox");
  });
});

describe("reportLaunchIfNeeded", () => {
  it("开关关着：不发请求，也不建状态文件", async () => {
    const seen: Seen[] = [];
    expect(await reporter(seen).reportLaunchIfNeeded("0.1.0", false)).toBe(false);
    expect(seen).toHaveLength(0);
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it("首次启动：生成安装 ID、先落 lastAttemptAt、204 后补 lastSuccessfulDay", async () => {
    const seen: Seen[] = [];
    expect(await reporter(seen).reportLaunchIfNeeded("v0.1.0", true)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(ACTIVITY_ENDPOINT);
    expect(seen[0].request.method).toBe("POST");
    expect(seen[0].request.headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "Tokei/0.1.0",
    });
    const body = JSON.parse(seen[0].request.body);
    expect(Object.keys(body).sort()).toEqual(["app_version", "installation_id", "os_name", "os_version"]);
    expect(body).toMatchObject({ app_version: "0.1.0", os_name: "Windows", os_version: "10.0.26300" });
    expect(body.installation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // 发送那一刻状态文件已经写好「试过一次」，成功的那一天则是回执之后才补的
    const after = readState();
    expect(after.installationID).toBe(body.installation_id);
    expect(after.lastAttemptAt).toBe(FIXED_NOW.toISOString());
    expect(after.lastSuccessfulDay).toBe("2026-10-20");
  });

  it("同一个进程只试一次：第二发连传输都不碰", async () => {
    const seen: Seen[] = [];
    const r = reporter(seen);
    await r.reportLaunchIfNeeded("0.1.0", true);
    expect(await r.reportLaunchIfNeeded("0.1.0", true)).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("已经有安装 ID 就沿用，绝不换一个新的", async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      installationID: "0F0E0D0C-0B0A-4908-8706-050403020100", lastSuccessfulDay: "2026-10-19", lastAttemptAt: null,
    }));
    const seen: Seen[] = [];
    await reporter(seen).reportLaunchIfNeeded("0.1.0", true);
    // 上报用的小写，文件里保留原样（原版只对 payload 做 uuidString.lowercased()）
    expect(JSON.parse(seen[0].request.body).installation_id).toBe("0f0e0d0c-0b0a-4908-8706-050403020100");
    expect(readState().installationID).toBe("0F0E0D0C-0B0A-4908-8706-050403020100");
  });

  it("状态文件坏了：整趟作废，既不换 ID 也不发请求", async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{ 这不是 JSON");
    const seen: Seen[] = [];
    expect(await reporter(seen).reportLaunchIfNeeded("0.1.0", true)).toBe(false);
    expect(seen).toHaveLength(0);
    expect(fs.readFileSync(stateFile, "utf8")).toBe("{ 这不是 JSON");
  });

  it("状态文件是合法 JSON 但没有安装 ID：同样作废", async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastSuccessfulDay: "2026-10-18" }));
    const seen: Seen[] = [];
    expect(await reporter(seen).reportLaunchIfNeeded("0.1.0", true)).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("非 204 或最终 URL 不是端点：都不算成功", async () => {
    for (const reply of [
      { status: 200, url: ACTIVITY_ENDPOINT },
      { status: 500, url: ACTIVITY_ENDPOINT },
      { status: 204, url: "https://例外的域.example/heartbeat" },
    ]) {
      fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
      const seen: Seen[] = [];
      await reporter(seen, reply).reportLaunchIfNeeded("0.1.0", true);
      expect(seen).toHaveLength(1);
      expect(readState().lastSuccessfulDay).toBeNull();
    }
  });

  it("传输抛错只吞掉，应用与状态都不受影响", async () => {
    const r = new ActivityReporter({
      stateFile,
      clock: () => FIXED_NOW,
      system: () => ({ name: "Windows", version: "10.0.26300" }),
      request: async () => { throw new Error("timed out"); },
    });
    expect(await r.reportLaunchIfNeeded("0.1.0", true)).toBe(true);
    expect(readState().lastAttemptAt).toBe(FIXED_NOW.toISOString());
    expect(readState().lastSuccessfulDay).toBeNull();
  });

  it("端点不是 https 就一个请求都不发", async () => {
    const seen: Seen[] = [];
    const r = new ActivityReporter({
      stateFile,
      endpoint: "http://tokei-ops.lanshuagent.com/v1/heartbeat",
      clock: () => FIXED_NOW,
      request: async (url, request) => { seen.push({ url, request }); return { status: 204, url }; },
    });
    expect(await r.reportLaunchIfNeeded("0.1.0", true)).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("关掉开关会掐断在跑的那一发，晚到的 204 不补记成功日", async () => {
    let release: ((reply: { status: number; url: string }) => void) | null = null;
    let signal: AbortSignal | null = null;
    const r = new ActivityReporter({
      stateFile,
      clock: () => FIXED_NOW,
      system: () => ({ name: "Windows", version: "10.0.26300" }),
      request: (url, request) => new Promise((resolve) => {
        signal = request.signal;
        release = resolve;
      }),
    });
    const pending = r.reportLaunchIfNeeded("0.1.0", true);
    r.preferencesChanged(false);
    expect(signal!.aborted).toBe(true);
    release!({ status: 204, url: ACTIVITY_ENDPOINT });
    await pending;
    expect(readState().lastSuccessfulDay).toBeNull();
    expect(readState().lastAttemptAt).toBe(FIXED_NOW.toISOString());
  });

  it("状态文件按 0600 落盘（POSIX 才量得到权限位）", async () => {
    await reporter([]).reportLaunchIfNeeded("0.1.0", true);
    if (process.platform !== "win32") {
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(stateFile)).toBe(true);
  });
});
