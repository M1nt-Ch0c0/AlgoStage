/** 判题运行文件本地构建：TS 转译器和 Pyodide 都随应用分发，无 CDN 请求。 */
import { build } from "esbuild";
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
const destination = "public/judge/pyodide-314.0.7";
mkdirSync(destination,{ recursive: true });
const source = resolve("node_modules/pyodide");
for (const name of readdirSync(source)) if (/\.(mjs|wasm|zip|json)$/.test(name)) copyFileSync(resolve(source,name),resolve(destination,name));
await build({ entryPoints: ["lib/judge/javascript-worker.ts","lib/judge/python-worker.ts"], outdir: "public/judge", outExtension: { ".js": ".mjs" }, bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, define: { process: "undefined" } });
console.log("判题 Worker 与 Pyodide 314.0.7 已构建到本地。");
