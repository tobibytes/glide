// Dev loop: vite dev server for the renderer + esbuild watch for main/preload + electron.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (n) => path.join(root, "node_modules/.bin", n);
const procs = [];
const run = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  procs.push(p);
  return p;
};
run("node", [path.join(root, "scripts/build-main.mjs")]).on("exit", () => {
  run("node", [path.join(root, "scripts/build-main.mjs"), "--watch"]);
  run(bin("vite"), []);
  setTimeout(() => run(bin("electron"), ["."], { GLIDE_DEV_SERVER: "http://localhost:5174" }), 1500);
});
process.on("SIGINT", () => { procs.forEach((p) => p.kill()); process.exit(0); });
