import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapA } from "../src/strings.js";

test("wrapA: src/strings.js から名前付きエクスポートで import できる (完了条件8)", () => {
  assert.equal(typeof wrapA, "function");
});

test('wrapA: wrapA("the quick brown fox", 10) は "the quick\\nbrown fox" (完了条件1)', () => {
  assert.equal(wrapA("the quick brown fox", 10), "the quick\nbrown fox");
});

test('wrapA: wrapA("a b c", 1) は "a\\nb\\nc" (完了条件2)', () => {
  assert.equal(wrapA("a b c", 1), "a\nb\nc");
});

test('wrapA: wrapA("abcdefghij", 4) は "abcd\\nefgh\\nij" (完了条件3)', () => {
  assert.equal(wrapA("abcdefghij", 4), "abcd\nefgh\nij");
});

test('wrapA: wrapA("a   b", 10) は "a b" (完了条件4)', () => {
  assert.equal(wrapA("a   b", 10), "a b");
});

test('wrapA: wrapA("  a  ", 10) は "a" (完了条件5)', () => {
  assert.equal(wrapA("  a  ", 10), "a");
});

test('wrapA: wrapA("", 5) は空文字 (完了条件6)', () => {
  assert.equal(wrapA("", 5), "");
});

for (const width of [0, -1, 1.5, NaN]) {
  test(`wrapA: width が ${width} のとき RangeError を投げる (完了条件7)`, () => {
    assert.throws(() => wrapA("a b", width), RangeError);
  });
}
