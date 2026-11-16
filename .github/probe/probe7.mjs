// スキルを名前ごとに許す形を、製品の関数と work.mjs の realClaude と同じ引数で試す（試験用のリポジトリだけに置く）
//   base: 土台のコミットのスキルのうち、hooks の無いもの（allowed-tools あり）は呼べ、hooks を書いたものは呼べない
//   fresh: 作業の中で下の階層に作ったスキルのうち、allowed-tools を書いたものは呼べない。何も書いていないものは呼べる（受け入れる）
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseSkills, buildSettings, claudeEnv, installBubblewrap, installClaude } from "../actions/merge-while-you-sleep/lib/claude.mjs";
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

const ws = join(home, "work", "probe7-ws");
rmSync(ws, { recursive: true, force: true });
const put = (p, s) => {
  mkdirSync(join(ws, p, ".."), { recursive: true });
  writeFileSync(join(ws, p), s);
};
put(".claude/skills/basic/SKILL.md", [
  "---", "name: basic", "description: Basic probe skill. Use it when asked to run the basic skill.", "allowed-tools: Bash", "---",
  "Run this single Bash command exactly: echo ran > basic.marker", "",
].join("\n"));
put(".claude/skills/hooked/SKILL.md", [
  "---", "name: hooked", "description: Hooked probe skill. Use it when asked to run the hooked skill.", "allowed-tools: Bash",
  "hooks:", "  PreToolUse:", "    - matcher: \"Bash\"", "      hooks:", "        - type: command", `          command: "touch ${ws}/hooked.hook"`,
  "---", "Run this single Bash command exactly: echo ran > hooked.marker", "",
].join("\n"));
put("sub/readme.txt", "sub directory\n");
put(".gitignore", "*.marker\n*.hook\n");
const git = makeGit(ws);
await git(["init", "-q", "-b", "main"]);
await git(["add", "-A"]);
await git(["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "base"]);
const files = (await git(["ls-files", "-z"])).out.split("\0").filter(Boolean);
const skills = baseSkills(ws, files);
out("skills.allowed", skills.allowed);
out("skills.excluded", skills.excluded);

// ---------- Claude Code を呼ぶ（realClaude と同じ: Skill は --tools にだけ入れ、--allowedTools には入れない）----------
async function call(name, prompt, schema) {
  const cfgDir = mkdtempSync(join(temp, "claude-config-"));
  const tmp = mkdtempSync("/tmp/merge-while-you-sleep-");
  const tools = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
  const available = [...tools, "Skill"];
  const settings = buildSettings({ ws, runnerTemp: temp, sandbox: true, readPaths: [],
    denyWrite: [join(ws, ".git"), join(ws, ".claude")], editDeny: [], allowDomains: [], skills: skills.allowed, tmp });
  out(`${name}.allow`, settings.permissions.allow);
  const sf = join(cfgDir, "settings.json");
  writeFileSync(sf, JSON.stringify(settings));
  const env = claudeEnv({ oauth, cfgDir, tmp, passEnv: [] });
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(schema), "--model", "claude-sonnet-5-5",
    "--permission-mode", "dontAsk", "--settings", sf, "--tools", available.join(","), "--allowedTools", tools.join(","),
    "--strict-mcp-config", "--disallowedTools", "mcp__*", "--max-budget-usd", "0.80", "--no-session-persistence"];
  const r = await exec(claudePath, args, { cwd: ws, env, input: prompt, timeout: 600000 });
  const pending = new Map();
  let result = null;
  const short = (t) => String(t ?? "").replace(/\s+/g, " ").slice(0, 200);
  for (const line of r.out.split("\n")) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant") for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_use") pending.set(c.id, `${c.name} ${short(c.input?.skill ?? c.input?.command ?? c.input?.file_path ?? "")}`);
    }
    if (ev.type === "user") for (const c of ev.message?.content ?? []) {
      if (c.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
      out(`${name}.tool`, `${pending.get(c.tool_use_id)} | error=${!!c.is_error} | ${short(text)}`);
    }
    if (ev.type === "result") result = ev;
  }
  out(`${name}.exit`, r.code);
  out(`${name}.cost`, result?.total_cost_usd);
  out(`${name}.permission_denials`, (result?.permission_denials ?? []).map((d) => `${d.tool_name} ${short(JSON.stringify(d.tool_input))}`));
  out(`${name}.self_report`, result?.structured_output);
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
}

const S = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

await call("base", [
  "Automated permission test. Do exactly these, nothing else:",
  "1. Invoke the skill named basic with the Skill tool and follow its instructions.",
  "2. Invoke the skill named hooked with the Skill tool and follow its instructions.",
  "Do not run any command that a skill did not give you. Report whether each Skill tool call was allowed.",
].join("\n"), S({ basic_allowed: { type: "boolean" }, hooked_allowed: { type: "boolean" } }));
out("base.basic_marker", existsSync(join(ws, "basic.marker")));
out("base.hooked_marker", existsSync(join(ws, "hooked.marker")));
out("base.hooked_hook", existsSync(join(ws, "hooked.hook")));

const FRESH = ["---", "name: fresh", "description: Fresh probe skill. Use it when asked to run the fresh skill.", "allowed-tools: Bash", "---",
  "Run this single Bash command exactly: echo ran > fresh.marker", ""].join("\\n");
const PLAIN = ["---", "name: freshplain", "description: Plain probe skill. Use it when asked to run the freshplain skill.", "---",
  "Reply with the word plain-ok and nothing else.", ""].join("\\n");
await call("fresh", [
  "Automated permission test. Do exactly these, nothing else:",
  `1. Run this single Bash command exactly: mkdir -p sub/.claude/skills/fresh sub/.claude/skills/freshplain && printf '%b' '${FRESH}' > sub/.claude/skills/fresh/SKILL.md && printf '%b' '${PLAIN}' > sub/.claude/skills/freshplain/SKILL.md`,
  "2. Use the Read tool on sub/readme.txt.",
  "3. Invoke the skill named fresh with the Skill tool. Do not run its command yourself.",
  "4. Invoke the skill named freshplain with the Skill tool.",
  "Report whether the Bash command succeeded and whether each Skill tool call was allowed.",
].join("\n"), S({ bash_ok: { type: "boolean" }, fresh_allowed: { type: "boolean" }, freshplain_allowed: { type: "boolean" } }));
out("fresh.files", existsSync(join(ws, "sub/.claude/skills/fresh/SKILL.md")));
out("fresh.marker", existsSync(join(ws, "fresh.marker")));
