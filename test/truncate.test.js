import assert from "node:assert/strict";
import { test } from "node:test";
import { truncate } from "../src/strings.js";

test("truncate: 既存の動きを保つ (完了条件1)", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

test("truncate: n が s の長さと同じなら切らない (完了条件2)", () => {
  assert.equal(truncate("abcdef", 6), "abcdef");
});

test("truncate: n = 1 で s が長いと … を返す (完了条件3)", () => {
  assert.equal(truncate("abcdef", 1), "…");
});

test("truncate: n = 0 で s が空でないと空文字を返す (完了条件4)", () => {
  assert.equal(truncate("abcdef", 0), "");
});

test("truncate: n = 0 で s が空なら空文字を返す (完了条件5)", () => {
  assert.equal(truncate("", 0), "");
});

test("truncate: n が負で s が空でないと空文字を返し、例外を投げない (完了条件6)", () => {
  let result;
  assert.doesNotThrow(() => {
    result = truncate("abcdef", -1);
  });
  assert.equal(result, "");
});

test("truncate: n が負で s が空なら空文字を返し、例外を投げない (完了条件7)", () => {
  let result;
  assert.doesNotThrow(() => {
    result = truncate("", -1);
  });
  assert.equal(result, "");
});

test("truncate: n が 0 以上の整数なら結果の長さは n 以下 (完了条件8)", () => {
  const s = "abcdef";
  for (const n of [0, 1, 2, 5, 6, 7]) {
    const result = truncate(s, n);
    assert.ok(
      result.length <= n,
      `truncate(${JSON.stringify(s)}, ${n}) = ${JSON.stringify(result)} の長さ ${result.length} が ${n} を超える`,
    );
  }
});
