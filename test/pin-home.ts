/**
 * 用例跑之前先把家目录钉到临时目录。
 *
 * 为什么要钉：core/paths.ts 在家目录上算出 TOKEI_DIR，价目表走 _writable_path 那套
 * 「~/.tokei 副本优先」（本机装过一次就会留下副本）。副本一存在，采集器夹具读到的就是
 * 开发者本机那张 507 条的价目表 —— 模型名跟着目录归一、成本不再是 0，断言会随本机状态漂。
 * 自己会改 HOME 并 resetModules 的夹具（pricing / pricing-fingerprint / pricing-update）不受影响：
 * 它们在用例里再覆盖一次。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const pin = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-home-pin-"));
process.env.HOME = pin;
process.env.USERPROFILE = pin;
