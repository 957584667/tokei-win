const fs = require("fs");
for (const n of process.argv.slice(2)) {
  const t = fs.readFileSync(`scratch/dom-${n}.txt`, "utf8");
  const err = t.match(/<pre id="boot-error">([\s\S]*?)<\/pre>/);
  const m = t.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
  const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  console.log(err ? "!! " + dec(err[1]) + "\n" : "");
  console.log(m ? dec(m[1]) : "(no probe)");
  console.log("");
}
