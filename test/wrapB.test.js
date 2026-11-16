import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapB } from "../src/strings.js";

test("wrapB: src/strings.js から名前付きエクスポートで import できる (完了条件8)", () => {
  assert.equal(typeof wrapB, "function");
});

test('wrapB: wrapB("the quick brown fox", 10) は "the quick\\nbrown fox" (完了条件1)', () => {
  assert.equal(wrapB("the quick brown fox", 10), "the quick\nbrown fox");
});

test('wrapB: wrapB("a b c", 1) は "a\\nb\\nc" (完了条件2)', () => {
  assert.equal(wrapB("a b c", 1), "a\nb\nc");
});

test('wrapB: wrapB("abcdefghij", 4) は "abcd\\nefgh\\nij" (完了条件3)', () => {
  assert.equal(wrapB("abcdefghij", 4), "abcd\nefgh\nij");
});

test('wrapB: wrapB("a   b", 10) は "a b" (完了条件4)', () => {
  assert.equal(wrapB("a   b", 10), "a b");
});

test('wrapB: wrapB("  a  ", 10) は "a" (完了条件5)', () => {
  assert.equal(wrapB("  a  ", 10), "a");
});

test('wrapB: wrapB("", 5) は空文字 (完了条件6)', () => {
  assert.equal(wrapB("", 5), "");
});

for (const width of [0, -1, 1.5, NaN]) {
  test(`wrapB: width が ${width} のとき RangeError を投げる (完了条件7)`, () => {
    assert.throws(() => wrapB("a b", width), RangeError);
  });
}
