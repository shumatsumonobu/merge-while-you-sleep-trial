// ゲートの道具を、製品の既定で見せるディレクトリで確かめる（試験用のリポジトリだけに置く）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBubblewrap } from "../actions/merge-while-you-sleep/shared/claude.mjs";
import { bwrapArgs, gateEnv } from "../actions/merge-while-you-sleep/work/work.mjs";
import { baseEnv, exec } from "../actions/merge-while-you-sleep/shared/process.mjs";

const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const home = process.env.HOME;
// work/work.mjs の GATE_TOOL_DIRS と同じ（export していないので写す）
const GATE_TOOL_DIRS = [
  "/opt/hostedtoolcache", "~/.cache/pip", "~/.cache/uv", "~/.cache/go-build", "~/.cache/yarn", "~/.cache/ms-playwright",
  "~/.local/bin", "~/.local/lib", "~/go", "~/.cargo/bin", "~/.cargo/registry", "~/.cargo/git", "~/.rustup", "~/.npm",
].map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p));

await installBubblewrap();
out("host.go", (await exec("sh", ["-c", "command -v go && readlink -f $(command -v go)"])).out.trim().replace(/\n/g, " -> "));

// vitest を入れた小さいプロジェクト（依存は準備の step が入れる想定なので、ゲートの外で入れる）
const p = join(process.env.RUNNER_TEMP, "vt");
mkdirSync(join(p, "test"), { recursive: true });
writeFileSync(join(p, "package.json"), JSON.stringify({ name: "vt", version: "1.0.0", type: "module", scripts: { test: "vitest run" } }));
writeFileSync(join(p, "test", "a.test.js"), 'import { test, expect } from "vitest"; test("x", () => expect(1).toBe(1));\n');
const inst = await exec("npm", ["install", "--no-audit", "--no-fund", "vitest@3.2.4"], { cwd: p, env: baseEnv(), timeout: 300000 });
out("setup.vitest_install", inst.code);
await exec("git", ["init", "-q"], { cwd: p });

async function gate(name, cmd, readOnlyInWs) {
  const bw = bwrapArgs({ ws: p, readOnlyInWs, readPaths: GATE_TOOL_DIRS, network: false, home });
  const r = await exec("bwrap", [...bw, "--", "/bin/sh", "-c", cmd], { cwd: p, env: gateEnv([]), timeout: 300000 });
  const tail = `${r.out}\n${r.err}`.replace(/\s+/g, " ").trim().slice(-300);
  out(name, `exit=${r.code} | ${tail}`);
}
await gate("gate.vitest_deps_ro", "npm test", [".git", "node_modules"]);
await exec("sh", ["-c", "ls -d node_modules/.vite* node_modules/.vite/* 2>&1 | head -5"], { cwd: p }).then((r) => out("after.vite_cache", r.out.trim().replace(/\n/g, " ")));
await gate("gate.vitest_deps_rw", "npm test", [".git"]);
await gate("gate.go_version", "go version", [".git"]);
mkdirSync(join(p, "g"), { recursive: true });
writeFileSync(join(p, "g", "go.mod"), "module p\ngo 1.21\n");
writeFileSync(join(p, "g", "m.go"), "package main\nfunc main(){}\n");
await gate("gate.go_build", "cd g && go build -o /dev/null .", [".git"]);
await gate("gate.cargo", "command -v cargo || echo none", [".git"]);
await exec("sh", ["-c", "cargo new --vcs none c >/dev/null 2>&1"], { cwd: p, env: { ...baseEnv(), PATH: `${home}/.cargo/bin:${process.env.PATH}` } });
await gate("gate.cargo_build", "cd c && cargo build --offline 2>&1 | tail -3", [".git"]);
