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
