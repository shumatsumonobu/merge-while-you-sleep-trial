import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapG } from "../src/strings.js";

test("wrapG: src/strings.js から名前付きエクスポートで import できる (完了条件8)", () => {
  assert.equal(typeof wrapG, "function");
});

test('wrapG: wrapG("the quick brown fox", 10) は "the quick\\nbrown fox" (完了条件1)', () => {
  assert.equal(wrapG("the quick brown fox", 10), "the quick\nbrown fox");
});

test('wrapG: wrapG("a b c", 1) は "a\\nb\\nc" (完了条件2)', () => {
  assert.equal(wrapG("a b c", 1), "a\nb\nc");
});

test('wrapG: wrapG("abcdefghij", 4) は "abcd\\nefgh\\nij" (完了条件3)', () => {
  assert.equal(wrapG("abcdefghij", 4), "abcd\nefgh\nij");
});

test('wrapG: wrapG("a   b", 10) は "a b" (完了条件4)', () => {
  assert.equal(wrapG("a   b", 10), "a b");
});

test('wrapG: wrapG("  a  ", 10) は "a" (完了条件5)', () => {
  assert.equal(wrapG("  a  ", 10), "a");
});

test('wrapG: wrapG("", 5) は空文字 (完了条件6)', () => {
  assert.equal(wrapG("", 5), "");
});

for (const width of [0, -1, 1.5, NaN]) {
  test(`wrapG: width が ${width} のとき RangeError を投げる (完了条件7)`, () => {
    assert.throws(() => wrapG("a b", width), RangeError);
  });
}
