import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapF } from "../src/strings.js";

test("wrapF: src/strings.js から名前付きエクスポートで import できる (完了条件8)", () => {
  assert.equal(typeof wrapF, "function");
});

test('wrapF: wrapF("the quick brown fox", 10) は "the quick\\nbrown fox" (完了条件1)', () => {
  assert.equal(wrapF("the quick brown fox", 10), "the quick\nbrown fox");
});

test('wrapF: wrapF("a b c", 1) は "a\\nb\\nc" (完了条件2)', () => {
  assert.equal(wrapF("a b c", 1), "a\nb\nc");
});

test('wrapF: wrapF("abcdefghij", 4) は "abcd\\nefgh\\nij" (完了条件3)', () => {
  assert.equal(wrapF("abcdefghij", 4), "abcd\nefgh\nij");
});

test('wrapF: wrapF("a   b", 10) は "a b" (完了条件4)', () => {
  assert.equal(wrapF("a   b", 10), "a b");
});

test('wrapF: wrapF("  a  ", 10) は "a" (完了条件5)', () => {
  assert.equal(wrapF("  a  ", 10), "a");
});

test('wrapF: wrapF("", 5) は空文字 (完了条件6)', () => {
  assert.equal(wrapF("", 5), "");
});

for (const width of [0, -1, 1.5, NaN]) {
  test(`wrapF: width が ${width} のとき RangeError を投げる (完了条件7)`, () => {
    assert.throws(() => wrapF("a b", width), RangeError);
  });
}
