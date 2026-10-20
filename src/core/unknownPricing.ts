/**
 * 查漏补缺：对应 usage.30s.py 的 update_unknown()（15717-15767）。
 *
 * 把本机日志里见过、却没有「精确价」的模型名挑出来，能从同家族同档位抄到价就写进
 * pricing_overrides.json（models + aliases），抄不到的只留一条别名，让它至少归一到一个
 * 规范名上。全程不联网 —— 这是「全量更新」（core/priceUpdate.ts）的本地补充。
 */
import * as fs from "fs";
import * as path from "path";
import { loadJson, writablePath } from "./paths";
import { estimateFromSibling, isExactMatch, normalize, rawPrice, resolveId, SiblingEstimate } from "./price";
import { collectLocalModels } from "./localModels";

/** 对应 unknown 里的一行。键序照 Python 的字面量写：model → resolved_to → current → estimate。 */
export interface UnknownRow {
  model: string;
  resolved_to: string | null;
  current: { in: number; out: number };
  estimate: SiblingEstimate | null;
}

/** 对应 added 里的一条。price 是那份估价，里面带 source（写进 overrides 的那份不带）。 */
export interface UnknownAdded {
  model: string;
  canonical: string;
  price: SiblingEstimate | null;
  method: string;
}

export interface UpdateUnknownResult {
  /** 原版两条分支都 return 0；只有崩在磁盘上才是非 0，此时 stdout 为空串 */
  code: 0 | 1;
  /** 对应 print(json.dumps(result, ensure_ascii=False)) 的那一行，Swift 解析的就是它 */
  stdout: string;
  count: number;
  added: UnknownAdded[];
  file: string;
  message: string;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * json.dump(..., ensure_ascii=False) 的两个排版：不给 indent 就是 `", "` / `": "` 一行到底，
 * 给了就是每层缩进、行间换行。两种都保持键的插入顺序（不排序，和 sort_keys=True 的价目表相反：
 * overrides 是用户会手工编辑的文件，原版也没排序）。
 */
function jsonStringify(value: unknown, indent?: number): string {
  if (indent === undefined) {
    const inline = (v: unknown): string => {
      if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
      if (isObj(v)) {
        return `{${Object.entries(v).map(([k, item]) => `${JSON.stringify(k)}: ${inline(item)}`).join(", ")}}`;
      }
      return JSON.stringify(v ?? null);
    };
    return inline(value);
  }
  const render = (v: unknown, depth: number): string => {
    const pad = " ".repeat(indent * (depth + 1));
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return `[\n${v.map((item) => `${pad}${render(item, depth + 1)}`).join(",\n")}\n${" ".repeat(indent * depth)}]`;
    }
    if (isObj(v)) {
      const entries = Object.entries(v);
      if (!entries.length) return "{}";
      return `{\n${entries.map(([k, item]) => `${pad}${JSON.stringify(k)}: ${render(item, depth + 1)}`).join(",\n")}\n${" ".repeat(indent * depth)}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return render(value, 0);
}

/** 对应 sorted(models)：Python 按码位排，长度不同的前缀串短者在前。 */
function sortedModels(models: Iterable<string>): string[] {
  return [...new Set(models)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 对应 update_unknown()。
 * @param options.models 注入本机模型名（单测与冒烟用）；不传就现扫日志，和原版一样。
 */
export function updateUnknown(options: {
  resourceDir: string;
  models?: Iterable<string>;
}): UpdateUnknownResult {
  const overridesFile = writablePath("pricing_overrides.json", options.resourceDir);
  const models = options.models ? sortedModels(options.models) : sortedModels(collectLocalModels());

  const unknown: UnknownRow[] = [];
  for (const model of models) {
    if (isExactMatch(model)) continue;
    const resolvedTo = resolveId(model);
    const current = rawPrice(resolvedTo);
    unknown.push({
      model,
      resolved_to: resolvedTo,
      current: { in: current.in, out: current.out },
      estimate: estimateFromSibling(model),
    });
  }

  if (!unknown.length) {
    const stdout = jsonStringify({ status: "ok", message: "所有模型价格已匹配", count: 0, added: [] });
    return { code: 0, stdout, count: 0, added: [], file: overridesFile, message: "" };
  }

  // 原版：json.load 失败才给 {"models":{},"aliases":{}}；文件能读却缺 models 键时它直接 KeyError。
  // 这里把坏结构补成空表继续跑，差别只出现在用户手改坏了 overrides 的场合。
  const overrides = loadJson<Record<string, any>>(overridesFile, {});
  const ovr: Record<string, any> = isObj(overrides) ? overrides : {};
  if (!isObj(ovr.models)) ovr.models = {};
  if (!isObj(ovr.aliases)) ovr.aliases = {};

  const added: UnknownAdded[] = [];
  for (const row of unknown) {
    const name = row.model;
    const norm = normalize(name);
    if (!norm) continue;
    const estimate = row.estimate;
    if (estimate) {
      ovr.models[norm] = {
        in: estimate.in,
        out: estimate.out,
        cache_read: estimate.cache_read,
        cache_write: estimate.cache_write,
      };
      if (name !== norm) ovr.aliases[name] = norm;
      added.push({ model: name, canonical: norm, price: estimate, method: `estimated from ${estimate.source}` });
    } else {
      // 原版的写法是 `norm not in ovr.get("aliases", {})`：查的是规范名而不是本名，照抄。
      if (name !== norm && !(norm in ovr.aliases)) ovr.aliases[name] = norm;
      added.push({ model: name, canonical: norm, price: null, method: "no estimate available, using fallback" });
    }
  }

  try {
    fs.mkdirSync(path.dirname(overridesFile), { recursive: true });
    // 与抓价同一口径：先临时文件再改名，写一半坏掉不会把用户的 overrides 整份截断
    const tmp = `${overridesFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, jsonStringify(ovr, 2), "utf8");
    fs.renameSync(tmp, overridesFile);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      count: 0,
      added: [],
      file: overridesFile,
      message: `更新失败:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    code: 0,
    stdout: jsonStringify({ status: "ok", count: added.length, added }),
    count: added.length,
    added,
    file: overridesFile,
    message: "",
  };
}
