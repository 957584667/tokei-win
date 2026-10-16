/**
 * 诊断报告的逐行形状：对齐 PanelView.formatDiagnostics（PV:4088-4134）。
 * 那三行行首（exit: / json: / errors:）是摘要按钮的取值依据，改动会让摘要变成空串。
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ScriptResult, formatDiagnostics } from "../src/main/diagnostics";

const run = (over: Partial<ScriptResult> = {}): ScriptResult =>
  ({ exitCode: 0, timedOut: false, elapsed: 1.234, stdout: "", stderr: "", ...over });

describe("formatDiagnostics", () => {
  const missing = path.join(__dirname, "__no_such_file__");

  it("头四行报路径、存在性、退出码与两段流的大小", () => {
    const lines = formatDiagnostics(run({ stdout: "{}" }), missing).split("\n");
    expect(lines[0]).toBe(`script: ${missing}`);
    expect(lines[1]).toBe("exists: false size: 0B");
    expect(lines[2]).toBe("exit: 0 timeout: no elapsed: 1.23s");
    expect(lines[3]).toBe("stdout: 2B stderr: 0B");
  });

  it("存在的文件按真实字节数报，工具名单只收 payload 里真有的键", () => {
    const report = formatDiagnostics(run({ stdout: '{"claude":{},"zed":{"a":1},"grok":null}' }), __filename);
    expect(report).toContain(`exists: true size: ${fs.statSync(__filename).size}B`);
    expect(report).toContain("json: ok tools: claude,zed");
    expect(report).toContain("errors: none");
  });

  it("价表水位与错误清单各占一行，错误按 key 排序", () => {
    const payload = JSON.stringify({
      _pricing: { updated_at: "2026-10-01 08:00", count: 42 },
      _errors: { zed_quota: "TypeError: x", codex: "no data" },
    });
    const report = formatDiagnostics(run({ stdout: payload }), missing);
    expect(report).toContain("pricing: 42 2026-10-01 08:00");
    const tail = report.split("\n").slice(-3);
    expect(tail).toEqual(["errors:", "- codex: no data", "- zed_quota: TypeError: x"]);
  });

  it("stdout 不是 JSON 时退回 invalid + 前 600 字符，stderr 非空也附原文", () => {
    const report = formatDiagnostics(
      run({ exitCode: 1, stdout: "x".repeat(700), stderr: "boom" }), missing);
    expect(report).toContain("json: invalid");
    expect(report).toContain(`${"x".repeat(600)}\nstderr:\nboom`);
    expect(report).not.toContain(`${"x".repeat(601)}`);
  });

  it("超时那一行写 timeout: yes，与原版取 terminationStatus 的口径一致", () => {
    const report = formatDiagnostics(
      run({ exitCode: 15, timedOut: true, elapsed: 8.001, stdout: "[]" }), missing);
    expect(report).toContain("exit: 15 timeout: yes elapsed: 8.00s");
    // 数组不是我们要的那份 JSON，走 invalid 分支（stdout 非空）
    expect(report).toContain("json: invalid");
  });
});
