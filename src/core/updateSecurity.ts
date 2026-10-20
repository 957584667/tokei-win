/**
 * 更新器的纯函数部分（对应 TokeiUpdateSecurity/UpdateSecurity.swift）。
 *
 * 与原版的差别只有平台：macOS 认 .dmg，这里认 .exe / .msi。元数据既支持
 * GitHub release 的 assets，也支持 latest.json 那种顶层 download_url/sha256；
 * 想给 Windows 单独发一个包时，可以在 latest.json 里写 windows_download_url +
 * windows_sha256，而不动 macOS 那三项。
 */
import * as crypto from "crypto";
import * as fs from "fs";

export interface UpdateRelease {
  tag: string;
  downloadURL: string;
  sha256: string;
}

/** 元数据来源白名单（对应 UpdateSecurity.metadataHosts） */
export const UPDATE_METADATA_HOSTS = ["api.github.com", "dl.lanshuagent.com"];
/** 允许直接下载的域名（对应 downloadSourceHosts） */
export const UPDATE_DOWNLOAD_SOURCE_HOSTS = ["dl.lanshuagent.com", "github.com"];
/** GitHub release 资源跳转后的域名（对应 downloadRedirectHosts） */
export const UPDATE_DOWNLOAD_REDIRECT_HOSTS = ["release-assets.githubusercontent.com"];

const WINDOWS_EXTENSIONS = [".exe", ".msi"];

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isDict(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 对应 UpdateSecurity.releaseTag：tag_name 优先，latest.json 也可以只写 version */
export function releaseTag(json: Record<string, any>): string | null {
  return text(json.tag_name) ?? text(json.version);
}

function versionParts(raw: string): number[] | null {
  let value = raw.trim();
  if (value.toLowerCase().startsWith("v")) value = value.slice(1);
  const parts = value.split(".");
  if (!parts.length) return null;
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  return numbers.every((n) => Number.isFinite(n)) ? numbers : null;
}

export function isNewerVersion(remote: string, local: string): boolean {
  const remoteParts = versionParts(remote);
  const localParts = versionParts(local);
  if (!remoteParts || !localParts) return false;
  for (let i = 0; i < Math.max(remoteParts.length, localParts.length); i += 1) {
    const a = i < remoteParts.length ? remoteParts[i] : 0;
    const b = i < localParts.length ? localParts[i] : 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** 对应 UpdateSecurity.newestRelease：只在比本地新的里面挑最大的 */
export function newestRelease(releases: UpdateRelease[], localVersion: string): UpdateRelease | null {
  let newest: UpdateRelease | null = null;
  for (const release of releases) {
    if (!isNewerVersion(release.tag, localVersion)) continue;
    if (!newest || isNewerVersion(release.tag, newest.tag)) newest = release;
  }
  return newest;
}

/** sha256: 前缀可有可无，只认 64 位十六进制 */
export function normalizedSHA256(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let digest = raw.trim().toLowerCase();
  if (digest.startsWith("sha256:")) digest = digest.slice("sha256:".length);
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function isAllowedHTTPSURL(raw: string, hosts: string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol.toLowerCase() !== "https:") return false;
  if (!hosts.includes(url.hostname.toLowerCase())) return false;
  if (url.username || url.password) return false;
  if (url.hash) return false;
  if (url.port && url.port !== "443") return false;
  return true;
}

export function isAllowedMetadataURL(raw: string): boolean {
  return isAllowedHTTPSURL(raw, UPDATE_METADATA_HOSTS);
}

export function isAllowedDownloadSourceURL(raw: string): boolean {
  return isAllowedHTTPSURL(raw, UPDATE_DOWNLOAD_SOURCE_HOSTS);
}

export function isAllowedDownloadResponseURL(raw: string): boolean {
  return isAllowedHTTPSURL(raw, [...UPDATE_DOWNLOAD_SOURCE_HOSTS, ...UPDATE_DOWNLOAD_REDIRECT_HOSTS]);
}

function isWindowsPackageURL(raw: string): boolean {
  try {
    const lower = new URL(raw).pathname.toLowerCase();
    return WINDOWS_EXTENSIONS.some((ext) => lower.endsWith(ext));
  } catch {
    return false;
  }
}

function windowsAsset(json: Record<string, any>): { url: string; digest: unknown } | null {
  const assets = json.assets;
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (!isDict(asset)) continue;
      const url = text(asset.browser_download_url);
      const name = text(asset.name) ?? "";
      if (url && (isWindowsPackageURL(url) || WINDOWS_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))) {
        return { url, digest: asset.digest ?? asset.sha256 };
      }
    }
    // assets 存在但没有 Windows 包：这是 macOS 的发版，不该算作 Windows 更新
    return null;
  }
  const direct = text(json.windows_download_url) ?? text(json.windows_url);
  if (direct) return { url: direct, digest: json.windows_sha256 ?? json.windows_digest };
  const legacy = text(json.download_url) ?? text(json.url);
  if (legacy && isWindowsPackageURL(legacy)) {
    return { url: legacy, digest: json.sha256 ?? json.digest };
  }
  return null;
}

/** 这份元数据到底有没有描述一个 Windows 包 */
export function hasWindowsPackage(json: Record<string, any>): boolean {
  return windowsAsset(json) !== null;
}

/**
 * 对应 UpdateSecurity.validatedRelease：标签、下载地址、摘要三样齐全才算一条可用的发布。
 * 地址不白名单、后缀不对、摘要缺失都返回 null，由调用方决定报「更新信息不完整」。
 */
export function validatedRelease(json: Record<string, any>): UpdateRelease | null {
  const tag = releaseTag(json);
  const asset = windowsAsset(json);
  if (!tag || !asset) return null;
  const digest = normalizedSHA256(asset.digest);
  if (!digest) return null;
  if (!isAllowedDownloadSourceURL(asset.url)) return null;
  if (!isWindowsPackageURL(asset.url)) return null;
  return { tag, downloadURL: asset.url, sha256: digest };
}

/** 对应 UpdateSecurity.sha256(of:)：64KB 一块读，别把安装包整个塞进内存 */
export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
