/**
 * 本机监听端口 → 项目目录：对应 usage.30s.py 的 `_detect_local_servers`（原版在 macOS 上用 lsof）。
 *
 * 原版两段：`lsof -iTCP -sTCP:LISTEN` 拿「pid → 端口」，再拿这些 pid 的 **cwd**，
 * cwd 等于项目目录或在它下面，就把端口归给那个项目（按最长项目名匹配，避免 home 吃掉一切）。
 *
 * Windows 没有无原生依赖的「读别的进程 cwd」的办法（要读 PEB），所以第二段换成
 * `netstat -ano` 的 pid + PowerShell `Win32_Process` 的「可执行文件路径 + 命令行」，
 * 在这段文字里按分隔符边界找项目目录。已知边界：`npm run dev` 这类 cwd 在项目里、
 * 但命令行本身不带项目路径的进程匹配不到；这也是原版在 Windows 上直接返回 {} 的原因，
 * 这里按任务要求补上能力，但不敢假装它和 cwd 一样准。
 *
 * 端口过滤与原版一致：只认 1024..65535 的 LISTENING（TCP）。
 */
import { execFile } from "child_process";
import * as os from "os";

export interface ListeningProcess {
  pid: number;
  ports: number[];
}

/** 对应原版 `1024 <= p <= 65535` */
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/**
 * 解析 `netstat -ano -p TCP`：只要 LISTENING 行，取本端地址最后一段端口。
 * 行形如 `  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    12345`，IPv6 是 `[::]:8080`。
 */
export function parseListeningPorts(output: string): ListeningProcess[] {
  const byPid = new Map<number, Set<number>>();
  for (const raw of output.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || cols[3].toUpperCase() !== "LISTENING") continue;
    const local = cols[1];
    const pid = Number(cols[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) continue;
    const ports = byPid.get(pid) ?? new Set<number>();
    ports.add(port);
    byPid.set(pid, ports);
  }
  return [...byPid].map(([pid, ports]) => ({ pid, ports: [...ports].sort((a, b) => a - b) }));
}

/**
 * 解析 PowerShell `Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine`
 * 的 ConvertTo-Json 输出（单条是对象、多条是数组；字段缺失是 null）。
 */
export function parseProcessText(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return out;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const pid = Number(item.ProcessId);
    if (!Number.isInteger(pid)) continue;
    const text = [item.ExecutablePath, item.CommandLine].filter((v) => typeof v === "string").join(" ");
    if (text) out.set(pid, text);
  }
  return out;
}

function normalizePathText(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 出现的路径后面得是分隔符/引号/空白/结尾，避免 `D:/work/app` 吃掉 `D:/work/application` */
function hasBoundary(text: string, end: number): boolean {
  if (end >= text.length) return true;
  return /[\s/"'`;,)\]]/.test(text[end]);
}

/**
 * 对应原版第 3 步的交叉匹配：每个 pid 的文字里按「最长项目优先」找项目目录。
 * 返回 `{项目路径: [端口...]}`，键是项目路径原文。
 */
export function matchPortsToProjects(
  projectPaths: string[],
  listening: ListeningProcess[],
  processText: Map<number, string>,
  home: string = os.homedir(),
): Record<string, number[]> {
  const projects = projectPaths
    .filter((p) => p && normalizePathText(p) !== normalizePathText(home))
    .map((p) => ({ path: p, key: normalizePathText(p) }))
    .filter((p) => p.key.length > 0)
    .sort((a, b) => b.key.length - a.key.length);
  const result = new Map<string, Set<number>>();
  for (const { pid, ports } of listening) {
    const text = normalizePathText(processText.get(pid) ?? "");
    if (!text) continue;
    for (const project of projects) {
      const at = text.indexOf(project.key);
      if (at >= 0 && hasBoundary(text, at + project.key.length)) {
        const set = result.get(project.path) ?? new Set<number>();
        for (const port of ports) set.add(port);
        result.set(project.path, set);
        break;
      }
    }
  }
  return Object.fromEntries([...result].map(([p, ports]) => [p, [...ports].sort((a, b) => a - b)]));
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      // 超时/命令不存在都当「没有端口」：足迹页不能因为这一路挂掉
      resolve(error && !stdout ? "" : String(stdout ?? ""));
    });
  });
}

/**
 * 对应 _detect_local_servers：拿不到就返回 {}（原版一样是 try/except 全吞）。
 * 非 Windows 直接返回 {}——这台机器的 lsof 那条路没有对应物，也不该去猜。
 */
export async function detectLocalServers(projectPaths: string[]): Promise<Record<string, number[]>> {
  if (process.platform !== "win32" || projectPaths.length === 0) return {};
  const netstat = await execText("netstat", ["-ano", "-p", "TCP"]);
  const listening = parseListeningPorts(netstat);
  if (!listening.length) return {};
  // 只查有监听端口的那几个 pid：全量 Get-CimInstance 在慢机器上要好几秒
  const filter = listening.map((p) => `ProcessId=${p.pid}`).join(" or ");
  const processes = await execText("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  ]);
  return matchPortsToProjects(projectPaths, listening, parseProcessText(processes));
}
