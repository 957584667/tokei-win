/**
 * 本机监听端口 → 项目（main/localPorts.ts ← usage.30s.py 的 _detect_local_servers）。
 * 只测纯解析与匹配；起子进程的那一段不进用例（与采集器夹具同一个口径）。
 */
import { describe, expect, it } from "vitest";
import { matchPortsToProjects, parseListeningPorts, parseProcessText } from "../src/main/localPorts";
import { attachPorts, TrailProject } from "../src/core/trail";

const NETSTAT = `\r
活动连接\r
\r
  协议  本地地址          外部地址        状态           PID\r
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900\r
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234\r
  TCP    127.0.0.1:5173         127.0.0.1:50512        ESTABLISHED     1234\r
  TCP    [::]:445               [::]:0                 LISTENING       4\r
  TCP    192.168.1.5:8000       0.0.0.0:0              LISTENING       5555\r
  UDP    0.0.0.0:500            *:*                                    1111\r
  TCP    0.0.0.0:0              0.0.0.0:0              LISTENING       0\r
`;

describe("parseListeningPorts", () => {
  it("只认 LISTENING 的 TCP，端口限 1024..65535，按 pid 收集", () => {
    expect(parseListeningPorts(NETSTAT)).toEqual([
      { pid: 1234, ports: [5173] },
      { pid: 5555, ports: [8000] },
    ]);
  });

  it("同一 pid 多个端口排序；空输出与垃圾行不炸", () => {
    const text = "  TCP    127.0.0.1:6000    0.0.0.0:0    LISTENING    42\n"
      + "  TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    42\n"
      + "完全不是 netstat 的一行\n";
    expect(parseListeningPorts(text)).toEqual([{ pid: 42, ports: [3000, 6000] }]);
    expect(parseListeningPorts("")).toEqual([]);
  });
});

describe("parseProcessText", () => {
  it("单条是对象、多条是数组；缺字段的行跳过", () => {
    const single = parseProcessText(JSON.stringify({
      ProcessId: 1234, ExecutablePath: "C:\\node.exe", CommandLine: "node D:\\work\\app\\server.js",
    }));
    expect(single.get(1234)).toBe("C:\\node.exe node D:\\work\\app\\server.js");
    const many = parseProcessText(JSON.stringify([
      { ProcessId: 1, ExecutablePath: null, CommandLine: null },
      { ProcessId: 2, CommandLine: "node x.js" },
    ]));
    expect([...many.keys()]).toEqual([2]);
    expect(many.get(2)).toBe("node x.js");
  });

  it("坏 JSON 当没有", () => {
    expect(parseProcessText("不是 JSON").size).toBe(0);
  });
});

describe("matchPortsToProjects", () => {
  const listening = [{ pid: 1234, ports: [5173] }, { pid: 5555, ports: [8000] }];
  const processes = parseProcessText(JSON.stringify([
    { ProcessId: 1234, ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: "\"C:\\Program Files\\nodejs\\node.exe\" D:\\work\\shop\\server.js" },
    { ProcessId: 5555, ExecutablePath: null, CommandLine: null },
  ]));

  it("命令行里带项目目录的进程归到那个项目；没有文字的跳过", () => {
    expect(matchPortsToProjects(["D:\\work\\shop", "D:\\work\\other"], listening, processes, "C:\\Users\\A"))
      .toEqual({ "D:\\work\\shop": [5173] });
  });

  it("最长项目优先，且不许前缀吃掉同前缀的兄弟目录", () => {
    const text = parseProcessText(JSON.stringify([
      { ProcessId: 1234, CommandLine: "node D:\\work\\shop-admin\\server.js" },
    ]));
    // shop-admin 与 shop 只差后缀：按边界判定，shop 不该命中
    expect(matchPortsToProjects(["D:\\work\\shop", "D:\\work\\shop-admin"], listening, text, "C:\\Users\\A"))
      .toEqual({ "D:\\work\\shop-admin": [5173] });
    // 兄弟目录不在清单里时，shop 也不能靠前缀命中
    expect(matchPortsToProjects(["D:\\work\\shop"], listening, text, "C:\\Users\\A")).toEqual({});
  });

  it("大小写与斜杠方向都不影响匹配，home 目录本身永远不认", () => {
    const text = parseProcessText(JSON.stringify([
      { ProcessId: 5555, CommandLine: "python d:/Work/Shop/app.py" },
    ]));
    expect(matchPortsToProjects(["D:\\Work\\Shop\\"], listening, text, "C:\\Users\\A"))
      .toEqual({ "D:\\Work\\Shop\\": [8000] });
    const home = parseProcessText(JSON.stringify([{ ProcessId: 5555, CommandLine: "node C:\\Users\\A\\x.js" }]));
    expect(matchPortsToProjects(["C:\\Users\\A"], listening, home, "C:\\Users\\A")).toEqual({});
  });
});

describe("attachPorts", () => {
  const base = (path: string): TrailProject => ({
    path, name: path, last_active: "2026-10-20", sessions: 1, tokens: 2, cost: 0, top_model: "", tools: [],
  });

  it("按路径贴回并排序；没端口的条目不凭空长出空数组", () => {
    const list = [base("D:\\work\\shop"), base("D:\\work\\other")];
    attachPorts(list, { "D:\\work\\shop": [8000, 5173] });
    expect(list[0].ports).toEqual([5173, 8000]);
    expect("ports" in list[1]).toBe(false);
  });
});
