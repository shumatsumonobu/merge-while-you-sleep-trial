// 実装のあとで試すこと（攻撃の筋書き）を、製品の関数で試す（試験用のリポジトリだけに置く）
//   a: ゲートのコードが作った入れ子のリポジトリと ignore されたファイルが、作業ツリーを戻すと消える
//   b: --tools で許していないツールを呼べない
//   c: Claude Code の呼び出しのあとに、sandbox の中で起動したプロセスが残らない（runClaude）
//   d: 作業ディレクトリの根にまだ無い .claude と .github を、sandbox の中のコマンドが作れても、照合で止まる
//   e: 既定で見せるディレクトリで、sandbox の中の go、cargo、npm が動く
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSettings, claudeEnv, installBubblewrap, installClaude, runClaude } from "../actions/merge-while-you-sleep/shared/claude.mjs";
import { bwrapArgs, claudeDirEntries, compareSnapshots, gateEnv, protectedSnapshot, removeClaudeArtifacts, resetTree } from "../actions/merge-while-you-sleep/work/work.mjs";
import { makeGit } from "../actions/merge-while-you-sleep/shared/git.mjs";
import { baseEnv, exec } from "../actions/merge-while-you-sleep/shared/process.mjs";

const temp = process.env.RUNNER_TEMP;
const home = process.env.HOME;
const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ACTION = join(process.env.GITHUB_WORKSPACE, ".github", "actions", "merge-while-you-sleep");
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const GATE_TOOL_DIRS = [
  "/opt/hostedtoolcache", "~/.cache/pip", "~/.cache/uv", "~/.cache/go-build", "~/.cache/yarn", "~/.cache/ms-playwright",
  "~/.local/bin", "~/.local/lib", "~/go", "~/.cargo/bin", "~/.cargo/registry", "~/.cargo/git", "~/.rustup", "~/.npm",
].map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p));

// ---------- 準備 ----------
await installBubblewrap({ extraPackages: ["socat"] });
{
  const work = join(temp, "srt");
  mkdirSync(work, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(ACTION, "deps", "sandbox-runtime", f), join(work, f));
  await exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, env: baseEnv(), timeout: 300000 });
  const dest = "/usr/local/lib/node_modules/@anthropic-ai";
  await exec("sudo", ["-n", "mkdir", "-p", dest], { env: baseEnv() });
  await exec("sudo", ["-n", "cp", "-r", join(work, "node_modules", "@anthropic-ai", "sandbox-runtime"), `${dest}/sandbox-runtime`], { env: baseEnv() });
}
const claudePath = await installClaude();

// .claude も .github も無い作業ディレクトリ（ホームの下。RUNNER_TEMP の下は deny ルールで読めない）
const ws = join(home, "work", "probe-ws");
rmSync(ws, { recursive: true, force: true });
mkdirSync(join(ws, "src"), { recursive: true });
writeFileSync(join(ws, "src", "a.js"), "export const a = 1;\n");
writeFileSync(join(ws, ".gitignore"), "ignored.txt\nnode_modules/\n");
mkdirSync(join(ws, "node_modules"), { recursive: true });
const git = makeGit(ws);
await git(["init", "-q", "-b", "main"]);
await git(["add", "-A"]);
await git(["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "base"]);
const base = (await git(["rev-parse", "HEAD"])).out.trim();
const keep = ["node_modules"];
const S = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

// ---------- Claude Code を呼ぶ（work.mjs の realClaude と同じ設定）----------
async function call(name, { prompt, tools, schema }) {
  const cfgDir = mkdtempSync(join(temp, "claude-config-"));
  const tmp = mkdtempSync("/tmp/merge-while-you-sleep-");
  const settings = buildSettings({ ws, runnerTemp: temp, sandbox: true, readPaths: GATE_TOOL_DIRS,
    denyWrite: [join(ws, ".git"), join(ws, "node_modules")], editDeny: ["Edit(node_modules/**)"], allowDomains: [], skills: [], tmp });
  const sf = join(cfgDir, "settings.json");
  writeFileSync(sf, JSON.stringify(settings));
  const env = claudeEnv({ oauth, cfgDir, tmp, passEnv: [] });
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", "claude-sonnet-5-5",
    "--permission-mode", "dontAsk", "--settings", sf, "--tools", tools.join(","), "--allowedTools", tools.join(","),
    "--strict-mcp-config", "--disallowedTools", "mcp__*", "--max-budget-usd", "0.80", "--no-session-persistence"];
  const r = await runClaude(env, { claudePath, args, prompt, cwd: ws, timeoutMs: 600000, callId: name });
  out(`${name}.failure`, r.failure ? `${r.failure.reason} ${r.failure.details ?? ""}` : "none");
  out(`${name}.cost`, r.cost);
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  return r.output;
}



const LS = "for p in /home/runner/.cargo/bin /home/runner/.cargo/bin/cargo /home/runner/.cargo/bin/rustup /home/runner/.rustup /home/runner/.rustup/toolchains; do echo \"== $p\"; ls -la \"$p\" 2>&1 | head -8; echo \"real: $(readlink -f \"$p\" 2>&1)\"; done";
const h = await exec("sh", ["-c", LS]);
console.log("HOST\n" + h.out.replace(/^/gm, "host| "));
writeFileSync(join(ws, "probe.sh"), LS + "\n");
await call("cargo", { tools: ["Bash"], prompt: "Automated sandbox test. Run this single Bash command exactly: sh probe.sh > probe.out 2>&1 . Then return bash_ran true if it ran. Call no other tool.", schema: S({ bash_ran: { type: "boolean" } }) });
const o = (await exec("cat", ["probe.out"], { cwd: ws })).out;
console.log("SANDBOX\n" + o.replace(/^/gm, "sb| "));
