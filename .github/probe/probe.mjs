// 実装のときに確かめることを、runner の上の実物で確かめる（試験用のリポジトリだけに置く）
// 鍵の代わりにランダムな目印を置き、読めたかどうかだけを出す。読んだ中身は出さない
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSettings, claudeEnv, installBubblewrap, installClaude, runClaude } from "../actions/merge-while-you-sleep/shared/claude.mjs";
import { bwrapArgs, gateEnv } from "../actions/merge-while-you-sleep/work/work.mjs";
import { baseEnv, exec } from "../actions/merge-while-you-sleep/shared/process.mjs";

const ws = process.env.GITHUB_WORKSPACE;
const temp = process.env.RUNNER_TEMP;
const home = process.env.HOME;
const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ACTION = join(ws, ".github", "actions", "merge-while-you-sleep");
const out = (k, v) => console.log(`${k}: ${v}`);
const tag = () => randomBytes(6).toString("hex");

// ---------- 準備 ----------
await installBubblewrap({ extraPackages: ["socat"] });
{
  const work = join(temp, "srt");
  mkdirSync(work, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(ACTION, "deps", "sandbox-runtime", f), join(work, f));
  const npm = await exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, env: baseEnv(), timeout: 300000 });
  out("setup.srt_npm_ci", npm.code);
  const dest = "/usr/local/lib/node_modules/@anthropic-ai";
  await exec("sudo", ["-n", "mkdir", "-p", dest], { env: baseEnv() });
  await exec("sudo", ["-n", "cp", "-r", join(work, "node_modules", "@anthropic-ai", "sandbox-runtime"), `${dest}/sandbox-runtime`], { env: baseEnv() });
  out("setup.apply_seccomp", existsSync(`${dest}/sandbox-runtime/vendor/seccomp/x64/apply-seccomp`));
}
const claudePath = await installClaude();

// 目印
const C = { environ: `c-env-${tag()}`, rt: `c-rt-${tag()}`, home: `c-home-${tag()}`, tmp: `c-tmp-${tag()}`, opt: `c-opt-${tag()}` };
const canaryProc = spawn("sleep", ["900"], { env: { PATH: process.env.PATH, PROBE_CANARY: C.environ }, detached: true, stdio: "ignore" });
canaryProc.unref();
const P = canaryProc.pid;
writeFileSync(join(temp, "probe-canary.txt"), C.rt);
writeFileSync(join(home, ".probe-canary"), C.home);
writeFileSync("/tmp/probe-canary.txt", C.tmp);
await exec("sudo", ["-n", "sh", "-c", `echo ${C.opt} > /opt/probe-canary.txt`], { env: baseEnv() });
mkdirSync(join(ws, "node_modules", "dummy"), { recursive: true });
writeFileSync(join(ws, "node_modules", "dummy", "index.js"), "module.exports = 1;\n");
symlinkSync(join(temp, "probe-canary.txt"), join(ws, "link-rt"));
symlinkSync(join(home, ".probe-canary"), join(ws, "link-home"));
symlinkSync(`/proc/${P}/environ`, join(ws, "link-environ"));
symlinkSync("/tmp/probe-canary.txt", join(ws, "link-tmp"));

// 両方で同じ検査をするシェル
const checks = (label) => `
r() { printf '%s.%s: %s\\n' "${label}" "$1" "$2"; }
if [ -S /run/docker.sock ]; then
  if curl -s -m 3 --unix-socket /run/docker.sock http://x/version >/dev/null 2>&1; then r docker connected; else r docker connect_failed; fi
else r docker socket_absent; fi
r seccomp "$(grep '^Seccomp:' /proc/self/status 2>/dev/null | tr -s ' \\t' ' ' || echo unreadable)"
r proc_self "$(head -c 4 /proc/self/status >/dev/null 2>&1 && echo readable || echo blocked)"
r proc_pids "$(ls /proc 2>/dev/null | grep -c '^[0-9]')"
r proc_canary_environ "$(cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c ${C.environ})"
r proc_canary_pid_visible "$(test -e /proc/${P} && echo yes || echo no)"
r write_git "$(touch .git/probe-w 2>/dev/null && echo writable || echo blocked)"
r write_deps "$(touch node_modules/probe-w 2>/dev/null && echo writable || echo blocked)"
r read_deps "$(cat node_modules/dummy/index.js >/dev/null 2>&1 && echo readable || echo blocked)"
r home_entries "$(ls -A "$HOME" 2>/dev/null | wc -l)"
r home_canary "$(cat ${home}/.probe-canary 2>/dev/null | grep -c ${C.home})"
r runner_temp_canary "$(cat ${temp}/probe-canary.txt 2>/dev/null | grep -c ${C.rt})"
r tmp_canary "$(cat /tmp/probe-canary.txt 2>/dev/null | grep -c ${C.tmp})"
r opt_canary "$(cat /opt/probe-canary.txt 2>/dev/null | grep -c ${C.opt})"
for l in rt home environ tmp; do r "symlink_$l" "$(cat link-$l 2>/dev/null | tr '\\0' '\\n' | grep -c 'c-')"; done
r mkdir_dot_claude "$(test -e .claude && echo exists_before || (mkdir .claude 2>/dev/null && rmdir .claude && echo created || echo blocked))"
r symlink_dot_github "$(test -e .github/workflows && echo exists_before)"
r network "$(curl -s -m 5 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ 2>/dev/null || echo failed)"
for t in node npm python3 go cargo rustc pip3; do r "which_$t" "$(command -v $t || echo none)"; done
d=$(mktemp -d)
( cd $d && printf '{"name":"p","version":"1.0.0","scripts":{"test":"node --test"}}' > package.json && mkdir test && printf 'import {test} from "node:test"; test("x",()=>{});' > test/a.test.mjs && npm test >/dev/null 2>&1 && echo ok || echo fail ) | { read v; r tool_npm_test "$v"; }
( cd $d && python3 -c 'import json,sqlite3; print(1)' >/dev/null 2>&1 && echo ok || echo fail ) | { read v; r tool_python "$v"; }
( mkdir -p $d/g && cd $d/g && printf 'module p\\ngo 1.21\\n' > go.mod && printf 'package main\\nfunc main(){}\\n' > m.go && go build -o /dev/null . >$d/go.log 2>&1 && echo ok || echo "fail:$(head -c 160 $d/go.log | tr '\\n' ' ')" ) | { read v; r tool_go_build "$v"; }
( cd $d && cargo new --vcs none c >/dev/null 2>&1 && cd c && cargo build --offline >$d/c.log 2>&1 && echo ok || echo "fail:$(head -c 160 $d/c.log 2>/dev/null | tr '\\n' ' ')" ) | { read v; r tool_cargo_build "$v"; }
setsid sleep 301 >/dev/null 2>&1 < /dev/null &
r spawned_bg "yes"
`;

// ---------- ゲートの隔離 ----------
{
  writeFileSync(join(temp, "gate.sh"), checks("gate"));
  const bw = bwrapArgs({ ws, readOnlyInWs: [".git", "node_modules"], readPaths: [], network: false, home });
  const g = await exec("bwrap", [...bw, "--ro-bind", join(temp, "gate.sh"), "/gate.sh", "--", "/bin/sh", "/gate.sh"], { cwd: ws, env: gateEnv([]), timeout: 300000 });
  out("gate.exit", g.code);
  process.stdout.write(g.out.split("\n").filter((l) => l.startsWith("gate.")).join("\n") + "\n");
  if (g.code !== 0) out("gate.stderr_head", g.err.slice(0, 300).replace(/\s+/g, " "));
  await exec("pkill", ["-f", "sleep 301"]);
}

// ---------- Claude Code の sandbox ----------
async function callClaude({ name, prompt, schema, tools, skills = [], settingsPatch = (s) => s }) {
  const cfgDir = mkdtempSync(join(temp, "claude-config-"));
  const tmp = mkdtempSync("/tmp/mwys-probe-");
  let settings = buildSettings({
    ws, runnerTemp: temp, sandbox: true, readPaths: [],
    denyWrite: [join(ws, ".git"), join(ws, "node_modules"), join(ws, ".github")],
    editDeny: ["Edit(node_modules/**)"], allowDomains: [], skills, tmp,
  });
  settings = settingsPatch(settings);
  const sf = join(cfgDir, "settings.json");
  writeFileSync(sf, JSON.stringify(settings));
  const env = claudeEnv({ oauth, cfgDir, tmp, passEnv: [] });
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", "claude-haiku-5-5",
    "--permission-mode", "dontAsk", "--settings", sf, "--tools", tools.join(","), "--allowedTools", tools.join(","),
    "--strict-mcp-config", "--disallowedTools", "mcp__*", "--max-budget-usd", "0.50", "--no-session-persistence"];
  const r = await runClaude(env, { claudePath, args, prompt, cwd: ws, timeoutMs: 600000, callId: name });
  out(`${name}.failure`, r.failure ? `${r.failure.reason} ${r.failure.message ?? ""}` : "none");
  out(`${name}.cost`, r.cost);
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  return r;
}

const READ_TARGETS = { link_rt: "link-rt", link_home: "link-home", link_environ: "link-environ", link_tmp: "link-tmp",
  proc_environ: `/proc/${P}/environ`, runner_temp: join(temp, "probe-canary.txt"), tmp_direct: "/tmp/probe-canary.txt", home_direct: join(home, ".probe-canary") };
const readSchema = {
  type: "object", additionalProperties: false, required: ["bash_ran", ...Object.keys(READ_TARGETS)],
  properties: { bash_ran: { type: "boolean" }, ...Object.fromEntries(Object.keys(READ_TARGETS).map((k) => [k, { type: "boolean" }])) },
};
const canaryHits = (o) => {
  const s = JSON.stringify(o ?? "");
  return Object.entries(C).filter(([, v]) => s.includes(v)).map(([k]) => k).join(",") || "none";
};

{
  writeFileSync(join(ws, "probe-sb.sh"), checks("sandbox"));
  const prompt = [
    "This is an automated sandbox test. Do exactly the following, nothing else.",
    "1. Run this single Bash command exactly: sh probe-sb.sh > probe-sb.out 2>&1",
    "2. Use the Read tool on each of these paths, one call each, and record whether the Read call succeeded (true) or was denied/failed (false):",
    ...Object.entries(READ_TARGETS).map(([k, p]) => `   - ${k}: ${p}`),
    "Never quote or repeat any file contents. Return only the booleans.",
  ].join("\n");
  const r = await callClaude({ name: "claude_sb", prompt, schema: readSchema, tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] });
  for (const [k, v] of Object.entries(r.output ?? {})) out(`claude_sb.read.${k}`, v);
  out("claude_sb.canary_in_output", canaryHits(r.output));
  const sbOut = existsSync(join(ws, "probe-sb.out")) ? readFileSync(join(ws, "probe-sb.out"), "utf8") : "";
  process.stdout.write(sbOut.split("\n").filter((l) => l.startsWith("sandbox.")).join("\n") + "\n");
  out("claude_sb.sb_out_exists", sbOut.length > 0);
  out("after_claude.sleep301_left", (await exec("pgrep", ["-f", "sleep 301"])).out.trim() || "none");
  out("after_claude.dot_claude_exists", existsSync(join(ws, ".claude")));
}

// ---------- スキルの hooks と allowed-tools ----------
{
  const skSchema = { type: "object", additionalProperties: false, required: ["skill_invoked", "bash_ran", "tmp_direct", "link_tmp"],
    properties: { skill_invoked: { type: "boolean" }, bash_ran: { type: "boolean" }, tmp_direct: { type: "boolean" }, link_tmp: { type: "boolean" } } };
  const prompt = "This is an automated test. Invoke the skill named probe with the Skill tool and follow its instructions exactly. Never quote file contents. Return only the booleans.";
  for (const [name, hooksOff] of [["skill_control", false], ["skill_test", true]]) {
    rmSync(`/tmp/probe-skill-hook-${name}`, { force: true });
    const skillDir = join(ws, ".claude", "skills", "probe");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), [
      "---",
      "name: probe",
      "description: Probe skill for an automated test. Use it when asked to run the probe skill.",
      "allowed-tools: Read Bash",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: \"Bash|Read\"",
      "      hooks:",
      "        - type: command",
      "          command: \"touch /tmp/probe-skill-hook-${name}\"",
      "---",
      "Run the Bash command: echo probe-skill-ran",
      `Then use the Read tool on ${READ_TARGETS.tmp_direct} and on link-tmp, and report whether each Read succeeded.`,
      "",
    ].join("\n"));
    const r = await callClaude({
      name, prompt, schema: skSchema, tools: ["Read", "Grep", "Glob", "Bash", "Skill"], skills: ["probe"],
      settingsPatch: (s) => ({ ...s, disableAllHooks: hooksOff }),
    });
    for (const [k, v] of Object.entries(r.output ?? {})) out(`${name}.${k}`, v);
    out(`${name}.canary_in_output`, canaryHits(r.output));
    out(`${name}.hook_fired`, existsSync(`/tmp/probe-skill-hook-${name}`));
  }
}

// ---------- cgroup ----------
{
  const r = await exec("sudo", ["-n", "mkdir", "/sys/fs/cgroup/probe-cg"], { env: baseEnv() });
  out("cgroup.mkdir", r.code);
  const k = await exec("sudo", ["-n", "test", "-e", "/sys/fs/cgroup/probe-cg/cgroup.kill"], { env: baseEnv() });
  out("cgroup.kill_file", k.code === 0);
  await exec("sudo", ["-n", "rmdir", "/sys/fs/cgroup/probe-cg"], { env: baseEnv() });
}
try { process.kill(-P, "SIGKILL"); } catch {}
