import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapH } from "../src/strings.js";

test("wrapH: src/strings.js から名前付きエクスポートで import できる (完了条件8)", () => {
  assert.equal(typeof wrapH, "function");
});

test('wrapH: wrapH("the quick brown fox", 10) は "the quick\\nbrown fox" (完了条件1)', () => {
  assert.equal(wrapH("the quick brown fox", 10), "the quick\nbrown fox");
});

test('wrapH: wrapH("a b c", 1) は "a\\nb\\nc" (完了条件2)', () => {
  assert.equal(wrapH("a b c", 1), "a\nb\nc");
});

test('wrapH: wrapH("abcdefghij", 4) は "abcd\\nefgh\\nij" (完了条件3)', () => {
  assert.equal(wrapH("abcdefghij", 4), "abcd\nefgh\nij");
});

test('wrapH: wrapH("a   b", 10) は "a b" (完了条件4)', () => {
  assert.equal(wrapH("a   b", 10), "a b");
});

test('wrapH: wrapH("  a  ", 10) は "a" (完了条件5)', () => {
  assert.equal(wrapH("  a  ", 10), "a");
});

test('wrapH: wrapH("", 5) は空文字 (完了条件6)', () => {
  assert.equal(wrapH("", 5), "");
});

for (const width of [0, -1, 1.5, NaN]) {
  test(`wrapH: width が ${width} のとき RangeError を投げる (完了条件7)`, () => {
    assert.throws(() => wrapH("a b", width), RangeError);
  });
}
