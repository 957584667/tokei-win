/** 临时自检：渲染进程写的设置键是否都在主进程 schema 里 */
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.resolve(__dirname, "../renderer/app.js"), "utf8");
const st = fs.readFileSync(path.resolve(__dirname, "../src/main/settings.ts"), "utf8");
const mainJs = fs.readFileSync(path.resolve(__dirname, "../src/main/index.ts"), "utf8");

const known = new Set([...st.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]));
const used = new Set();
for (const re of [/save\(\{\s*([a-z_]+)/g, /setSettings\(\{\s*([a-z_]+)/g, /patch\.([a-z_]+)/g]) {
  for (const m of app.matchAll(re)) used.add(m[1]);
}
// 动态键：save({ [key]: value }) 之类
const dynamic = [...app.matchAll(/\[\s*(?:k|key|name)\s*\]\s*:/g)].length;
console.log("settings.ts 声明:", [...known].join(" "));
console.log("渲染进程写入:", [...used].sort().join(" "));
console.log("未声明的键:", [...used].filter((u) => !known.has(u)).join(" ") || "无");
console.log("动态键写入处:", dynamic);
console.log("主进程读的设置键（抽样校对）:",
  [...new Set([...mainJs.matchAll(/settings\.([a-z_]+)/g)].map((m) => m[1]))].join(" "));
