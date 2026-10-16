/**
 * provider 额度的 HTTP 底座：对应 usage.30s.py 的 _provider_json_request（5962-6004）。
 *
 * 三条硬规则照原版保留：
 * 1) 不跟随重定向 —— 凭据绝不能被送到另一个域；3xx 直接当 HTTP <code> 失败。
 * 2) 响应体超过 2MiB 判异常，防止某个接口返回大文件把内存吃掉。
 * 3) 5 秒超时。只允许 http/https。
 *
 * allowInsecureLoopbackTls 对应原版的 ssl._create_unverified_context()：只有目标是本机
 * （127.0.0.1 / ::1 / localhost）的 https 才放松证书校验，用于 sub2api 这类本地自建服务。
 */
import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { PROVIDER_QUOTA_MAX_RESPONSE_BYTES } from "../../core/providerQuota";

export interface JsonRequestOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutSeconds?: number;
  maxBytes?: number;
  allowInsecureLoopbackTls?: boolean;
}

/** 传输层可替换：单测把 fixture 塞进来，真实取数一律走 node 的 http/https */
export type ProviderTransport = (url: string, options?: JsonRequestOptions) => Promise<any>;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]", "[::ffff:127.0.0.1]"]);

/** 对应 RuntimeError(f"HTTP {status}") */
export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "RuntimeError";
  }
}

/** 对应 ValueError("provider response too large") */
export class ResponseTooLargeError extends Error {
  constructor() {
    super("provider response too large");
    this.name = "ValueError";
  }
}

/** 对应 ValueError("provider response was not valid JSON") */
export class BadJsonError extends Error {
  constructor() {
    super("provider response was not valid JSON");
    this.name = "ValueError";
  }
}

export function providerJsonRequest(url: string, options: JsonRequestOptions = {}): Promise<any> {
  const maxBytes = options.maxBytes ?? PROVIDER_QUOTA_MAX_RESPONSE_BYTES;
  const timeout = Math.max(1, (options.timeoutSeconds ?? 5) * 1000);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error(`unsupported url ${url}`));
  }
  const isHttps = parsed.protocol === "https:";
  if (!isHttps && parsed.protocol !== "http:") {
    return Promise.reject(new Error(`unsupported url ${url}`));
  }

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let payload: Buffer | null = null;
  if (options.body !== undefined && options.body !== null) {
    payload = Buffer.from(JSON.stringify(options.body), "utf8");
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
  }
  if (!hasHeader(headers, "accept")) headers["Accept"] = "application/json";

  const loopback = LOOPBACK.has(parsed.hostname.toLowerCase());
  const transport = isHttps ? https : http;
  return new Promise<any>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers,
        // 对应 allow_insecure_loopback_tls：只对本机 https 关掉证书校验
        ...(isHttps && options.allowInsecureLoopbackTls && loopback ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // 不跟随重定向：原版把 redirect_request 直接返回 None，3xx 就当错误抛出
        if (status < 200 || status >= 300) {
          res.destroy();
          reject(new HttpError(status));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new ResponseTooLargeError());
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (error) => reject(error));
        res.on("end", () => {
          if (size > maxBytes) return;
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new BadJsonError());
          }
        });
      },
    );
    req.setTimeout(timeout, () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      req.destroy(error);
    });
    req.on("error", (error) => reject(error));
    if (payload) req.write(payload);
    req.end();
  });
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** 测试注入口：非 null 时所有 provider 的请求都走这个函数，绝不碰网络 */
let injected: ProviderTransport | null = null;

export function setProviderTransport(transport: ProviderTransport | null): void {
  injected = transport;
}

/** fetcher 一律用它：单测下返回 fixture，正常运行时走 providerJsonRequest */
export async function requestJson(url: string, options?: JsonRequestOptions): Promise<any> {
  if (injected) return injected(url, options ?? {});
  return providerJsonRequest(url, options);
}
