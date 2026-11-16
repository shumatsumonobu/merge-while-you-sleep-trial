// sandbox の中のコマンドで sudo できるか、runner のユーザーのグループ、no_new_privs を確かめる（試験用のリポジトリだけに置く）
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSettings, claudeEnv, installBubblewrap, installClaude } from "../actions/merge-while-you-sleep/lib/claude.mjs";
import { makeGit } from "../actions/merge-while-you-sleep/lib/git.mjs";
import { baseEnv, exec } from "../actions/merge-while-you-sleep/lib/process.mjs";

const temp = process.env.RUNNER_TEMP;
const home = process.env.HOME;
const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ACTION = join(process.env.GITHUB_WORKSPACE, ".github", "actions", "merge-while-you-sleep");
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

// ---------- 準備（work.mjs の installSandboxDeps と同じ）----------
await installBubblewrap({ extraPackages: ["socat"] });
{
  const work = join(temp, "srt");
  mkdirSync(work, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(ACTION, "actions", "work", "sandbox-runtime", f), join(work, f));
  await exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, env: baseEnv(), timeout: 300000 });
  const dest = "/usr/local/lib/node_modules/@anthropic-ai";
  await exec("sudo", ["-n", "mkdir", "-p", dest], { env: baseEnv() });
  await exec("sudo", ["-n", "cp", "-r", join(work, "node_modules", "@anthropic-ai", "sandbox-runtime"), `${dest}/sandbox-runtime`], { env: baseEnv() });
}
const claudePath = await installClaude();

const ws = join(home, "work", "probe8-ws");
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
const git = makeGit(ws);
await git(["init", "-q", "-b", "main"]);
writeFileSync(join(ws, "a.txt"), "a\n");
await git(["add", "-A"]);
await git(["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "base"]);
const SH = [
  "r() { printf '%s: %s\n' \"$1\" \"$2\"; }",
  "r id \"$(id 2>&1)\"",
  "r sudo_n_true \"$(sudo -n true 2>&1; echo exit=$?)\"",
  "r sudo_n_id \"$(sudo -n id -u 2>&1 | tail -1)\"",
  "r no_new_privs \"$(grep NoNewPrivs /proc/self/status)\"",
  "r seccomp \"$(grep '^Seccomp:' /proc/self/status)\"",
  "r docker_sock \"$(ls -l /run/docker.sock 2>&1)\"",
].join("\n");
writeFileSync(join(ws, "probe.sh"), SH + "\n");
out("host.id", (await exec("id", [], {})).out.trim());
out("host.docker_sock", (await exec("ls", ["-l", "/run/docker.sock"], {})).out.trim());
const cfgDir = mkdtempSync(join(temp, "claude-config-"));
const tmp = mkdtempSync("/tmp/merge-while-you-sleep-");
const tools = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
const settings = buildSettings({ ws, runnerTemp: temp, sandbox: true, readPaths: [], denyWrite: [join(ws, ".git")], editDeny: [], allowDomains: [], skills: [], tmp });
const sf = join(cfgDir, "settings.json");
writeFileSync(sf, JSON.stringify(settings));
const env = claudeEnv({ oauth, cfgDir, tmp, passEnv: [] });
const schema = { type: "object", additionalProperties: false, required: ["bash_ran"], properties: { bash_ran: { type: "boolean" } } };
const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", "claude-sonnet-5-5",
  "--permission-mode", "dontAsk", "--settings", sf, "--tools", tools.join(","), "--allowedTools", tools.join(","),
  "--strict-mcp-config", "--disallowedTools", "mcp__*", "--max-budget-usd", "0.50", "--no-session-persistence"];
const r = await exec(claudePath, args, { cwd: ws, env, input: "Automated sandbox test. Run this single Bash command exactly, nothing else: sh probe.sh > probe.out 2>&1 . Then return bash_ran.", timeout: 600000 });
out("claude.exit", r.code);
console.log((await exec("cat", ["probe.out"], { cwd: ws })).out.split("\n").map((l) => "sb| " + l).join("\n"));
