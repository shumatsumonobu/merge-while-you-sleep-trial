// shared/diff-scan.mjs — 足した行と消した行の照合（検査を無効にする書き方、外の画像）



// ---------- 足した行と消した行の照合（提出のジョブ）----------


/** 足した行にあれば範囲の外にする書き方（DESIGN.md の提出を別のジョブにする）。照合は正規化したあとの文字列 */
export const DEFAULT_DENY_PATTERNS = [
  "eslint-disable", "/*eslint", "@ts-nocheck", "@ts-ignore", "@ts-expect-error",
  "stryker disable", "istanbul ignore", "c8 ignore", "noqa", "type: ignore", "# mypy:",
  "pragma: no cover", "pylint: disable", "nolint", "#[allow(", "#![allow(", "#[expect(", "#![expect(",
  "#[mutants::skip]", "cfg_attr(", "pragma: no mutate", "@suppresswarnings",
];

/** 消した行にあれば範囲の外にする書き方 ── 無効化を戻す書き方と、検査を強める書き方 */
export const DEFAULT_DELETED_PATTERNS = [
  "stryker restore", "eslint-enable", "c8 ignore stop", "pragma: no mutate end", "pylint: enable", "nolintend",
  "@ts-check", "#![deny(", "#![forbid(",
];

/** 照合のための正規化: 改行と空白を取り除き、大文字小文字の違いを同じとみなす */
export function normalizeForMatch(s) {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * `git diff --text -U0` の出力から、ファイルごとに続けて足した行と消した行の塊を集める
 * @returns {{path:string, added:string[], deleted:string[]}[]}
 */
export function parseHunks(diffText) {
  const files = [];
  let cur = null;
  let run = null;
  let runKind = "";
  const flush = () => {
    if (cur && run) cur[runKind].push(run.join("\n"));
    run = null;
    runKind = "";
  };
  let inHunk = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { path: "", added: [], deleted: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    // ファイルの見出し（+++ と ---）は、そのファイルの最初の @@ より前にだけある
    // ── ハンクの中の、中身が「++ 」で始まる足した行を見出しと取り違えない
    if (!inHunk && line.startsWith("+++ ")) {
      cur.path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (!inHunk && !line.startsWith("@@")) continue;
    if (line.startsWith("@@")) {
      flush();
      inHunk = true;
      continue;
    }
    const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "deleted" : "";
    if (!kind) {
      flush();
      continue;
    }
    if (kind !== runKind) flush();
    if (!run) {
      run = [];
      runKind = kind;
    }
    run.push(line.slice(1));
  }
  flush();
  return files;
}

const EXTERNAL_IMAGE = [/!\[[^\]]*\]\(\s*<?https?:/i, /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i, /^\s*\[[^\]]+\]:\s*<?https?:/im];

/**
 * 足した行と消した行に、範囲の外にする書き方が無いかを見る
 * @returns {string[]} 見つかった理由（空なら無い）
 */
export function scanDiffText(diffText, { addPatterns = DEFAULT_DENY_PATTERNS, deletePatterns = [...DEFAULT_DENY_PATTERNS, ...DEFAULT_DELETED_PATTERNS] } = {}) {
  const found = [];
  const add = addPatterns.map(normalizeForMatch);
  const del = deletePatterns.map(normalizeForMatch);
  for (const f of parseHunks(diffText)) {
    for (const block of f.added) {
      const n = normalizeForMatch(block);
      for (const p of add) if (n.includes(p)) found.push(`${f.path}: 足した行に「${p}」`);
      if (EXTERNAL_IMAGE.some((r) => r.test(block))) found.push(`${f.path}: 足した行に外の画像`);
    }
    for (const block of f.deleted) {
      const n = normalizeForMatch(block);
      for (const p of del) if (n.includes(p)) found.push(`${f.path}: 消した行に「${p}」`);
    }
  }
  return [...new Set(found)];
}
