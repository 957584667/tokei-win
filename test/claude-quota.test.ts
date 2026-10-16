/**
 * Claude 套餐额度扫描测试（collectors/claude.quota.ts ← usage.30s.py:12927-13215）。
 * fixture 全部落在临时目录：伪造 Chromium 缓存条目（junk 头 + zstd 帧），
 * 状态文件也注入到临时路径，绝不写真实的 ~/.tokei/claude_quota_cache.json。
 * 重点覆盖：
 *   - 只认 *_0 条目、按 (mtime_ns, path) 倒序
 *   - 需要 organizations/ + /usage 两个证据串和 zstd 魔数，非 /usage 响应一律 null
 *   - fable 周额度只从 limits 里 kind == weekly_scoped 且 display_name 认 fable 的项取
 *   - 新鲜度：整源 TTL 30 分钟、未来时间、单窗口重置点过期
 *   - 状态机：增量扫描复用候选、候选消失只清 candidate 但保留 snapshot、
 *     未来 mtime 既不解也不污染水位线、版本不符全量重扫
 *   - TOKEI_CLAUDE_QUOTA_JSON 注入优先于本地缓存
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import {
  claudeCacheDirs, claudeCacheRecords, claudeQuotaWithFreshness, parseClaudeQuotaRecord,
  scanClaudePlan, scanClaudeQuota, ClaudeQuota,
} from "../src/collectors/claude.quota";

/** 基准时刻：固定值，避免断言随本机时钟漂移 */
const NOW = 1_760_000_000;
/** 对应 _CLAUDE_CACHE_FILE_LIMIT */
const CACHE_FILE_LIMIT = 16 * 1024 * 1024;

const tmpDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-claude-quota-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
});

function useEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function iso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** 对应 Chromium 缓存条目：键区明文 + 空字节 + zstd 响应体 */
function usageEntry(payload: unknown): Buffer {
  const header = Buffer.from("data:organizations/0198-ca-fe/usage-key\0tail\0", "latin1");
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify(payload), "utf8"));
  return Buffer.concat([header, body]);
}

function usagePayload(overrides: Partial<Record<string, any>> = {}): Record<string, any> {
  return {
    five_hour: { utilization: 12.5, resets_at: iso(NOW + 3600) },
    seven_day: { utilization: 40, resets_at: iso(NOW + 5 * 86400) },
    limits: [
      { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 3, resets_at: iso(NOW + 6 * 86400) },
      { kind: "weekly_scoped", scope: { model: { display_name: "Opus" } }, percent: 88, resets_at: iso(NOW + 6 * 86400) },
    ],
    ...overrides,
  };
}

/** 写一条缓存条目并把 mtime 钉到指定秒 */
function writeRecord(dir: string, name: string, data: Buffer, mtimeSec: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  const when = new Date(mtimeSec * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

function recordOf(file: string) {
  const st = fs.statSync(file, { bigint: true });
  return { path: file, mtimeNs: Number(st.mtimeNs), size: Number(st.size) };
}

function readState(stateFile: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function statePath(): string {
  return path.join(mkTmp(), "claude_quota_cache.json");
}

describe("缓存条目筛选", () => {
  it("只收 *_0，按 mtime 新→旧、同 mtime 按路径倒序", () => {
    const dir = mkTmp();
    writeRecord(dir, "a_0", usageEntry(usagePayload()), NOW - 100);
    writeRecord(dir, "b_0", usageEntry(usagePayload()), NOW - 50);
    writeRecord(dir, "c_1", usageEntry(usagePayload()), NOW - 10);
    const records = claudeCacheRecords([dir]);
    expect(records.map((r) => path.basename(r.path))).toEqual(["b_0", "a_0"]);
  });

  it("同一目录重复出现不会记两条，链接条目按真实目标记账", () => {
    const dir = mkTmp();
    const file = writeRecord(dir, "d_0", usageEntry(usagePayload()), NOW - 50);
    // 直接重复传同一个目录：records 以真实路径为键，仍然只有一条
    expect(claudeCacheRecords([dir, dir]).length).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("TOKEI_CLAUDE_CACHE_DIR 覆盖默认目录", () => {
    const dir = mkTmp();
    useEnv("TOKEI_CLAUDE_CACHE_DIR", dir);
    const dirs = claudeCacheDirs();
    expect(dirs.map((d) => path.normalize(d).toLowerCase())).toContain(path.normalize(dir).toLowerCase());
  });
});

describe("响应体解析", () => {
  it("解出 q5/q7/qf 与三个重置点，q_updated 取条目 mtime", () => {
    const dir = mkTmp();
    const file = writeRecord(dir, "e_0", usageEntry(usagePayload()), NOW - 60);
    const quota = parseClaudeQuotaRecord(recordOf(file)) as ClaudeQuota;
    expect(quota).toMatchObject({
      q5: 12.5, q5_reset: NOW + 3600,
      q7: 40, q7_reset: NOW + 5 * 86400,
      qf: 3, qf_reset: NOW + 6 * 86400,
      q_updated: NOW - 60,
    });
  });

  it("display_name 大小写混写也认 fable", () => {
    const dir = mkTmp();
    const payload = usagePayload({
      limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "FABLE" } }, percent: 77, resets_at: iso(NOW + 86400) }],
    });
    const file = writeRecord(dir, "f_0", usageEntry(payload), NOW - 60);
    expect(parseClaudeQuotaRecord(recordOf(file))).toMatchObject({ qf: 77 });
  });

  it("缺 organizations/ 或 /usage 或 zstd 魔数都不算额度", () => {
    const dir = mkTmp();
    const noOrg = writeRecord(dir, "g_0", Buffer.concat([
      Buffer.from("data:something-else/usage-key\0", "latin1"),
      zlib.zstdCompressSync(Buffer.from(JSON.stringify(usagePayload()), "utf8")),
    ]), NOW - 60);
    expect(parseClaudeQuotaRecord(recordOf(noOrg))).toBeNull();
    const noUsage = writeRecord(dir, "h_0", Buffer.concat([
      Buffer.from("data:organizations/abc\0", "latin1"),
      zlib.zstdCompressSync(Buffer.from(JSON.stringify(usagePayload()), "utf8")),
    ]), NOW - 60);
    expect(parseClaudeQuotaRecord(recordOf(noUsage))).toBeNull();
    const plain = writeRecord(dir, "i_0", Buffer.from("organizations/x/usage {\"five_hour\":{\"utilization\":1}}", "utf8"), NOW - 60);
    expect(parseClaudeQuotaRecord(recordOf(plain))).toBeNull();
  });

  it("体积为 0 或超过 16MiB 上限直接跳过，不读盘", () => {
    const dir = mkTmp();
    const empty = writeRecord(dir, "j_0", Buffer.alloc(0), NOW - 60);
    expect(parseClaudeQuotaRecord(recordOf(empty))).toBeNull();
    const ghost = path.join(dir, "absent_0");
    expect(parseClaudeQuotaRecord({ path: ghost, mtimeNs: (NOW - 60) * 1e9, size: CACHE_FILE_LIMIT + 1 })).toBeNull();
    // 读过盘但解不出帧：截断的 zstd 帧
    const broken = writeRecord(dir, "k_0", Buffer.concat([
      Buffer.from("data:organizations/x/usage\0", "latin1"),
      zlib.zstdCompressSync(Buffer.from(JSON.stringify(usagePayload()), "utf8")).subarray(0, 12),
    ]), NOW - 60);
    expect(parseClaudeQuotaRecord(recordOf(broken))).toBeNull();
  });

  it("三个窗口全空就不算一次有效读数", () => {
    const dir = mkTmp();
    const file = writeRecord(dir, "l_0", usageEntry({ five_hour: {}, seven_day: {}, limits: [] }), NOW - 60);
    expect(parseClaudeQuotaRecord(recordOf(file))).toBeNull();
  });
});

describe("新鲜度", () => {
  it("整源超过 30 分钟没更新就算 stale", () => {
    const result = claudeQuotaWithFreshness({ q5: 50, q5_reset: NOW + 3600, q_updated: NOW - 1801 }, NOW);
    expect(result.q5).toBe(50);
    expect(result.q5_stale).toBe(true);
  });

  it("读取时间在未来（时钟异常）同样算 stale", () => {
    const result = claudeQuotaWithFreshness({ q7: 20, q7_reset: NOW + 3600, q_updated: NOW + 400 }, NOW);
    expect(result.q7_stale).toBe(true);
    // 只晚 100 秒还在容差内，对应 FUTURE_SKEW = 300
    expect(claudeQuotaWithFreshness({ q7: 20, q_updated: NOW + 100 }, NOW).q7_stale).toBe(false);
  });

  it("窗口已过重置点只标 stale，数值保留", () => {
    const result = claudeQuotaWithFreshness({ q5: 66, q5_reset: NOW - 1, q_updated: NOW - 10 }, NOW);
    expect(result.q5).toBe(66);
    expect(result.q5_stale).toBe(true);
    expect(result.qf_stale).toBe(false);
  });

  it("没有数值也把 stale 记成 false，非字典入参才返回空对象", () => {
    // 对应 Python：三个 stale 键总会被写出来，只是没有数值时恒为 False
    expect(claudeQuotaWithFreshness({ q_updated: NOW - 10 }, NOW))
      .toEqual({ q_updated: NOW - 10, q5_stale: false, q7_stale: false, qf_stale: false });
    expect(claudeQuotaWithFreshness(null, NOW)).toEqual({});
  });
});

describe("扫描状态机", () => {
  it("首轮全量定位并写下水位线状态", () => {
    const dir = mkTmp();
    const stateFile = statePath();
    writeRecord(dir, "m_0", usageEntry(usagePayload()), NOW - 60);
    const quota = scanClaudeQuota(NOW, [dir], stateFile);
    expect(quota).toMatchObject({ q5: 12.5, q5_stale: false, qf: 3, q_updated: NOW - 60 });
    const state = readState(stateFile);
    expect(state.version).toBe(3);
    expect(state.snapshot.q5).toBe(12.5);
    expect(state.candidate.path).toBe(path.join(dir, "m_0"));
    expect(state.scan_mtime_ns).toBe((NOW - 60) * 1e9);
    expect(state.scan_boundary).toHaveLength(1);
    expect(state.last_full_scan).toBe(NOW);
  });

  it("增量扫描只碰新条目，复用候选并保留 snapshot", () => {
    const dir = mkTmp();
    const stateFile = statePath();
    writeRecord(dir, "n_0", usageEntry(usagePayload()), NOW - 60);
    scanClaudeQuota(NOW, [dir], stateFile);

    // 新增一条非额度响应：增量扫描会检查它、解不出，然后回落到候选
    writeRecord(dir, "o_0", Buffer.concat([
      Buffer.from("data:organizations/x/usage\0", "latin1"),
      zlib.zstdCompressSync(Buffer.from(JSON.stringify({ irrelevant: true }), "utf8")),
    ]), NOW + 10);
    const reused = scanClaudeQuota(NOW + 100, [dir], stateFile);
    expect(reused.q5).toBe(12.5);
    expect(reused.q5_stale).toBe(false);
    const state = readState(stateFile);
    // 100 秒 < 6 小时，没有触发全量兜底
    expect(state.last_full_scan).toBe(NOW);
    expect(state.scan_mtime_ns).toBe((NOW + 10) * 1e9);
  });

  it("候选条目被淘汰后清掉 candidate，但 snapshot 继续供读数", () => {
    const dir = mkTmp();
    const stateFile = statePath();
    const file = writeRecord(dir, "p_0", usageEntry(usagePayload()), NOW - 60);
    scanClaudeQuota(NOW, [dir], stateFile);
    fs.rmSync(file);

    const kept = scanClaudeQuota(NOW + 400, [], stateFile);
    expect(kept.q5).toBe(12.5);
    const state = readState(stateFile);
    expect(state.candidate).toBeUndefined();
    expect(state.snapshot.q5).toBe(12.5);
    expect(state.scan_mtime_ns).toBe(-1);
    expect(state.scan_boundary).toEqual([]);
  });

  it("mtime 晚于「现在 + 5 分钟」的条目既不解也不污染水位线", () => {
    const dir = mkTmp();
    const stateFile = statePath();
    writeRecord(dir, "q_0", usageEntry(usagePayload()), NOW + 3600);
    expect(scanClaudeQuota(NOW, [dir], stateFile)).toEqual({});
    const state = readState(stateFile);
    expect(state.scan_mtime_ns).toBe(-1);
    expect(state.scan_boundary).toEqual([]);
    expect(state.snapshot).toBeUndefined();

    // 时间真走到它，就按普通条目处理
    expect(scanClaudeQuota(NOW + 3600, [dir], stateFile).q5).toBe(12.5);
  });

  it("同一 mtime 边界内的条目不会重复解析，签名变化后重来", () => {
    const dir = mkTmp();
    const stateFile = statePath();
    writeRecord(dir, "r_0", usageEntry(usagePayload()), NOW - 60);
    writeRecord(dir, "s_0", usageEntry(usagePayload({ five_hour: { utilization: 30, resets_at: iso(NOW + 3600) } })), NOW - 60);
    // 首条命中即停，取 (mtime, path) 倒序的第一条 = s_0
    expect(scanClaudeQuota(NOW, [dir], stateFile).q5).toBe(30);

    // 覆盖 s_0 内容但保持 mtime 不变：签名里的 size 变了，增量扫描才会重新解析
    writeRecord(dir, "s_0", usageEntry(usagePayload({
      five_hour: { utilization: 45, resets_at: iso(NOW + 3600) },
      padding: "x".repeat(4096),
    })), NOW - 60);
    expect(scanClaudeQuota(NOW + 1, [dir], stateFile).q5).toBe(45);
  });

  it("状态版本不符就丢弃旧状态全量重扫", () => {
    const dir = mkTmp();
    const stateFile = statePath();
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 2, scan_mtime_ns: NOW * 1e9, snapshot: { q5: 99, q_updated: NOW }, candidate: { path: "gone", mtime_ns: 1, size: 1 },
    }));
    writeRecord(dir, "t_0", usageEntry(usagePayload()), NOW - 60);
    const quota = scanClaudeQuota(NOW, [dir], stateFile);
    expect(quota.q5).toBe(12.5);
    expect(readState(stateFile).version).toBe(3);
  });

  it("没有缓存目录只落水位线，不伪造读数", () => {
    const stateFile = statePath();
    expect(scanClaudeQuota(NOW, [], stateFile)).toEqual({});
    const state = readState(stateFile);
    expect(state.scan_mtime_ns).toBe(-1);
    expect(state.snapshot).toBeUndefined();
    expect(state.candidate).toBeUndefined();
  });
});

describe("环境变量注入", () => {
  it("TOKEI_CLAUDE_QUOTA_JSON 优先于本地缓存，且只收白名单键", () => {
    useEnv("TOKEI_CLAUDE_QUOTA_JSON", JSON.stringify({
      q5: 8, q5_reset: NOW + 1800, q7: 60, qf: 1, q_updated: NOW - 30, injected_extra: "x",
    }));
    const plan = scanClaudePlan(NOW, [], statePath());
    expect(plan).toMatchObject({ q5: 8, q7: 60, qf: 1, q_updated: NOW - 30, q5_stale: false });
    expect((plan as Record<string, any>).injected_extra).toBeUndefined();
  });

  it("注入内容为空或三个窗口全空时退回本地缓存", () => {
    const dir = mkTmp();
    writeRecord(dir, "u_0", usageEntry(usagePayload()), NOW - 60);
    useEnv("TOKEI_CLAUDE_QUOTA_JSON", "{ not json");
    expect(scanClaudePlan(NOW, [dir], statePath()).q5).toBe(12.5);
    useEnv("TOKEI_CLAUDE_QUOTA_JSON", JSON.stringify({ q_updated: NOW }));
    expect(scanClaudePlan(NOW, [dir], statePath()).q7).toBe(40);
    useEnv("TOKEI_CLAUDE_QUOTA_JSON", undefined);
  });
});
