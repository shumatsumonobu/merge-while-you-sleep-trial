// shared/sanitize.mjs — 文面の消毒（見えない文字、メンション、Issue を閉じる語、リンク、鍵の値）



// ---------- 文面の消毒 ----------


/**
 * Claude Code に渡す前に、画面に出ない文字を除く（DESIGN.md の指示文と Claude Code に渡すもの）
 * HTML のコメント、幅の無い文字、文字の向きを変える制御文字
 */
export function stripInvisible(s) {
  return String(s || "")
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u180E]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Issue を閉じるキーワード（Linking a pull request to an issue） */
const CLOSING = /\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b/gi;

/**
 * Claude Code が書いた部分と Issue の文面を、外に出す前に消毒する（DESIGN.md の出口で消す、提出のジョブの決まり）
 * - 鍵の文字列を消す
 * - 画像、HTML、リンクを除く（リンクは URL を文字のまま残す）
 * - @ を全角の ＠ に変え、Issue を閉じるキーワードを効かない形にする
 */
export function sanitizeOutbound(s, secrets = []) {
  let t = stripInvisible(s);
  for (const k of secrets) if (k && k.length >= 8) t = t.split(k).join("[消した]");
  t = t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/^\s*\[[^\]]+\]:.*$/gm, "")
    .replace(/<[^>]*>/g, "")
    .replace(/https?:\/\/[^\s)<>`]+/g, (u) => `\`${u}\``)
    .replace(/@/g, "＠")
    .replace(/#(?=\d)/g, "#\u200B")
    .replace(CLOSING, (w) => `${w[0]}\u200B${w.slice(1)}`);
  return t;
}

/** 鍵の文字列だけを消す（コードブロックに入れる完了条件など、ほかの消毒をしない文面に使う） */
export function scrubSecrets(s, secrets = []) {
  let t = String(s ?? "");
  for (const k of secrets) if (k && k.length >= 8) t = t.split(k).join("[消した]");
  return t;
}

/** 消毒した文面をコードブロックに入れる ── Markdown として解釈させず、書いた文字を全部画面に出す */
export function codeBlock(s) {
  const t = String(s || "");
  let fence = "```";
  while (t.includes(fence)) fence += "`";
  return `${fence}text\n${t}\n${fence}`;
}

/** コミットのメッセージに、Issue を閉じるキーワードか @ があるか */
export function hasClosingOrMention(msg) {
  CLOSING.lastIndex = 0;
  return /@/.test(msg) || /\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b\s*:?\s*(#|[\w.-]+\/[\w.-]+#|https?:\/\/)/i.test(msg);
}
