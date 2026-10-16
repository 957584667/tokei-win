/**
 * provider 额度取数的依赖容器：把「读环境变量 / 读 config.json / 读 DPAPI 凭据 / 发请求」
 * 四件事集中注入，单测用 fixture 替身，真实运行由主进程接上 DPAPI 与 node http。
 *
 * 为什么凭据要单独走 secret()：渲染进程只能问「存没存」，拿不到明文（面板用 innerHTML
 * 铺数据，把密钥交给渲染进程等于给一次注入就等于泄露）。取数只能在主进程做。
 */
import { QuotaEnvAccess, defaultEnvAccess } from "../../core/providerQuota";
import { ProviderTransport, requestJson } from "./http";

export interface QuotaDeps extends QuotaEnvAccess {
  /** DPAPI 凭据明文；没有存过返回 null。键名与设置页保存用的一致 */
  secret(name: string): string | null;
  /** 只读 config.json，供需要非密文键（Base URL、区域）的 fetcher 使用 */
  configValue(key: string): unknown;
  request: ProviderTransport;
  /** epoch 秒；测试可注入固定时刻 */
  now(): number;
}

/** 空凭据：给不需要密钥的 provider（如只读本机文件的 antigravity）用 */
export function baseDeps(part: Partial<QuotaDeps> = {}): QuotaDeps {
  const env = { ...defaultEnvAccess, ...part };
  return {
    env: env.env,
    config: env.config,
    secret: () => null,
    configValue: (key) => env.config()[key],
    request: requestJson,
    now: () => Math.floor(Date.now() / 1000),
    ...part,
  };
}

/**
 * 对应 Python 的 _provider_config_string(ENV, cfg)，再插一层 DPAPI：
 * 环境变量 → 凭据存储 → config.json。三步都要求非空白。
 */
export function secretValue(
  deps: QuotaDeps, envKey: string, credentialName: string, configKey: string,
): string | null {
  const raw = deps.env(envKey);
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const stored = deps.secret(credentialName);
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  const configured = deps.configValue(configKey);
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}
