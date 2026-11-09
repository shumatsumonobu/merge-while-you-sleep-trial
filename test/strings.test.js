import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify, truncate } from "../src/strings.js";

test("slugify: 英数字以外を - にまとめ、小文字にする", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  a  b  "), "a-b");
});

test("truncate: n 文字を超えたら切る", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});
