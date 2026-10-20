/**
 * 活跃安装统计：对应 ActivityReporter.swift（138 行）。默认开启、可显式关闭，与用量采集、
 * 多设备同步完全分开——它只回答「有多少台机器在跑 Tokei」。
 *
 * 每次启动只尝试一次，发四个字段：随机安装 ID、去掉 `v` 的版本号、系统名与版本。
 * 原版用 URLSession 的 ephemeral 配置（无 cookie、无磁盘缓存），10 秒请求超时 / 15 秒
 * 资源超时，且**从不跟随重定向**（绝不把安装 ID 转给另一个域）——这里逐条对应：
 * 时间戳用 http(s) 默认行为（本来就不跟随）、`agent:false` + 不设 cookie、超时由传输层管。
 *
 * 两处原版语义必须保留：
 * 1. 状态文件存在但解不开时**不能**新建一个安装 ID（catch 掉整趟上报）——否则一次坏文件
 *    就会让同一台机器在服务端多算一台；
 * 2. 先落 lastAttemptAt 再发包；只有「204 + 最终 URL 就是端点」才记 lastSuccessfulDay。
 *
 * Windows 上状态落在 `%APPDATA%\Tokei\Telemetry\state.json`（对应 macOS 的
 * `Application Support/Tokei/Telemetry/state.json`）；原版给目录 0700、文件 0600，
 * Windows 不看 POSIX 位，这里照写但实际生效的是 ACL 继承。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

/** 对应 ActivityReporter.endpoint：只走 https，构造函数里会再校验一次协议 */
export const ACTIVITY_ENDPOINT = "https://tokei-ops.lanshuagent.com/v1/heartbeat";

/** 对应 stateURL：Application Support/Tokei/Telemetry/state.json 的 Windows 落点 */
export function activityStateFile(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Tokei", "Telemetry", "state.json");
}

export interface ActivityState {
  installationID: string;
  lastSuccessfulDay: string | null;
  lastAttemptAt: string | null;
}

export interface HeartbeatRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** 本次请求的取消信号：关掉开关时用它掐断在跑的那一发 */
  signal: AbortSignal;
}

/** 传输层可替换：单测注入假 transport，真实运行只走 node 的 https */
export type HeartbeatTransport = (url: string, request: HeartbeatRequest) => Promise<{ status: number; url: string }>;

/** 对应 configuration.timeoutIntervalForRequest / ForResource */
const REQUEST_TIMEOUT_MS = 10_000;
const RESOURCE_TIMEOUT_MS = 15_000;

const defaultTransport: HeartbeatTransport = (url, request) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: request.method,
    headers: request.headers,
    // ephemeral 会话不沿用连接：原版每次都是一条新会话
    agent: false,
    signal: request.signal,
  }, (res) => {
    const status = res.statusCode ?? 0;
    // 响应体一个字节都不需要，直接断开；重定向本来就不会被跟随
    res.destroy();
    resolve({ status, url });
  });
  req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("heartbeat request timeout")));
  req.on("error", reject);
  req.end(request.body);
  // 资源总时长上限：请求头超时之后连上的连接也要掐
  setTimeout(() => req.destroy(new Error("heartbeat resource timeout")), RESOURCE_TIMEOUT_MS).unref();
});

/** 对应 ActivityReporter.utcDay：yyyy-MM-dd，按 UTC 切日 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 对应 `appVersion.hasPrefix("v") ? dropFirst : appVersion` */
export function releaseVersion(appVersion: string): string {
  return appVersion.startsWith("v") ? appVersion.slice(1) : appVersion;
}

/**
 * 读状态。文件不存在返回 null（调用方生成新 UUID）；文件在但内容不像状态就抛——
 * 原版这里抛出去会被 catch，整趟上报作废，绝不会静默换一个安装 ID。
 */
function readState(file: string): ActivityState | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || typeof raw.installationID !== "string" || !raw.installationID) {
    throw new Error("telemetry state is not decodable");
  }
  return {
    installationID: raw.installationID,
    lastSuccessfulDay: typeof raw.lastSuccessfulDay === "string" ? raw.lastSuccessfulDay : null,
    lastAttemptAt: typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
  };
}

function writeState(file: string, state: ActivityState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface ActivityReporterOptions {
  stateFile?: string;
  endpoint?: string;
  clock?: () => Date;
  request?: HeartbeatTransport;
  /** 系统名与版本，默认取本机（单测注入固定值） */
  system?: () => { name: string; version: string };
}

export class ActivityReporter {
  private readonly stateFile: string;
  private readonly endpoint: string;
  private readonly clock: () => Date;
  private readonly request: HeartbeatTransport;
  private readonly system: () => { name: string; version: string };
  /** 对应 hasAttemptedReport：一个进程只试一次，失败也不重试 */
  private hasAttemptedReport = false;
  /** 在跑的那一发的代号；关掉开关后晚到的回执靠它作废 */
  private activeRequestID: string | null = null;
  private abortActive: AbortController | null = null;

  constructor(options: ActivityReporterOptions = {}) {
    this.stateFile = options.stateFile ?? activityStateFile();
    this.endpoint = options.endpoint ?? ACTIVITY_ENDPOINT;
    this.clock = options.clock ?? (() => new Date());
    this.request = options.request ?? defaultTransport;
    this.system = options.system ?? (() => ({ name: "Windows", version: os.release() }));
  }

  /** 对应 preferencesChanged()：关掉就掐断在跑的那一发；重新开启于下次启动生效 */
  preferencesChanged(enabled: boolean): void {
    if (enabled) return;
    this.activeRequestID = null;
    this.abortActive?.abort();
    this.abortActive = null;
  }

  /**
   * 对应 reportLaunchIfNeeded(appVersion:)：返回「这次尝试有没有真的走到发请求」（原版无返回值，
   * 这里只给单测看，调用方照旧 void 掉）。
   */
  async reportLaunchIfNeeded(appVersion: string, enabled: boolean): Promise<boolean> {
    if (!enabled || this.hasAttemptedReport) return false;
    let endpoint: URL;
    try {
      endpoint = new URL(this.endpoint);
    } catch {
      return false;
    }
    if (endpoint.protocol !== "https:") return false;
    this.hasAttemptedReport = true;

    const now = this.clock();
    const day = utcDay(now);
    let state: ActivityState;
    try {
      state = readState(this.stateFile) ?? { installationID: crypto.randomUUID(), lastSuccessfulDay: null, lastAttemptAt: null };
    } catch {
      // 坏文件不能换安装 ID，也不能让统计打断应用
      return false;
    }

    const version = releaseVersion(appVersion);
    const system = this.system();
    const body = JSON.stringify({
      installation_id: state.installationID.toLowerCase(),
      app_version: version,
      os_name: system.name,
      os_version: system.version,
    });

    // 先落「试过一次」的时间戳再发包：原版就是先 save 后 task.resume()
    const attempted: ActivityState = { ...state, lastAttemptAt: now.toISOString() };
    try {
      writeState(this.stateFile, attempted);
    } catch {
      return false;
    }

    const requestID = crypto.randomUUID();
    const controller = new AbortController();
    this.activeRequestID = requestID;
    this.abortActive = controller;
    try {
      const reply = await this.request(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `Tokei/${version}`,
        },
        body,
        signal: controller.signal,
      });
      // 晚到的回执（已经关了开关或换了请求）一律作废
      if (this.activeRequestID !== requestID) return true;
      this.activeRequestID = null;
      this.abortActive = null;
      if (!enabled || reply.status !== 204 || reply.url !== this.endpoint) return true;
      try {
        writeState(this.stateFile, { ...attempted, lastSuccessfulDay: day });
      } catch {
        // 记录失败不影响已经完成的这一次上报
      }
      return true;
    } catch {
      if (this.activeRequestID === requestID) {
        this.activeRequestID = null;
        this.abortActive = null;
      }
      // 统计永远不打断应用，也不在日志里出现安装 ID
      return true;
    }
  }
}
