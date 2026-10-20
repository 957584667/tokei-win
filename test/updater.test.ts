/**
 * 更新器状态机（updater.ts ← Updater.swift）。
 * 元数据、下载、摘要、安装器全部注入假实现：一次真实请求都不发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Updater, UpdateState, MetadataResponse, UpdateWorkspace, UpdaterOptions } from "../src/main/updater";

const META = "https://dl.lanshuagent.com/tokei/latest.json";
const GITHUB = "https://api.github.com/repos/cclank/tokei/releases/latest";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const EXE = "https://github.com/cclank/tokei/releases/download/v0.2.0/Tokei-Setup.exe";

function release(tag = "v0.2.0", digest: string | null = SHA): Record<string, any> {
  const asset: Record<string, any> = { name: "Tokei-Setup.exe", browser_download_url: EXE };
  if (digest) asset.digest = `sha256:${digest}`;
  return { tag_name: tag, assets: [asset] };
}

function response(json: Record<string, any>, status = 200, finalURL = META): MetadataResponse {
  return { status, finalURL, body: JSON.stringify(json) };
}

interface Harness {
  updater: Updater;
  states: UpdateState[];
  downloads: string[];
  installed: string[];
  quits: number;
  roots: string[];
}

let tmp: string;

function harness(
  routes: Record<string, () => MetadataResponse | Promise<MetadataResponse>>,
  overrides: Partial<UpdaterOptions> = {},
): Harness {
  const states: UpdateState[] = [];
  const downloads: string[] = [];
  const installed: string[] = [];
  const roots: string[] = [];
  const box = { quits: 0 };
  const workspace = (_release: any): UpdateWorkspace => {
    const directory = fs.mkdtempSync(path.join(tmp, "ws-"));
    roots.push(directory);
    return { directory, file: path.join(directory, "Tokei-Setup.exe") };
  };
  const updater = new Updater({
    currentVersion: "v0.1.0",
    metadataURLs: [META, GITHUB],
    metadata: async (url) => {
      const route = routes[url];
      if (!route) throw new Error("没有这个来源");
      return route();
    },
    download: async (url, destination, onProgress) => {
      downloads.push(url);
      onProgress(0.5);
      onProgress(0.6);
      fs.writeFileSync(destination, "installer-bytes");
      return { finalURL: url };
    },
    digest: async () => SHA,
    workspace,
    launchInstaller: async (file) => { installed.push(file); },
    onQuit: () => { box.quits += 1; },
    onState: (state) => states.push(state),
    ...overrides,
  });
  return {
    updater, states, downloads, installed, roots,
    get quits() { return box.quits; },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-update-test-"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("检查更新", () => {
  it("本地验证版：自动检查一次请求都不发，手动检查照常", async () => {
    let calls = 0;
    const h = harness({ [META]: () => { calls += 1; return response(release()); } }, { isLocalBuild: true });
    await h.updater.checkForUpdate(false);
    expect(calls).toBe(0);
    expect(h.updater.state).toEqual({ kind: "idle" });

    await h.updater.checkForUpdate(true);
    expect(calls).toBe(1);
    expect(h.updater.state).toEqual({ kind: "available", tag: "v0.2.0" });
  });

  it("第一个来源失败不挡第二个，最终取更大的 tag", async () => {
    const h = harness({
      [META]: () => { throw new Error("超时"); },
      [GITHUB]: () => response(release("v0.3.0")),
    });
    await h.updater.checkForUpdate(true);
    expect(h.updater.state).toEqual({ kind: "available", tag: "v0.3.0" });
    expect(h.states[0]).toEqual({ kind: "checking" });
  });

  it("非 2xx、坏 JSON、没有 tag 的来源都跳过", async () => {
    const h = harness({
      [META]: () => ({ status: 500, finalURL: META, body: "{}" }),
      [GITHUB]: () => ({ status: 200, finalURL: GITHUB, body: "not json" }),
    });
    await h.updater.checkForUpdate(true);
    expect(h.updater.state).toEqual({ kind: "failed", message: "网络不可用" });
  });

  it("比本地新但只有 DMG：不算 Windows 更新，显示已是最新并在 3 秒后回 idle", async () => {
    vi.useFakeTimers();
    const h = harness({
      [META]: () => response({
        tag_name: "v1.0.46",
        download_url: "https://dl.lanshuagent.com/tokei/Tokei-v1.0.46.dmg",
        sha256: SHA,
      }),
    });
    await h.updater.checkForUpdate(true);
    expect(h.updater.state).toEqual({ kind: "upToDate" });
    vi.advanceTimersByTime(3000);
    expect(h.updater.state).toEqual({ kind: "idle" });
  });

  it("有 Windows 包但缺摘要：报更新信息不完整，5 秒后回 idle", async () => {
    vi.useFakeTimers();
    const h = harness({ [META]: () => response(release("v0.2.0", null)) });
    await h.updater.checkForUpdate(true);
    expect(h.updater.state).toEqual({ kind: "failed", message: "更新信息不完整" });
    vi.advanceTimersByTime(5000);
    expect(h.updater.state).toEqual({ kind: "idle" });
  });

  it("元数据来源不在白名单时连传输层都不进", async () => {
    const metadata = vi.fn(async () => response(release()));
    const h = harness({}, { metadataURLs: ["https://evil.example/latest.json"], metadata });
    await h.updater.checkForUpdate(true);
    expect(metadata).not.toHaveBeenCalled();
    expect(h.updater.state).toEqual({ kind: "failed", message: "网络不可用" });
  });

  it("检查中再点不会并发起第二轮", async () => {
    let resolveMeta: (value: MetadataResponse) => void = () => {};
    const h = harness({
      [META]: () => new Promise<MetadataResponse>((resolve) => { resolveMeta = resolve; }),
    });
    const first = h.updater.checkForUpdate(true);
    await h.updater.checkForUpdate(true);
    expect(h.states.filter((s) => s.kind === "checking")).toHaveLength(1);
    resolveMeta(response(release()));
    await first;
  });
});

describe("下载与安装", () => {
  async function available(overrides: Partial<UpdaterOptions> = {}) {
    const h = harness({ [META]: () => response(release()) }, overrides);
    await h.updater.checkForUpdate(true);
    expect(h.updater.state).toEqual({ kind: "available", tag: "v0.2.0" });
    return h;
  }

  it("下载进度按 1% 节流，校验通过后起安装器，0.3 秒后退出", async () => {
    vi.useFakeTimers();
    const h = await available();
    await h.updater.performUpdate();
    expect(h.downloads).toEqual([EXE]);
    expect(h.installed).toHaveLength(1);
    expect(fs.existsSync(h.installed[0])).toBe(true);
    expect(h.updater.state).toEqual({ kind: "installing" });
    expect(h.quits).toBe(0);
    vi.advanceTimersByTime(299);
    expect(h.quits).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.quits).toBe(1);
    const progress = h.states.filter((s) => s.kind === "downloading").map((s: any) => s.progress);
    expect(progress).toEqual([0, 0.5, 0.6]);
  });

  it("sha256 不一致：报校验失败、不启动安装器、临时目录清掉", async () => {
    const h = await available({ digest: async () => OTHER_SHA });
    await h.updater.performUpdate();
    expect(h.updater.state).toEqual({ kind: "failed", message: "更新包校验失败" });
    expect(h.installed).toEqual([]);
    expect(h.roots.every((dir) => !fs.existsSync(dir))).toBe(true);
  });

  it("下载最终跳到白名单外的域：更新地址不受信任", async () => {
    const h = await available({
      download: async (_url, destination) => {
        fs.writeFileSync(destination, "x");
        return { finalURL: "https://evil.example/Tokei.exe" };
      },
    });
    await h.updater.performUpdate();
    expect(h.updater.state).toEqual({ kind: "failed", message: "更新地址不受信任" });
    expect(h.installed).toEqual([]);
    expect(h.roots.every((dir) => !fs.existsSync(dir))).toBe(true);
  });

  it("下载网络错误：短暂失败，5 秒后回 idle", async () => {
    vi.useFakeTimers();
    const h = await available({
      download: async () => { throw new Error("socket hang up"); },
    });
    await h.updater.performUpdate();
    expect(h.updater.state).toEqual({ kind: "failed", message: "socket hang up" });
    expect(h.installed).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(h.updater.state).toEqual({ kind: "idle" });
  });

  it("没有可升级版本时 performUpdate 什么都不做", async () => {
    const h = harness({});
    await h.updater.performUpdate();
    expect(h.downloads).toEqual([]);
    expect(h.installed).toEqual([]);
  });

  it("本地验证版在自动检查路径上不允许安装", async () => {
    const h = harness({ [META]: () => response(release()) }, { isLocalBuild: true });
    await h.updater.checkForUpdate(false);
    expect(h.updater.state).toEqual({ kind: "idle" });
    await h.updater.performUpdate();
    expect(h.installed).toEqual([]);
  });
});
