// Rewrites Windows paths that a Windows build left in the Netlify server handler.
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const h = path.join(dir, "___netlify-server-handler.mjs");
let s = fs.readFileSync(h, "utf8");
s = s.replace(/'(\\var\\task[^']*)'/g, (_m, p) => "'" + p.replace(/\\/g, "/") + "'");
fs.writeFileSync(h, s);
const f = path.join(dir, "apps/web/.next/required-server-files.json");
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.appDir = "/var/task/apps/web";
j.relativeAppDir = "apps/web";
fs.writeFileSync(f, JSON.stringify(j));
const cfg = path.join(dir, "___netlify-server-handler.json");
const c = JSON.parse(fs.readFileSync(cfg, "utf8"));
console.log(s.match(/'[^']*var[^']*task[^']*'/g));
console.log(j.appDir, j.relativeAppDir, c.config.includedFilesBasePath);
