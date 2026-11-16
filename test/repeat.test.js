import assert from "node:assert/strict";
import { test } from "node:test";
import { repeat, slugify, truncate, capitalize } from "../src/strings.js";

test("repeat: src/strings.js から名前付きエクスポートで import できる (完了条件1)", async () => {
  assert.equal(typeof repeat, "function");
  const mod = await import("../src/strings.js");
  assert.equal(typeof mod.repeat, "function");
  assert.equal(mod.repeat, repeat);
});

test('repeat: repeat("ab", 3) は "ababab" (完了条件2)', () => {
  assert.equal(repeat("ab", 3), "ababab");
});

test('repeat: repeat("ab", 1) は "ab" (完了条件3)', () => {
  assert.equal(repeat("ab", 1), "ab");
});

test('repeat: repeat("ab", 0) は空文字 (完了条件4)', () => {
  assert.equal(repeat("ab", 0), "");
});

test('repeat: repeat("", 0) は空文字 (完了条件5)', () => {
  assert.equal(repeat("", 0), "");
});

test('repeat: repeat("", 3) は空文字 (完了条件6)', () => {
  assert.equal(repeat("", 3), "");
});

test('repeat: repeat("ab", -1) は RangeError を投げる (完了条件7)', () => {
  assert.throws(() => repeat("ab", -1), RangeError);
});

test('repeat: repeat("ab", 1.5) は RangeError を投げる (完了条件8)', () => {
  assert.throws(() => repeat("ab", 1.5), RangeError);
});

test('repeat: repeat("ab", NaN) は RangeError を投げる (完了条件9)', () => {
  assert.throws(() => repeat("ab", NaN), RangeError);
});

test('repeat: repeat("ab", -0.5) は RangeError を投げる (完了条件10)', () => {
  assert.throws(() => repeat("ab", -0.5), RangeError);
});

test("既存の slugify・truncate・capitalize の動きは変わらない (完了条件11)", () => {
  assert.equal(slugify("Hello World!"), "hello-world");
  assert.equal(truncate("hello", 3), "he…");
  assert.equal(truncate("hi", 5), "hi");
  assert.equal(truncate("hello", 0), "");
  assert.equal(capitalize("hello"), "Hello");
  assert.equal(capitalize("élan"), "élan");
});
