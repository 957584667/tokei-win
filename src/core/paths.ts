/**
 * 路径发现层：对应 usage.30s.py 的 HOME/APPDATA/LOCALAPPDATA、_expand_path、
 * _path_candidates、_first_existing_file、_existing_dirs。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const HOME = os.homedir();
export const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
export const LOCALAPPDATA =
  process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
export const TOKEI_DIR = path.join(HOME, ".tokei");

function expandVars(value: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
      const name = a || b;
      return process.env[name] ?? "";
    })
    .replace(/%([A-Za-z_][A-Za-z0-9_%]*)%/g, (_m, name: string) => process.env[name] ?? "");
}

/** 对应 _expand_path：trim → 展开 ~ 与变量 → 绝对化。空值返回 null。 */
export function expandPath(raw?: string | null): string | null {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value) return null;
  value = expandVars(value);
  if (value === "~") value = HOME;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = path.join(HOME, value.slice(2));
  return path.resolve(value);
}

function candidateKey(resolved: string): string {
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    /* 路径不存在时用原始值，与 Python 的 realpath 行为一致 */
  }
  return path.normalize(real).toLowerCase();
}

/**
 * 会话工作目录算不算「项目绝对路径」。Python 判的是 startswith("/")（macOS 只有 POSIX 根），
 * Windows 上同一列写成 D:\\work\\x 或 D:/work/x，所以换成平台相关的 isAbsolute，
 * 两种写法都收；空串、相对路径仍然不算项目。
 */
export function absoluteProjectPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return path.isAbsolute(value) ? value : null;
}

/** 对应 _path_candidates：环境变量（path.sep 分隔）优先，然后默认值；去重保序。 */
export function pathCandidates(envName: string, ...defaults: (string | null | undefined)[]): string[] {
  const values: string[] = [];
  const configured = process.env[envName] || "";
  if (configured) values.push(...configured.split(path.delimiter));
  for (const d of defaults) if (d) values.push(d);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const resolved = expandPath(value);
    if (!resolved) continue;
    const key = candidateKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/** 对应 _first_existing_file */
export function firstExistingFile(paths: string[]): string | null {
  return paths.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

/** 对应 _existing_dirs：只返回真实存在的目录，按 realpath 去重。 */
export function existingDirs(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    let stat: fs.Stats;
    let real: string;
    try {
      stat = fs.statSync(p);
      if (!stat.isDirectory()) continue;
      real = fs.realpathSync(p);
    } catch {
      continue;
    }
    const key = path.normalize(real).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(real);
  }
  return result;
}

export function isFile(p?: string | null): boolean {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(p?: string | null): boolean {
  if (!p) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 对应 _writable_path：优先 ~/.tokei/ 下的副本，其次资源目录，最后 ~/.tokei 路径。
 * 原版在 Windows/打包态会先把资源里那一份复制到 ~/.tokei 再返回副本（usage.30s.py:261-273）——
 * 抓价要往这个文件里写，安装目录多半不可写，不复制就只能整个跳过。
 * 复制必须带上源的 mtime：24 小时抓价水位读的就是这个时间，而 Node 的 copyFileSync 不保留，
 * 不补 utimes 的话新装完副本时间是「现在」，自动抓价要白等一整天才跑第一趟。
 */
export function writablePath(name: string, resourceDir: string): string {
  const user = path.join(TOKEI_DIR, name);
  if (isFile(user)) return user;
  const base = path.join(resourceDir, name);
  if (isFile(base)) {
    try {
      fs.mkdirSync(TOKEI_DIR, { recursive: true });
      fs.copyFileSync(base, user);
      const stat = fs.statSync(base);
      fs.utimesSync(user, stat.atime, stat.mtime);
    } catch {
      // 复制不动（只读介质、并发抢写）就退回用原件，别把价目表整个读没了
      return base;
    }
    return user;
  }
  return user;
}

export function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(file: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
