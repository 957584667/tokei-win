/**
 * 项目足迹页的按需取数与行操作。
 *
 * 足迹不进 payload：payload 是给卡片用的区间汇总，逐项目明细只在打开这一页时算一次
 * （macOS 同样是按需 runScript(["--projects"])）。
 *
 * 行操作只认上一次清单里出现过的路径。渲染进程用 innerHTML 铺数据，一旦把任意字符串
 * 直接交给 spawn，就等于把「注入 → 本机执行目录」接通，所以这里用白名单挡一道。
 */
import { shell } from "electron";
import { spawn } from "child_process";
import { attachPorts, TrailProject, projectTrail } from "../core/trail";
import { detectLocalServers } from "./localPorts";

export type TrailTarget = "explorer" | "terminal" | "code";

export interface TrailOps {
  /** 端口探测是异步的（spawn netstat + PowerShell），调用方 await 即可 */
  list(cache: Record<string, any>): Promise<TrailProject[]>;
  /** 复制路径也走同一道白名单：面板只有拿到清单里的路径才该被写进剪贴板 */
  has(rawPath: unknown): boolean;
  run(rawPath: unknown, target: unknown): Promise<{ ok: boolean; message?: string }>;
}

export function makeTrailOps(): TrailOps {
  const allowed = new Set<string>();

  /**
   * 起一个外部程序，成功返回 null。spawn() 的 ENOENT 是异步报的（VS Code 没装时
   * 只会触发 error 事件），所以必须等 'spawn'/'error' 落定，不能「没抛异常就算成功」。
   */
  function runSpawn(command: string, args: string[], options: Record<string, any> = {}): Promise<string | null> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, ...options });
      } catch (e: any) {
        resolve(String(e?.message ?? e));
        return;
      }
      child.once("error", (err: any) => resolve(String(err?.message ?? err)));
      child.once("spawn", () => { child.unref(); resolve(null); });
    });
  }

  return {
    async list(cache) {
      const list = projectTrail(cache);
      allowed.clear();
      for (const item of list) allowed.add(item.path);
      // 端口探测要起两个子进程：只在打开这一页时跑一次，异步等它，别卡住主进程的托盘
      return attachPorts(list, await detectLocalServers(list.map((item) => item.path)));
    },

    has(rawPath) {
      return typeof rawPath === "string" && allowed.has(rawPath);
    },

    async run(rawPath, target) {
      if (typeof rawPath !== "string" || !allowed.has(rawPath)) return { ok: false, message: "路径不在项目清单里" };
      const kind = target as TrailTarget;
      if (kind === "explorer") {
        // openPath 走 ShellExecute，不经过命令行解析；Promise 解出的空串才是成功
        const failure = await shell.openPath(rawPath);
        return failure ? { ok: false, message: failure } : { ok: true };
      }
      if (kind === "terminal") {
        // cwd 传目录而不是把路径拼进命令串：路径里有 & 或引号也改变不了要执行的命令
        const failure = await runSpawn("cmd.exe", ["/K"], { cwd: rawPath });
        return failure ? { ok: false, message: `打不开终端：${failure}` } : { ok: true };
      }
      if (kind === "code") {
        const failure = await runSpawn("code", [rawPath]);
        return failure ? { ok: false, message: "没找到 code 命令（未安装或不在 PATH）" } : { ok: true };
      }
      return { ok: false, message: "未知的操作" };
    },
  };
}
