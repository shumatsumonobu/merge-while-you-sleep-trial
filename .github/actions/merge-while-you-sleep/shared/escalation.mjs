// shared/escalation.mjs — 人への引き継ぎ（理由ごとの次にやること、コメントの印、ラベル）と、止め方
//   Stop  作業と下書きのジョブで止める。keepChanges が true なら、その時点の変更を PR にして残す
//   Halt  開始の確認と提出のジョブで止める

import { labels, repoFromEnv, runUrl } from "./github.mjs";

// ---------- 人への引き継ぎ ----------


/** 人への引き継ぎの理由（DESIGN.md の人への引き継ぎの表）。コードの中ではこの名前で扱う */
export const REASONS = {
  cannot_start: { title: "始められない", next: "設定か Issue か main を直して、下書きラベルか起動ラベルを付け直してください。sandbox と隔離が起動できないときは、runner の種類（GitHub ホストの Ubuntu）と入力を確かめてください。PR 用トークンを発行できないときは、App のインストール先と秘密鍵を確かめてください" },
  criteria_insufficient: { title: "完了条件が足りない", next: "完了条件を直して、下書きラベルか起動ラベルを付け直してください" },
  limit_reached: { title: "上限に達した", next: "PR を読んで自分で直すか、起動ラベルを付け直して続きから進めてください。下書きで止まったときは、下書きラベルを付け直してください" },
  undecidable: { title: "判定が決まらない", next: "PR とレポートを読んで判断してください。下書きで止まったときは、Issue を直して下書きラベルを付け直してください" },
  no_change: { title: "変更が無い", next: "Issue を閉じるか、完了条件を直して起動ラベルを付け直してください。続きから進めたときは、PR を読んで直すか、CI を再実行してください" },
  outside_allowlist: { title: "自動マージの範囲の外を変える", next: "PR を読んでマージしてください。変えさせないファイルは、人が変えてから起動ラベルを付け直してください" },
  not_merged: { title: "提出のあと自動マージまで進めない", next: "PR を直すか承認してください。起動ラベルを付け直せば、続きから進めます" },
  guard_tripped: { title: "守りが働いた", next: "実行のログを読んでください。鍵の文字列があったら、その鍵を作り直してください" },
  interrupted: { title: "途中で終わった", next: "実行のログを読み、下書きなら下書きラベル、実行なら起動ラベルを付け直してください" },
};

/**
 * Issue へのコメントの本文を組み立てる。決まった文字列のほかは呼ぶ側が消毒して渡す
 * 目印の HTML のコメントは画面に出ないが、各ジョブの本体が読む
 */
export function marker(kind, data = {}) {
  const payload = Buffer.from(JSON.stringify({ kind, run_id: process.env.GITHUB_RUN_ID, ...data })).toString("base64");
  return `<!-- merge-while-you-sleep:${payload} -->`;
}

export function readMarker(body) {
  const m = /<!-- merge-while-you-sleep:([A-Za-z0-9+/=]+) -->/.exec(String(body || ""));
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export async function comment(gh, issue, body) {
  const { full } = repoFromEnv();
  return gh.post(`/repos/${full}/issues/${issue}/comments`, { body });
}

export async function addLabel(gh, issue, name) {
  const { full } = repoFromEnv();
  await gh.post(`/repos/${full}/issues/${issue}/labels`, { labels: [name] });
}

export async function removeLabel(gh, issue, name) {
  const { full } = repoFromEnv();
  await gh.del(`/repos/${full}/issues/${issue}/labels/${encodeURIComponent(name)}`, { allow404: true });
}

/**
 * 人に引き継ぐ: 引き継ぎラベルを付け、起動した人を @メンションしてコメントし、起動ラベルを外す
 * （DESIGN.md の引き継ぎの方法）。details は消毒済みの文字列
 */
export async function escalate(gh, { issue, reason, mention, details = "", removeLabels = [], extra = {} }) {
  const r = REASONS[reason];
  if (!r) throw new Error(`知らない引き継ぎの理由: ${reason}`);
  const L = labels();
  await addLabel(gh, issue, L.escalation);
  const who = mention && /^[A-Za-z0-9-]+(\[bot\])?$/.test(mention) && !mention.endsWith("[bot]") ? `@${mention} ` : "";
  const body = [
    `${who}人への引き継ぎ: **${r.title}**`,
    "",
    details,
    "",
    `次にやること: ${r.next}`,
    "",
    `実行のログ: ${runUrl()}`,
    "",
    marker("escalation", { reason, ...extra }),
  ].join("\n");
  await comment(gh, issue, body);
  for (const l of removeLabels) await removeLabel(gh, issue, l);
}

// ---------- 止め方 ----------


/** 人への引き継ぎで止める。keepChanges が true なら、その時点の変更を PR にして残す */
export class Stop extends Error {
  constructor(reason, details = "", { keepChanges = true } = {}) {
    super(`${reason}: ${details}`);
    if (!REASONS[reason]) throw new Error(`知らない引き継ぎの理由: ${reason}`);
    this.reason = reason;
    this.details = details;
    this.keepChanges = keepChanges && !["guard_tripped", "interrupted", "cannot_start"].includes(reason);
  }
}

export class Halt extends Error {
  constructor(reason, details, extra = {}) {
    super(`${reason}: ${details}`);
    if (!REASONS[reason]) throw new Error(`知らない引き継ぎの理由: ${reason}`);
    this.reason = reason;
    this.details = details;
    this.extra = extra;
  }
}
