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
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
