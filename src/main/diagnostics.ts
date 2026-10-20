/**
 * 设置页「诊断」段：对应 PanelView 的 runDiagnostics + formatDiagnostics（PV:4074-4134）。
 *
 * macOS 是起 python3 跑采集脚本、拿它的 stdout。Windows 这边没有外挂脚本，
 * 同一份引擎编成 dist/cli.js，所以起 `ELECTRON_RUN_AS_NODE` 的自己跑它，
 * 拿到的 stdout 与 Python 的 --json 同形（工具键 + _errors + _pricing），报告逐行照抄原版。
 *
 * 文件末尾那个 runPriceUpdateScript 是同一条「起子进程跑 cli.js」的路，服务价格表段的
 * --update-unknown：两边只差超时与 argv，进程隔离的语义一样。
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** 对应 DataLoader.ScriptResult */
export interface ScriptResult {
  exitCode: number;
  timedOut: boolean;
  elapsed: number;
  stdout: string;
  stderr: string;
}

/** 对应 formatDiagnostics 里那串工具名单：顺序、包含关系都照原版，缺项就少打一个 */
const DIAG_TOOLS = [
  "claude", "codex", "gemini", "antigravity", "cursor", "zed",
  "sub2api", "zai", "grok", "grok_bot", "qoder", "qoderwork", "qodercli",
  "qodercli_cn", "hermes",
  "zcode", "mimocode", "openclaw", "pi", "workbuddy", "workbuddy_ai",
  "codebuddy",
  "deepseek_harness",
  "opencode", "qwencode", "qwenwork", "kimicode", "musecode", "cmdcode", "prime_agent",
  "devin", "minimax",
];

/**
 * 对应 PanelView.formatDiagnostics（PV:4088-4134）。
 * 原版写的是「B」，数其实是 Swift String.count（字符数）；这里同样取字符串长度，
 * 免得两边同一份日志报出两个数。
 */
export function formatDiagnostics(result: ScriptResult, scriptPath: string): string {
  let exists = false;
  let size = 0;
  try {
    const stat = fs.statSync(scriptPath);
    exists = stat.isFile();
    size = stat.size;
  } catch {
    /* 文件不存在就是 exists: false size: 0B */
  }
  const lines = [
    `script: ${scriptPath}`,
    `exists: ${exists} size: ${size}B`,
    `exit: ${result.exitCode} timeout: ${result.timedOut ? "yes" : "no"} elapsed: ${result.elapsed.toFixed(2)}s`,
    `stdout: ${result.stdout.length}B stderr: ${result.stderr.length}B`,
  ];

  let json: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  } catch {
    json = null;
  }
  if (json) {
    lines.push(`json: ok tools: ${DIAG_TOOLS.filter((t) => json![t] !== undefined && json![t] !== null).join(",")}`);
    const pricing = json._pricing;
    if (pricing && typeof pricing === "object") {
      lines.push(`pricing: ${pricing.count ?? "?"} ${pricing.updated_at ?? ""}`);
    }
    const errors = json._errors;
    if (errors && typeof errors === "object" && Object.keys(errors).length) {
      lines.push("errors:");
      for (const key of Object.keys(errors).sort()) lines.push(`- ${key}: ${errors[key]}`);
    } else {
      lines.push("errors: none");
    }
  } else if (result.stdout.trim()) {
    lines.push("json: invalid");
    lines.push(result.stdout.slice(0, 600));
  }

  if (result.stderr.trim()) {
    lines.push("stderr:");
    lines.push(result.stderr.slice(0, 600));
  }
  return lines.join("\n");
}

/**
 * 对应 DataLoader.runScriptRaw（DL:697-752）的三段语义：
 * 起不来 → exitCode -1、报错进 stderr；到点强杀 → 记 timedOut，退出码取终止信号（SIGTERM 是 15）；
 * 正常跑完 → 用真实退出码。elapsed 从起进程那一刻算起，与原版的 Date() 一致。
 */
export function runCollectorScript(
  cliPath: string, execPath: string, timeoutSeconds = 8,
): Promise<ScriptResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      execPath, [cliPath, "--json", "--compact"],
      {
        timeout: timeoutSeconds * 1000,
        // Electron 的可执行文件不加这个变量会再开一个应用实例，而不是当 node 用
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const elapsed = (Date.now() - started) / 1000;
        const text = (value: string | Buffer) => String(value ?? "");
        if (error && (error as any).code === "ENOENT") {
          resolve({ exitCode: -1, timedOut: false, elapsed, stdout: "", stderr: error.message });
          return;
        }
        const timedOut = !!error && (error as any).killed === true;
        const code = !error ? 0
          : typeof (error as any).code === "number" ? (error as any).code
            : (error as any).signal ? 15 : 1;
        resolve({ exitCode: code, timedOut, elapsed, stdout: text(stdout), stderr: text(stderr) });
      },
    );
  });
}

/** 诊断跑的是编译产物 dist/cli.js；RESOURCE_DIR 在 index.ts 是上一级，这里同一套定位 */
export function collectorEntry(): string {
  return path.resolve(__dirname, "..", "cli.js");
}

/**
 * 价格表段「查漏补缺」的那次子进程（对应 runPriceUpdate PV:4193-4203：/usr/bin/env python3
 * usage.30s.py --update-unknown）。放子进程有两个理由：扫一遍本机日志是同步重活，放主进程会冻面板；
 * 而且原版的 stdout JSON 就是靠进程隔离才「只此一份」的，我们也不在进程里顺手改状态。
 * 与 runCollectorScript 的区别是不设超时 —— 原版 waitUntilExit() 会一直等，不发明终止条件。
 */
export function runPriceUpdateScript(cliPath: string, execPath: string, flag: string): Promise<ScriptResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      execPath, [cliPath, flag],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const elapsed = (Date.now() - started) / 1000;
        const text = (value: string | Buffer) => String(value ?? "");
        if (error && (error as any).code === "ENOENT") {
          resolve({ exitCode: -1, timedOut: false, elapsed, stdout: "", stderr: error.message });
          return;
        }
        const code = !error ? 0
          : typeof (error as any).code === "number" ? (error as any).code
            : (error as any).signal ? 15 : 1;
        resolve({ exitCode: code, timedOut: false, elapsed, stdout: text(stdout), stderr: text(stderr) });
      },
    );
  });
}
