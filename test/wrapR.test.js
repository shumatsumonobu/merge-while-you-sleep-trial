import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapR } from "../src/strings.js";

test("wrapR: src/strings.js から名前付きエクスポートで import できる (完了条件8)", () => {
  assert.equal(typeof wrapR, "function");
});

test('wrapR: wrapR("the quick brown fox", 10) は "the quick\\nbrown fox" (完了条件1)', () => {
  assert.equal(wrapR("the quick brown fox", 10), "the quick\nbrown fox");
});

test('wrapR: wrapR("a b c", 1) は "a\\nb\\nc" (完了条件2)', () => {
  assert.equal(wrapR("a b c", 1), "a\nb\nc");
});

test('wrapR: wrapR("abcdefghij", 4) は "abcd\\nefgh\\nij" (完了条件3)', () => {
  assert.equal(wrapR("abcdefghij", 4), "abcd\nefgh\nij");
});

test('wrapR: wrapR("a   b", 10) は "a b" (完了条件4)', () => {
  assert.equal(wrapR("a   b", 10), "a b");
});

test('wrapR: wrapR("  a  ", 10) は "a" (完了条件5)', () => {
  assert.equal(wrapR("  a  ", 10), "a");
});

test('wrapR: wrapR("", 5) は空文字 (完了条件6)', () => {
  assert.equal(wrapR("", 5), "");
});

for (const width of [0, -1, 1.5, NaN]) {
  test(`wrapR: width が ${width} のとき RangeError を投げる (完了条件7)`, () => {
    assert.throws(() => wrapR("a b", width), RangeError);
  });
}
