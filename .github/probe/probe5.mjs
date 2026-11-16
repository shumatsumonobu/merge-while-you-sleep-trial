// ゲートを隔離したときに増える時間を測る（試験用のリポジトリだけに置く）
// 同じ npm test を、bubblewrap で隔離した形と隔離しない形で、交互に各5回実行する
import { join } from "node:path";
import { installBubblewrap } from "../actions/merge-while-you-sleep/shared/claude.mjs";
import { bwrapArgs, gateEnv } from "../actions/merge-while-you-sleep/work/work.mjs";
import { exec } from "../actions/merge-while-you-sleep/shared/process.mjs";

const ws = process.env.GITHUB_WORKSPACE;
const home = process.env.HOME;
const GATE_TOOL_DIRS = [
  "/opt/hostedtoolcache", "~/.cache/pip", "~/.cache/uv", "~/.cache/go-build", "~/.cache/yarn", "~/.cache/ms-playwright",
  "~/.local/bin", "~/.local/lib", "~/go", "~/.cargo/bin", "~/.cargo/registry", "~/.cargo/git", "~/.rustup", "~/.npm",
].map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p));

await installBubblewrap();
await exec("npm", ["test"], { cwd: ws, env: gateEnv([]), timeout: 300000 }); // 1回目のファイルの読み込みを測定から外す
const bw = bwrapArgs({ ws, readOnlyInWs: [".git"], readPaths: GATE_TOOL_DIRS, network: false, home });
const ms = { isolated: [], plain: [] };
for (let i = 0; i < 5; i++) {
  for (const kind of ["isolated", "plain"]) {
    const t = process.hrtime.bigint();
    const r = kind === "isolated"
      ? await exec("bwrap", [...bw, "--", "/bin/sh", "-c", "npm test"], { cwd: ws, env: gateEnv([]), timeout: 300000 })
      : await exec("/bin/sh", ["-c", "npm test"], { cwd: ws, env: gateEnv([]), timeout: 300000 });
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    ms[kind].push(Math.round(d));
    console.log(`measure.${kind}.${i}: ${Math.round(d)} ms exit=${r.code}`);
  }
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`measure.median: isolated ${med(ms.isolated)} ms, plain ${med(ms.plain)} ms, diff ${med(ms.isolated) - med(ms.plain)} ms`);
// bubblewrap の起動だけ（true を実行）
const t = [];
for (let i = 0; i < 5; i++) {
  const s = process.hrtime.bigint();
  await exec("bwrap", [...bw, "--", "/bin/true"], { cwd: ws, env: gateEnv([]) });
  t.push(Math.round(Number(process.hrtime.bigint() - s) / 1e6));
}
console.log(`measure.bwrap_true: ${t.join(" ")} ms`);
