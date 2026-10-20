/**
 * 更新器的纯校验层（updateSecurity.ts ← UpdateSecurity.swift）。
 * 只跑本地计算，不建连接；域名/后缀/摘要规则全部按原版对齐，另加 Windows 后缀。
 */
import { describe, expect, it } from "vitest";
import {
  hasWindowsPackage, isAllowedDownloadResponseURL, isAllowedDownloadSourceURL, isAllowedMetadataURL,
  isNewerVersion, newestRelease, normalizedSHA256, releaseTag, validatedRelease,
} from "../src/core/updateSecurity";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const GITHUB_EXE = "https://github.com/cclank/tokei/releases/download/v1.2.3/Tokei-Setup.exe";

describe("版本与标签", () => {
  it("tag_name 优先，latest.json 也可以只写 version", () => {
    expect(releaseTag({ tag_name: " v1.2.3 " })).toBe("v1.2.3");
    expect(releaseTag({ version: "1.2.3" })).toBe("1.2.3");
    expect(releaseTag({ tag_name: "  ", version: "1.2.3" })).toBe("1.2.3");
    expect(releaseTag({})).toBeNull();
  });

  it("按数字段比较，v 前缀与位数都不影响", () => {
    expect(isNewerVersion("v1.2.3", "1.2.2")).toBe(true);
    expect(isNewerVersion("1.10.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("v1.2", "1.2.0")).toBe(false);
    expect(isNewerVersion("v1.2.1", "1.2")).toBe(true);
    expect(isNewerVersion("fox", "1.2.3")).toBe(false);
    expect(isNewerVersion("v1.2.3", "1.2.3.1")).toBe(false);
  });

  it("newestRelease 只在比本地新的里面挑最大的", () => {
    const releases = [
      { tag: "v1.0.0", downloadURL: GITHUB_EXE, sha256: SHA },
      { tag: "v1.4.0", downloadURL: GITHUB_EXE, sha256: SHA },
      { tag: "v1.2.0", downloadURL: GITHUB_EXE, sha256: SHA },
    ];
    expect(newestRelease(releases, "v1.1.0")?.tag).toBe("v1.4.0");
    expect(newestRelease(releases, "v1.4.0")).toBeNull();
  });
});

describe("摘要", () => {
  it("接受大小写、sha256: 前缀，只认 64 位十六进制", () => {
    expect(normalizedSHA256(SHA.toUpperCase())).toBe(SHA);
    expect(normalizedSHA256(`sha256:${SHA}`)).toBe(SHA);
    expect(normalizedSHA256("SHA256:" + SHA)).toBe(SHA);
    expect(normalizedSHA256(SHA.slice(1))).toBeNull();
    expect(normalizedSHA256("g".repeat(64))).toBeNull();
    expect(normalizedSHA256(undefined)).toBeNull();
  });
});

describe("域名白名单", () => {
  it("元数据只认 https + 两个来源域", () => {
    expect(isAllowedMetadataURL("https://dl.lanshuagent.com/tokei/latest.json")).toBe(true);
    expect(isAllowedMetadataURL("https://api.github.com/repos/cclank/tokei/releases/latest")).toBe(true);
    expect(isAllowedMetadataURL("http://dl.lanshuagent.com/tokei/latest.json")).toBe(false);
    expect(isAllowedMetadataURL("https://evil.example/latest.json")).toBe(false);
    expect(isAllowedMetadataURL("https://api.github.com.evil.example/x")).toBe(false);
    expect(isAllowedMetadataURL("https://user:pass@dl.lanshuagent.com/x")).toBe(false);
    expect(isAllowedMetadataURL("https://dl.lanshuagent.com:8443/x")).toBe(false);
    expect(isAllowedMetadataURL("https://dl.lanshuagent.com:443/x")).toBe(true);
    expect(isAllowedMetadataURL("https://dl.lanshuagent.com/x#frag")).toBe(false);
    expect(isAllowedMetadataURL("not a url")).toBe(false);
  });

  it("下载源与跳转后的资源域分开", () => {
    expect(isAllowedDownloadSourceURL(GITHUB_EXE)).toBe(true);
    expect(isAllowedDownloadSourceURL("https://dl.lanshuagent.com/tokei/Tokei-Setup.exe")).toBe(true);
    expect(isAllowedDownloadSourceURL("https://release-assets.githubusercontent.com/x.exe")).toBe(false);
    expect(isAllowedDownloadResponseURL("https://release-assets.githubusercontent.com/x.exe")).toBe(true);
    expect(isAllowedDownloadResponseURL("https://objects.githubusercontent.com/x.exe")).toBe(false);
  });
});

describe("Windows 发布包识别", () => {
  it("GitHub asset 认 .exe / .msi，摘要支持 digest 前缀", () => {
    const json = {
      tag_name: "v1.2.3",
      assets: [
        { name: "Tokei.dmg", browser_download_url: "https://github.com/cclank/tokei/releases/download/v1.2.3/Tokei.dmg", digest: `sha256:${OTHER_SHA}` },
        { name: "Tokei-Setup.exe", browser_download_url: GITHUB_EXE, digest: `sha256:${SHA}` },
      ],
    };
    expect(hasWindowsPackage(json)).toBe(true);
    expect(validatedRelease(json)).toEqual({ tag: "v1.2.3", downloadURL: GITHUB_EXE, sha256: SHA });
  });

  it("只有 DMG 的发布不算 Windows 包", () => {
    const json = {
      tag_name: "v1.2.3",
      assets: [{ name: "Tokei.dmg", browser_download_url: "https://github.com/cclank/tokei/releases/download/v1.2.3/Tokei.dmg", digest: SHA }],
    };
    expect(hasWindowsPackage(json)).toBe(false);
    expect(validatedRelease(json)).toBeNull();
    expect(hasWindowsPackage({ tag_name: "v1.2.3", download_url: "https://dl.lanshuagent.com/tokei/Tokei.dmg", sha256: SHA })).toBe(false);
  });

  it("latest.json 可以用 windows_download_url/windows_sha256 单独带 Windows 包", () => {
    const json = {
      tag_name: "v1.2.3",
      download_url: "https://dl.lanshuagent.com/tokei/Tokei.dmg",
      sha256: OTHER_SHA,
      windows_download_url: "https://dl.lanshuagent.com/tokei/Tokei-Setup.msi",
      windows_sha256: SHA,
    };
    expect(validatedRelease(json)).toEqual({
      tag: "v1.2.3",
      downloadURL: "https://dl.lanshuagent.com/tokei/Tokei-Setup.msi",
      sha256: SHA,
    });
  });

  it("顶层 download_url 只有指向 exe/msi 时才当 Windows 包", () => {
    expect(validatedRelease({ tag_name: "v1.2.3", download_url: "https://dl.lanshuagent.com/tokei/a.exe", sha256: SHA }))
      .toEqual({ tag: "v1.2.3", downloadURL: "https://dl.lanshuagent.com/tokei/a.exe", sha256: SHA });
    expect(validatedRelease({ tag_name: "v1.2.3", download_url: "https://dl.lanshuagent.com/tokei/a.zip", sha256: SHA })).toBeNull();
  });

  it("域名、后缀、摘要缺一样都判为不完整", () => {
    expect(validatedRelease({
      tag_name: "v1.2.3",
      assets: [{ name: "Tokei.exe", browser_download_url: "https://evil.example/Tokei.exe", digest: SHA }],
    })).toBeNull();
    expect(validatedRelease({
      tag_name: "v1.2.3",
      assets: [{ name: "Tokei.exe", browser_download_url: "https://github.com/cclank/tokei/releases/download/v1.2.3/Tokei.exe" }],
    })).toBeNull();
    expect(validatedRelease({
      tag_name: "v1.2.3",
      assets: [{ name: "Tokei.zip", browser_download_url: "https://github.com/cclank/tokei/releases/download/v1.2.3/Tokei.zip", digest: SHA }],
    })).toBeNull();
  });
});
