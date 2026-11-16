// lib/process.mjs — 子プロセスの起動と、子プロセスに渡す環境変数

import { spawn } from "node:child_process";
import { input } from "./actions.mjs";

// ---------- 子プロセス ----------


/**
 * 子プロセスを1つ起動し、終わるまで待つ。例外を投げない ── 起動できなければ code: -1
 * 環境変数は呼ぶ側が全部決める（process.env を引き継がない）── 鍵を子に渡さないため
 *
 * @returns {Promise<{code:number, out:string, err:string, timedOut:boolean}>}
 */
export function exec(cmd, args, { cwd, env = {}, input: stdin, timeout = 0, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let p;
    try {
      p = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ code: -1, out, err: String(e), timedOut });
      return;
    }
    const cap = (s, d) => (s.length > maxBuffer ? s : s + d);
    p.stdout.on("data", (d) => (out = cap(out, d)));
    p.stderr.on("data", (d) => (err = cap(err, d)));
    let timer;
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {
          p.kill("SIGKILL");
        }
      }, timeout);
    }
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e), timedOut });
    });
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : -1), out, err, timedOut });
    });
    if (stdin !== undefined) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

/** 子プロセスに渡してよい、鍵を含まない最小の環境変数 */
export function baseEnv(extra = {}) {
  const env = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

// ---------- 作業のジョブの外側（準備、bundle、出力）----------

export async function which(cmd) {
  const r = await exec("sh", ["-c", `command -v ${cmd}`], { env: baseEnv() });
  return r.code === 0 ? r.out.trim() : null;
}

// ---------- ゲートと Claude Code に渡す環境変数 ----------

export const GATE_ENV_NAMES = [
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "CI", "JAVA_HOME", "GOROOT", "GOPATH", "pythonLocation", "PKG_CONFIG_PATH",
];

const NEVER_PASS = (name) =>
  name.startsWith("INPUT_") || name.startsWith("ACTIONS_") ||
  ["GITHUB_TOKEN", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name);

export const GATE_SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

export function gateEnv(passEnv) {
  const env = {};
  for (const n of [...GATE_ENV_NAMES, ...passEnv]) {
    if (NEVER_PASS(n)) continue;
    if (process.env[n] !== undefined) env[n] = process.env[n];
  }
  env.TMPDIR = "/tmp";
  return env;
}
