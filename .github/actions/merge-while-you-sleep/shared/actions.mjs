// shared/actions.mjs — GitHub Actions とのやりとり（入力、出力、状態、ログ、伏せ字、RUNNER_TEMP）

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------- GitHub Actions とのやりとり ----------


/** action の入力を読む。GitHub は入力を INPUT_<名前の大文字> の環境変数で渡す（Metadata syntax） */
export function input(name, def = "") {
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v.trim() === "" ? def : v.trim();
}

export function inputBool(name, def = false) {
  const v = input(name, String(def)).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export function inputNumber(name, def) {
  const v = Number(input(name, String(def)));
  if (!Number.isFinite(v)) throw new Error(`入力 ${name} が数ではない`);
  return v;
}

/** 入力の一覧（改行かカンマで区切る。# で始まる行は注釈） */
export function splitList(s) {
  return String(s || "")
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#"));
}

const RAW_OUTPUT = /^[A-Za-z0-9._:/-]*$/;

/**
 * step の出力を書く。値は1行にする ── 複数行の書き方は、値の中に区切りの行があると
 * ほかの出力を書き換えられる（DESIGN.md の出口で消す）。
 * 文字列でない値と、決まった文字だけでできていない値は JSON にする
 */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const line = typeof value === "string" && RAW_OUTPUT.test(value) ? value : JSON.stringify(value);
  if (/[\r\n]/.test(line)) throw new Error("出力が1行にならない");
  if (file) appendFileSync(file, `${name}=${line}\n`);
}

/** post の step に渡す値（GITHUB_STATE）。post では STATE_<名前> で読める */
export function saveState(name, value) {
  const file = process.env.GITHUB_STATE;
  const line = String(value);
  if (!RAW_OUTPUT.test(line)) throw new Error("state の値に使えない文字がある");
  if (file) appendFileSync(file, `${name}=${line}\n`);
}

export function getState(name) {
  return process.env[`STATE_${name}`] || "";
}

/**
 * ログに出す。出すのは工程の名前、終了コード、コストだけ（DESIGN.md の出口で消す）。
 * 呼ぶ側は Claude Code の出力もゲートの出力も渡さないが、念のため行頭の :: を崩す
 * ── 標準出力の :: で始まる行は、ワークフローのコマンドとして解釈されうる
 */
export function log(msg) {
  const s = String(msg)
    .split("\n")
    .map((l) => (l.startsWith("::") ? ` ${l}` : l))
    .join("\n");
  process.stdout.write(`${s}\n`);
}

/** 値をログで伏せる（::add-mask::）。鍵の文字列にだけ使う */
export function mask(value) {
  if (value && !/[\r\n]/.test(value)) process.stdout.write(`::add-mask::${value}\n`);
}

// ---------- 作業のジョブの外側（準備、bundle、出力）----------


export function runnerTemp() {
  return process.env.RUNNER_TEMP || tmpdir();
}
