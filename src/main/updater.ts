/**
 * 更新器（对应 Tokei/Sources/Tokei/Updater.swift）。
 *
 * 与 macOS 的差别只有安装那一步：原版下载 DMG、写 install.sh、替换 .app；Windows 这里是
 * 下载并校验 .exe / .msi，交给系统安装器，然后退出本进程。校验规则（标签、sha256、
 * 域名白名单、只跟随白名单跳转）与原版一致。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";
import type { IncomingHttpHeaders } from "http";
import type { Readable } from "stream";
import {
  UpdateRelease, isAllowedDownloadResponseURL, isAllowedDownloadSourceURL, isAllowedMetadataURL,
  hasWindowsPackage, isNewerVersion, newestRelease, normalizedSHA256, releaseTag, sha256File,
  validatedRelease,
} from "../core/updateSecurity";

export const UPDATE_METADATA_URLS = [
  "https://dl.lanshuagent.com/tokei/latest.json",
  "https://api.github.com/repos/cclank/tokei/releases/latest",
];
/** 对应 Updater.automaticCheckInterval：6 小时 */
export const UPDATE_CHECK_INTERVAL = 6 * 3600 * 1000;
const CHECK_TIMEOUT = 10_000;
const DOWNLOAD_TIMEOUT = 300_000;
const METADATA_LIMIT = 1024 * 1024;
const REDIRECT_LIMIT = 5;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; tag: string }
  | { kind: "downloading"; progress: number }
  | { kind: "installing" }
  | { kind: "failed"; message: string };

export interface MetadataResponse {
  status: number;
  finalURL: string;
  body: string;
}

export interface DownloadResult {
  finalURL: string;
}

export interface UpdateWorkspace {
  directory: string;
  file: string;
}

export interface UpdaterOptions {
  /** 本地版本，带不带 v 都行 */
  currentVersion: string;
  /** 本地验证版：自动检查与自动安装都跳过，手动检查/升级仍可用 */
  isLocalBuild?: boolean;
  metadataURLs?: string[];
  metadata?: (url: string) => Promise<MetadataResponse>;
  download?: (url: string, destination: string, onProgress: (ratio: number) => void) => Promise<DownloadResult>;
  digest?: (file: string) => Promise<string>;
  workspace?: (release: UpdateRelease) => UpdateWorkspace;
  launchInstaller?: (file: string) => Promise<void> | void;
  onQuit?: () => void;
  onState?: (state: UpdateState) => void;
}

/** 安全/校验类失败：这些消息要原样给用户，不能退化成底层网络错误 */
class UpdateError extends Error {}

interface RawResponse {
  status: number;
  url: string;
  headers: IncomingHttpHeaders;
  stream: Readable;
}

function allowedForDownload(raw: string): boolean {
  return isAllowedDownloadResponseURL(raw);
}

function fetchFollowing(
  target: string,
  allow: (url: string) => boolean,
  headers: Record<string, string>,
  timeout: number,
  hops = 0,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(target, { headers, timeout }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (hops >= REDIRECT_LIMIT) {
          reject(new UpdateError("更新地址不受信任"));
          return;
        }
        let next: string;
        try {
          next = new URL(location, target).toString();
        } catch {
          reject(new UpdateError("更新地址不受信任"));
          return;
        }
        if (!allow(next)) {
          reject(new UpdateError("更新地址不受信任"));
          return;
        }
        resolve(fetchFollowing(next, allow, headers, timeout, hops + 1));
        return;
      }
      resolve({ status, url: target, headers: res.headers, stream: res });
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

async function defaultMetadata(url: string): Promise<MetadataResponse> {
  // GitHub API 对没有 User-Agent 的请求直接 403；URLSession 在 macOS 上会自动带一个。
  const res = await fetchFollowing(
    url,
    isAllowedMetadataURL,
    { Accept: "application/vnd.github+json", "User-Agent": "Tokei" },
    CHECK_TIMEOUT,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    res.stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > METADATA_LIMIT) {
        res.stream.destroy();
        reject(new Error("更新信息过大"));
        return;
      }
      chunks.push(chunk);
    });
    res.stream.on("end", resolve);
    res.stream.on("error", reject);
  });
  return { status: res.status, finalURL: res.url, body: Buffer.concat(chunks).toString("utf8") };
}

async function defaultDownload(
  url: string,
  destination: string,
  onProgress: (ratio: number) => void,
): Promise<DownloadResult> {
  const res = await fetchFollowing(url, allowedForDownload, {}, DOWNLOAD_TIMEOUT);
  if (res.status < 200 || res.status >= 300) throw new UpdateError("下载更新包失败");
  const total = Number(res.headers["content-length"]) || 0;
  let received = 0;
  const out = fs.createWriteStream(destination);
  await new Promise<void>((resolve, reject) => {
    res.stream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      onProgress(total > 0 ? Math.min(1, received / total) : 0);
    });
    res.stream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.stream.pipe(out);
  });
  return { finalURL: res.url };
}

function defaultWorkspace(release: UpdateRelease): UpdateWorkspace {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-update-"));
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows 上 chmod 基本是空操作，失败不影响临时目录的隔离
  }
  const base = path.basename(new URL(release.downloadURL).pathname) || "Tokei-update.exe";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return { directory, file: path.join(directory, safe) };
}

export class Updater {
  readonly currentVersion: string;
  private readonly isLocalBuild: boolean;
  private readonly metadataURLs: string[];
  private readonly metadataFn: (url: string) => Promise<MetadataResponse>;
  private readonly downloadFn: (url: string, destination: string, onProgress: (ratio: number) => void) => Promise<DownloadResult>;
  private readonly digestFn: (file: string) => Promise<string>;
  private readonly workspaceFn: (release: UpdateRelease) => UpdateWorkspace;
  private readonly launchInstaller: (file: string) => Promise<void> | void;
  private readonly onQuit: () => void;
  private readonly onState: (state: UpdateState) => void;

  private _state: UpdateState = { kind: "idle" };
  private available: UpdateRelease | null = null;
  private lastCheckUserInitiated = false;
  private transientTimer: ReturnType<typeof setTimeout> | null = null;
  private quitTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: UpdaterOptions) {
    this.currentVersion = options.currentVersion;
    this.isLocalBuild = options.isLocalBuild === true;
    this.metadataURLs = options.metadataURLs ?? UPDATE_METADATA_URLS;
    this.metadataFn = options.metadata ?? defaultMetadata;
    this.downloadFn = options.download ?? defaultDownload;
    this.digestFn = options.digest ?? sha256File;
    this.workspaceFn = options.workspace ?? defaultWorkspace;
    this.launchInstaller = options.launchInstaller ?? (() => {});
    this.onQuit = options.onQuit ?? (() => {});
    this.onState = options.onState ?? (() => {});
  }

  get state(): UpdateState {
    return this._state;
  }

  private setState(next: UpdateState): void {
    if (this.disposed) return;
    this._state = next;
    try {
      this.onState(next);
    } catch (error) {
      console.error("[tokei] 更新状态回调失败", error);
    }
  }

  private clearTransient(): void {
    if (this.transientTimer) clearTimeout(this.transientTimer);
    this.transientTimer = null;
  }

  /** 对应 setTransientState：到点只在状态没被别的分支改写时才退回 idle */
  private setTransient(next: UpdateState, delay: number): void {
    this.clearTransient();
    this.setState(next);
    this.transientTimer = setTimeout(() => {
      this.transientTimer = null;
      if (this._state === next) this.setState({ kind: "idle" });
    }, delay);
  }

  /**
   * 对应 Updater.checkForUpdate：可从 idle / upToDate / failed 发起；自动检查跳过本地验证版，
   * 手动检查照常。两个来源依次试，第二个失败不影响第一个已经拿到的结果。
   */
  async checkForUpdate(userInitiated = false): Promise<void> {
    if (this.disposed) return;
    if (!userInitiated && this.isLocalBuild) return;
    if (!["idle", "upToDate", "failed"].includes(this._state.kind)) return;
    this.lastCheckUserInitiated = userInitiated;
    this.available = null;
    const releases: UpdateRelease[] = [];
    let sawValidMetadata = false;
    let sawNewerIncompleteRelease = false;

    this.setState({ kind: "checking" });
    for (const url of this.metadataURLs) {
      if (!isAllowedMetadataURL(url)) continue;
      let response: MetadataResponse;
      try {
        response = await this.metadataFn(url);
      } catch {
        continue;
      }
      if (this.disposed) return;
      if (response.status < 200 || response.status >= 300) continue;
      if (!isAllowedMetadataURL(response.finalURL)) continue;
      let json: Record<string, any>;
      try {
        const parsed = JSON.parse(response.body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        json = parsed;
      } catch {
        continue;
      }
      const tag = releaseTag(json);
      if (!tag) continue;
      sawValidMetadata = true;
      if (!isNewerVersion(tag, this.currentVersion)) continue;
      // 比本地新、却没有 Windows 包（比如只发了 DMG）：这不是给 Windows 的发布，静默跳过。
      // 有 Windows 包但标签/摘要不全，才按原版报「更新信息不完整」。
      if (!hasWindowsPackage(json)) continue;
      const release = validatedRelease(json);
      if (release) releases.push(release);
      else sawNewerIncompleteRelease = true;
    }
    if (this.disposed) return;

    const newest = newestRelease(releases, this.currentVersion);
    if (newest) {
      this.available = newest;
      this.setState({ kind: "available", tag: newest.tag });
    } else if (sawNewerIncompleteRelease) {
      this.setTransient({ kind: "failed", message: "更新信息不完整" }, 5000);
    } else if (sawValidMetadata) {
      this.setTransient({ kind: "upToDate" }, 3000);
    } else {
      this.setTransient({ kind: "failed", message: "网络不可用" }, 5000);
    }
  }

  /** 对应 performUpdate：下载 → 校验 sha256 → 起安装器 → 退出 */
  async performUpdate(): Promise<void> {
    if (this.disposed) return;
    if (this.isLocalBuild && !this.lastCheckUserInitiated) return;
    const release = this.available;
    if (this._state.kind !== "available" || !release) return;
    if (!isAllowedDownloadSourceURL(release.downloadURL)) {
      this.setState({ kind: "failed", message: "更新地址不受信任" });
      return;
    }

    let workspace: UpdateWorkspace;
    try {
      workspace = this.workspaceFn(release);
    } catch {
      this.setState({ kind: "failed", message: "创建更新目录失败" });
      return;
    }

    this.setState({ kind: "downloading", progress: 0 });
    let lastPercent = 0;
    try {
      const result = await this.downloadFn(release.downloadURL, workspace.file, (ratio) => {
        if (this.disposed || this._state.kind !== "downloading") return;
        const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        if (percent === lastPercent) return;
        lastPercent = percent;
        this.setState({ kind: "downloading", progress: percent / 100 });
      });
      if (!isAllowedDownloadResponseURL(result.finalURL)) throw new UpdateError("更新地址不受信任");
    } catch (error) {
      this.cleanup(workspace);
      if (error instanceof UpdateError || (error as Error)?.message === "更新地址不受信任") {
        this.setState({ kind: "failed", message: "更新地址不受信任" });
      } else {
        this.setTransient({ kind: "failed", message: (error as Error)?.message || "下载更新包失败" }, 5000);
      }
      return;
    }
    if (this.disposed) return;

    let actual: string;
    try {
      actual = await this.digestFn(workspace.file);
    } catch {
      this.cleanup(workspace);
      this.setState({ kind: "failed", message: "更新包校验失败" });
      return;
    }
    const expected = normalizedSHA256(release.sha256);
    if (!expected) {
      this.cleanup(workspace);
      this.setState({ kind: "failed", message: "更新包缺少校验信息" });
      return;
    }
    if (actual.toLowerCase() !== expected) {
      this.cleanup(workspace);
      this.setState({ kind: "failed", message: "更新包校验失败" });
      return;
    }
    if (this.disposed) return;

    this.available = null;
    this.setState({ kind: "installing" });
    try {
      await this.launchInstaller(workspace.file);
    } catch {
      this.cleanup(workspace);
      this.setState({ kind: "failed", message: "启动安装程序失败" });
      return;
    }
    // 对应 install() 里那句 0.3 秒后 NSApp.terminate：给安装器一点时间把句柄接过去
    this.quitTimer = setTimeout(() => {
      this.quitTimer = null;
      if (!this.disposed) this.onQuit();
    }, 300);
  }

  private cleanup(workspace: UpdateWorkspace): void {
    try {
      fs.rmSync(workspace.directory, { recursive: true, force: true });
    } catch {
      // 临时目录留着也无妨，下一次会新建一个
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTransient();
    if (this.quitTimer) clearTimeout(this.quitTimer);
    this.quitTimer = null;
  }
}
