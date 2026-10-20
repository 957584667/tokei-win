/**
 * 对应 usage.30s.py 的 _scan_local_models()：把本机日志里出现过的模型名收一遍，
 * 交给「查漏补缺」（core/unknownPricing.ts）判断哪些名字还没有精确价。
 *
 * 只读不写，也不走扫描缓存：原版 `--update-unknown` 每次都是新进程重扫一遍日志，
 * 我们照做（缓存里的 mtime:size 签名会让「没重解析」的文件一条模型名都不吐出来，
 * 而那正是这里要的东西 —— 用户可能刚装完新价目表，需要一次全新的名单）。
 */
import { CLAUDE_DIR } from "../collectors/claude";
import { codebuddyRoots } from "../collectors/codebuddy";
import { geminiSessionFiles, loadGeminiUsageFile } from "../collectors/gemini";
import { piModelId, piSessionDirs, piServedModel, servedIdentity } from "../collectors/pi";
import { qwenSummaryFile, qwenTokenUsageFiles } from "../collectors/qwencode";
import { workbuddyRoots } from "../collectors/workbuddy";
import { forEachLine, walkFiles } from "./fsutil";

/** 对应 Python 的 `if '"model"' not in line: continue`：先用子串把绝大多数行挡在解析之外 */
function scanJsonl(file: string, needle: string, onRecord: (record: Record<string, any>) => void): void {
  forEachLine(file, (text) => {
    if (!text.includes(needle)) return;
    let record: Record<string, any>;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    if (record && typeof record === "object" && !Array.isArray(record)) onRecord(record);
  });
}

/** 对应 _qwen_read_jsonl()：整份文件每行都试解析，只收对象 */
function readJsonDicts(file: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  forEachLine(file, (text) => {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value);
    } catch {
      /* 坏行跳过 */
    }
  });
  return out;
}

export function collectLocalModels(): string[] {
  const models = new Set<string>();
  const add = (value: unknown) => {
    const name = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
    if (!name) return;
    models.add(name);
  };

  for (const { file } of walkFiles(CLAUDE_DIR)) {
    scanJsonl(file, '"model"', (record) => {
      const model = (record.message ?? {}).model ?? "";
      if (model && model !== "<synthetic>") add(model);
    });
  }

  for (const file of geminiSessionFiles()) {
    const parsed = loadGeminiUsageFile(file);
    if (!parsed) continue;
    for (const event of parsed.events ?? []) add(event?.model);
  }

  for (const root of piSessionDirs()) {
    for (const { file } of walkFiles(root)) {
      scanJsonl(file, '"usage"', (record) => {
        const message = record.message ?? {};
        if (message.role === "assistant") add(servedIdentity(piServedModel(message), piModelId(message)));
      });
    }
  }

  for (const root of [...workbuddyRoots(), ...codebuddyRoots()]) {
    for (const { file } of walkFiles(root)) {
      scanJsonl(file, '"usage"', (record) => {
        const providerData = record.providerData || (record.message ?? {}).providerData || {};
        add(providerData.requestModelName || providerData.requestModelId || providerData.model);
      });
    }
  }

  for (const file of qwenTokenUsageFiles()) {
    for (const record of readJsonDicts(file)) add(record.model);
  }

  const summary = qwenSummaryFile();
  if (summary) {
    for (const record of readJsonDicts(summary)) {
      const raw = record.models;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      for (const model of Object.keys(raw)) add(model);
    }
  }

  return [...models];
}
