/**
 * 每个用例启动一个不继承环境变量、无文件/进程权限的 Node 子进程。
 * 用户代码仅收到 VM 内创建的值；不注入宿主函数、process、require 或预期答案。
 * 比较答案始终留在父进程，子进程只能返回实际值，不能上报 verdict。
 */
export const NODE_RUNNER = String.raw`
const { Script, createContext } = require('node:vm');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  const input = JSON.parse(raw);
  // 悬空 Promise 也必须等待父进程的墙钟超时，不能静默退出。
  const keepAlive = setInterval(() => {}, 1000);
  process.stdout.write('ready\n');
  let reply;
  try {
    const context = createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    });
    const selector = input.entryPoints.map(name =>
      'if (typeof ' + name + ' === "function") return ' + name + ';'
    ).join('\n');
    const script = new Script('(async () => {\n' +
      'const stringify = JSON.stringify, toString = String;\n' +
      'let stdout = "", bytes = 0, exceeded = false;\n' +
      'const size = text => { let n = 0; for (const ch of text) { const c = ch.codePointAt(0); n += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4; } return n; };\n' +
      'const print = (...values) => { const text = values.map(toString).join(" ") + "\\n"; bytes += size(text); if (bytes > 32768) { exceeded = true; throw new Error("输出超过 32 KiB"); } stdout += text; };\n' +
      'const console = { log: print, info: print, warn: print, error: print, debug: print };\n' +
      'const args = JSON.parse(' + JSON.stringify(JSON.stringify(input.args)) + ');\n' +
      'const fn = (() => {\n' + input.code + '\n' + selector + '\nthrow new Error("没有找到题目入口函数");\n})();\n' +
      'const returned = await fn(...args);\n' +
      'if (exceeded) throw new Error("输出超过 32 KiB");\n' +
      'const actual = stringify(' + (input.mutatesArg === undefined ? 'returned' : 'args[' + input.mutatesArg + ']') + ');\n' +
      'if (actual !== undefined && size(actual) > 32768) throw new Error("返回值超过 32 KiB");\n' +
      'return stringify({ actual, stdout });\n' +
      '})()', { filename: 'submission.js' });
    const value = await script.runInContext(context, { timeout: input.timeLimitMs });
    reply = { value };
  } catch (error) {
    reply = { error: String(error).slice(0, 2000), timeout: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' };
  }
  clearInterval(keepAlive);
  process.stdout.write(JSON.stringify(reply), () => process.exit(0));
});
`;
