// 文字列の小さな関数

/**
 * 英数字以外を - にまとめ、小文字にする
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * n 文字を超えたら、n 文字に切って末尾を … にする
 * n が 0 以下なら空文字を返す
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function truncate(s, n) {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * 先頭の1文字が ASCII の a〜z のときだけ大文字にする
 * @param {string} s
 * @returns {string}
 */
export function capitalize(s) {
  const c = s.charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 32) + s.slice(1);
  return s;
}

/**
 * s を n 回くり返した文字列を返す
 * n が 0 以上の整数でなければ RangeError を投げる
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function repeat(s, n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError("n は 0 以上の整数にする");
  }
  return s.repeat(n);
}

/**
 * 小文字にし、続く空白を1つの - にまとめる
 * @param {string} s
 * @returns {string}
 */
export function kebab(s) {
  return s.toLowerCase().replace(/\s+/g, "-");
}

/**
 * 左に半角スペースを足して n 文字にする
 * s.length が n 以上なら s をそのまま返す
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function padLeft(s, n) {
  if (s.length >= n) return s;
  return " ".repeat(n - s.length) + s;
}

/**
 * 空白の位置で width 文字以内に折り返す（行の区切りは \n）
 * 続く空白は1つにまとめ、前後の空白は除く。width より長い語は width ごとに切る
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
export function wrapA(s, width) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError("width は 1 以上の整数にする");
  }
  const trimmed = s.trim();
  if (trimmed === "") return "";
  const lines = [];
  let current = "";
  for (const word of trimmed.split(/\s+/)) {
    const pieces = [];
    if (word.length > width) {
      for (let i = 0; i < word.length; i += width) {
        pieces.push(word.slice(i, i + width));
      }
    } else {
      pieces.push(word);
    }
    for (const w of pieces) {
      if (current === "") {
        current = w;
      } else if (current.length + 1 + w.length <= width) {
        current += " " + w;
      } else {
        lines.push(current);
        current = w;
      }
    }
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}

/**
 * 文字列を width 文字以内の行に折り返す。
 * 続く空白は1つにまとめ、前後の空白は除く。width より長い語は width ごとに切る。
 * @param {string} s
 * @param {number} width 1 以上の整数
 * @returns {string} 行を "\n" でつないだ文字列
 * @throws {RangeError} width が 1 未満または整数でないとき
 */
export function wrapB(s, width) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError("width は 1 以上の整数にする");
  }
  const trimmed = s.trim();
  if (trimmed === "") return "";
  const lines = [];
  let current = "";
  for (const word of trimmed.split(/\s+/)) {
    const pieces = [];
    for (let i = 0; i < word.length; i += width) {
      pieces.push(word.slice(i, i + width));
    }
    for (const piece of pieces) {
      if (current === "") {
        current = piece;
      } else if (current.length + 1 + piece.length <= width) {
        current += " " + piece;
      } else {
        lines.push(current);
        current = piece;
      }
    }
  }
  lines.push(current);
  return lines.join("\n");
}
