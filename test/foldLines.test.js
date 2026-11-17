import assert from "node:assert/strict";
import { test } from "node:test";
import { foldLines } from "../src/strings.js";

test("foldLines: src/strings.js から名前付きエクスポートで import できる (完了条件8)", () => {
  assert.equal(typeof foldLines, "function");
});

test('foldLines: foldLines("the quick brown fox", 10) は "the quick\\nbrown fox" (完了条件1)', () => {
  assert.equal(foldLines("the quick brown fox", 10), "the quick\nbrown fox");
});

test('foldLines: foldLines("a b c", 1) は "a\\nb\\nc" (完了条件2)', () => {
  assert.equal(foldLines("a b c", 1), "a\nb\nc");
});

test('foldLines: foldLines("abcdefghij", 4) は "abcd\\nefgh\\nij" (完了条件3)', () => {
  assert.equal(foldLines("abcdefghij", 4), "abcd\nefgh\nij");
});

test('foldLines: foldLines("a   b", 10) は "a b" (完了条件4)', () => {
  assert.equal(foldLines("a   b", 10), "a b");
});

test('foldLines: foldLines("  a  ", 10) は "a" (完了条件5)', () => {
  assert.equal(foldLines("  a  ", 10), "a");
});

test('foldLines: foldLines("", 5) は空文字 (完了条件6)', () => {
  assert.equal(foldLines("", 5), "");
});

for (const width of [0, -1, 1.5, NaN]) {
  test(`foldLines: width が ${width} のとき RangeError を投げる (完了条件7)`, () => {
    assert.throws(() => foldLines("a b", width), RangeError);
  });
}
