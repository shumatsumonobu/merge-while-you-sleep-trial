// shared/git.mjs — git の呼び方（hooks と外部の差分のコマンドを止めた設定）、差分の読み方、ref の取得

import { createHash } from "node:crypto";
import { repoFromEnv } from "./github.mjs";
import { baseEnv, exec } from "./process.mjs";

// ---------- git ----------


/**
 * 各ジョブの本体が呼ぶ git。フックと外部の道具を使わず、置き換えの参照も使わない
 * （DESIGN.md のゲートのコマンドを隔離するの最後の項）
 */
export function makeGit(cwd, { env = {} } = {}) {
  const fixed = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "diff.external=",
    "-c", "protocol.ext.allow=never",
    "-c", "user.name=merge-while-you-sleep",
    "-c", "user.email=merge-while-you-sleep@users.noreply.github.com",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
  ];
  const genv = baseEnv({
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...env,
  });
  const git = async (args, opts = {}) => {
    const r = await exec("git", [...fixed, ...args], { cwd, env: genv, ...opts });
    if (r.code !== 0 && !opts.allowFail) {
      const e = new Error(`git ${args[0]} が終了コード ${r.code} で落ちた`);
      e.result = r;
      throw e;
    }
    return r;
  };
  git.cwd = cwd;
  return git;
}

/**
 * `git diff --raw --no-renames -z` の出力を読む。
 * 1件は「:旧モード 新モード 旧SHA 新SHA 状態 NUL パス NUL」
 */
export function parseRawDiff(out) {
  const parts = out.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length - 1; ) {
    const head = parts[i];
    if (!head.startsWith(":")) {
      i++;
      continue;
    }
    const [oldMode, newMode, oldSha, newSha, status] = head.slice(1).split(" ");
    entries.push({ oldMode, newMode, oldSha, newSha, status: status[0], path: parts[i + 1] });
    i += 2;
  }
  return entries;
}

export async function diffEntries(git, from, to) {
  const r = await git(["diff", "--raw", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", "--full-index", from, to]);
  return parseRawDiff(r.out);
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// ---------- 権限とラベルのイベント ----------

/** PR のブランチの先頭を取得する。トークンはコマンドの引数に入れず、環境変数の git の設定で渡す */
export async function fetchRef(git, gh, token, ref) {
  const { full } = repoFromEnv();
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const g = makeGit(git.cwd, {
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${server}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` },
  });
  await g(["fetch", "-q", "--no-tags", `${server}/${full}.git`, `+refs/heads/${ref}:refs/merge-while-you-sleep/pr`]);
  const sha = (await g(["rev-parse", "refs/merge-while-you-sleep/pr"])).out.trim();
  await g(["update-ref", "-d", "refs/merge-while-you-sleep/pr"]);
  return sha;
}
