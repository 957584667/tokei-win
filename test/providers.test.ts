/**
 * Provider 额度设置层的纯函数断言：URL 规则照抄 Swift（PanelView.swift:3278-3287），
 * 键名必须与 Python/macOS 读的 config.json 一致，改一个字两边就失联。
 */
import { describe, expect, it } from "vitest";
import {
  CRED_NAME, PROVIDER_SECRETS, PROVIDER_SETTING_KEYS, ZAI_REGIONS,
  clean, isProviderSecret, providerQuotaFlags, validSub2APIBaseURL, zaiRegion,
} from "../src/main/providers";
import { defaultSettings } from "../src/main/settings";

const S = () => defaultSettings();

describe("Sub2API Base URL 校验", () => {
  it("https 任意主机放行", () => {
    expect(validSub2APIBaseURL("https://api.example.com")).toBe(true);
    expect(validSub2APIBaseURL("https://sub2api.example.com/v1")).toBe(true);
    expect(validSub2APIBaseURL("  https://host.example  ")).toBe(true);
    expect(validSub2APIBaseURL("HTTPS://Host.Example")).toBe(true);
  });

  it("http 只放行本机", () => {
    expect(validSub2APIBaseURL("http://localhost:8080")).toBe(true);
    expect(validSub2APIBaseURL("http://127.0.0.1")).toBe(true);
    expect(validSub2APIBaseURL("http://[::1]:3000")).toBe(true);
    expect(validSub2APIBaseURL("http://api.example.com")).toBe(false);
    expect(validSub2APIBaseURL("http://10.0.0.5")).toBe(false);
  });

  it("凭据/查询串/锚点/无协议一律拒绝", () => {
    expect(validSub2APIBaseURL("https://user:pass@host.example")).toBe(false);
    expect(validSub2APIBaseURL("https://host.example?token=1")).toBe(false);
    expect(validSub2APIBaseURL("https://host.example#frag")).toBe(false);
    expect(validSub2APIBaseURL("api.example.com")).toBe(false);
    expect(validSub2APIBaseURL("ftp://host.example")).toBe(false);
    expect(validSub2APIBaseURL("file:///C:/etc")).toBe(false);
    expect(validSub2APIBaseURL("https://")).toBe(false);
    expect(validSub2APIBaseURL("")).toBe(false);
    expect(validSub2APIBaseURL(undefined as any)).toBe(false);
  });
});

describe("Provider 凭据与设置键名", () => {
  it("只有三个 Provider 有密钥位", () => {
    expect(PROVIDER_SECRETS).toEqual(["sub2api", "zai", "minimax"]);
    expect(isProviderSecret("sub2api")).toBe(true);
    expect(isProviderSecret("zai")).toBe(true);
    expect(isProviderSecret("minimax")).toBe(true);
  });

  it("白名单外的名称不接受（也不能当文件名）", () => {
    for (const bad of ["claude", "../../cred-x", "a/b", "sub2api ", "", null, 7, "x".repeat(65)]) {
      expect(isProviderSecret(bad)).toBe(false);
    }
    expect(CRED_NAME.test("cred-x_1.2")).toBe(true);
    expect(CRED_NAME.test("a/b")).toBe(false);
  });

  it("config.json 键名与 Python / macOS 对齐", () => {
    expect([...PROVIDER_SETTING_KEYS].sort()).toEqual(["sub2api_base_url", "zai_region"]);
    expect(S()).toHaveProperty("sub2api_base_url", "");
    expect(S()).toHaveProperty("zai_region", "global");
  });

  it("zai_region 只认两个枚举值", () => {
    expect(ZAI_REGIONS).toEqual(["global", "bigmodel-cn"]);
    expect(zaiRegion({ ...S(), zai_region: "BigModel-CN" })).toBe("bigmodel-cn");
    expect(zaiRegion({ ...S(), zai_region: "eu" })).toBe("global");
    expect(zaiRegion({ ...S(), zai_region: undefined as any })).toBe("global");
    expect(clean("  x ")).toBe("x");
  });
});

describe("联网开关跟随凭据", () => {
  it("没凭据就不开，Sub2API 还得有 Base URL", () => {
    const none = { sub2api: false, zai: false, minimax: false };
    expect(providerQuotaFlags(none, S())).toEqual({
      sub2api_quota_enabled: false, zai_quota_enabled: false, minimax_quota_enabled: false,
    });
    const all = { sub2api: true, zai: true, minimax: true };
    expect(providerQuotaFlags(all, S()).sub2api_quota_enabled).toBe(false);
    expect(providerQuotaFlags(all, { ...S(), sub2api_base_url: "https://h.example" }).sub2api_quota_enabled).toBe(true);
    expect(providerQuotaFlags(all, S())).toMatchObject({ zai_quota_enabled: true, minimax_quota_enabled: true });
  });

  it("清掉密钥即关（对齐 PanelView 的 minimax 规则）", () => {
    const settings = { ...S(), sub2api_base_url: "https://h.example" };
    expect(providerQuotaFlags({ sub2api: true, zai: true, minimax: true }, settings).minimax_quota_enabled).toBe(true);
    expect(providerQuotaFlags({ sub2api: true, zai: true, minimax: false }, settings).minimax_quota_enabled).toBe(false);
  });
});
