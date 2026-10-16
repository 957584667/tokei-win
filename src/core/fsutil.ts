/** JSONL / 目录遍历工具：对应 usage.30s.py 的逐行解析与 rglob 扫描。 */
import * as fs from "fs";
import * as path from "path";

export interface FileEntry {
  file: string;
  dir: string;
  rel: string;
}

/** 深度优先遍历目录，按后缀过滤；符号链接目录不跟随，避免环。 */
export function walkFiles(root: string, extensions: string[] = [".jsonl"], limit = 20000): FileEntry[] {
  const out: FileEntry[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push({ file: full, dir, rel: path.relative(root, full) });
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** 对应 datetime.fromtimestamp(os.stat(...).st_mtime)：按修改时间排序用 */
export function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 逐行读取 JSON，坏行跳过（日志可能被并发追加截断，绝不因此整文件失败）。 */
export function readJsonLines(file: string): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return records;
  }
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text || text[0] !== "{") continue;
    try {
      records.push(JSON.parse(text));
    } catch {
      continue;
    }
  }
  return records;
}

/** 单行解析（增量回调场景，避免一次性载入超大 JSONL） */
export function forEachJsonLine(file: string, onRecord: (record: Record<string, any>, lineNumber: number) => void): void {
  forEachLine(file, (text, lineNumber) => {
    if (!text.startsWith("{")) return;
    try {
      onRecord(JSON.parse(text), lineNumber);
    } catch {
      /* 半行或损坏记录：跳过 */
    }
  });
}

/**
 * 分块流式逐行读取：185MB 级别的会话日志不能整体读进字符串，
 * 且需要能在命中关键字前跳过坏行。回调收到的是已 trim 的行文本。
 */
export function forEachLine(file: string, onLine: (text: string, lineNumber: number) => void, chunkSize = 1 << 20): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  const buffer = Buffer.allocUnsafe(chunkSize);
  let carry = "";
  let lineNumber = 0;
  try {
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, chunkSize, null);
      } catch {
        break;
      }
      if (read <= 0) break;
      const piece = carry + buffer.toString("utf8", 0, read);
      let start = 0;
      for (;;) {
        const nl = piece.indexOf("\n", start);
        if (nl === -1) {
          carry = piece.slice(start);
          break;
        }
        const text = piece.slice(start, nl).trim();
        start = nl + 1;
        lineNumber++;
        if (text) onLine(text, lineNumber);
        carry = "";
      }
    }
    if (carry.trim()) {
      lineNumber++;
      onLine(carry.trim(), lineNumber);
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }
}

export function readTextSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
