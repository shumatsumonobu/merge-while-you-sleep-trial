import assert from "node:assert/strict";
import { test } from "node:test";
import { padLeft } from "../src/strings.js";

test('padLeft: padLeft("a", 3) は "  a" (完了条件1)', () => {
  assert.equal(padLeft("a", 3), "  a");
});

test('padLeft: padLeft("abc", 2) は "abc" (完了条件2)', () => {
  assert.equal(padLeft("abc", 2), "abc");
});
