/**
 * 开机垫的那份读数：对应 DataLoader.loadCachedUsage（DataLoader.swift:514-546）。
 *
 * 原版做两件事：把上一轮落盘的 payload 读回来，再顺手把 Claude 那三路额度过期标记
 * 按「现在」重算一遍（normalizeClaudeQuota，DataLoader.swift:626-643）。第二件是必需的——
 * 磁盘那份的 stale 是写它的那一刻算的，机器睡一晚再开机，读数早就过了 30 分钟 TTL，
 * 标记却还写着 false，托盘会把旧读数画成新鲜的一档。
 *
 * 原版还排了第二个候选（sync 目录下本机 device_id 那份快照），那条链路要等 Git 多设备
 * 同步接上才有对应物（任务 #27），这里只读本机那一份。
 */
import * as path from "path";
import { TOKEI_DIR, loadJson } from "../core/paths";
import { claudeQuotaWithFreshness } from "../collectors/claude.quota";

export const LAST_USAGE_FILE = path.join(TOKEI_DIR, "last_usage.json");

function isDict(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 读回来的那份去掉所有 `_` 开头的内部键（对应那句 `key.hasPrefix("_")` 的删除）。 */
export function loadCachedUsage(file: string = LAST_USAGE_FILE): Record<string, any> | null {
  const raw = loadJson<Record<string, any>>(file, null as any);
  if (!isDict(raw)) return null;
  const payload: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) if (!key.startsWith("_")) payload[key] = value;
  if (isDict(payload.claude)) payload.claude = claudeQuotaWithFreshness(payload.claude);
  return payload;
}
