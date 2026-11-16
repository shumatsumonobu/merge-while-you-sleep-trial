import assert from "node:assert/strict";
import { test } from "node:test";
import { kebab } from "../src/strings.js";

test('kebab: kebab("Hello World") は "hello-world" (完了条件1)', () => {
  assert.equal(kebab("Hello World"), "hello-world");
});

test('kebab: kebab("a  b") は "a-b" (続く空白は1つの - にする) (完了条件2)', () => {
  assert.equal(kebab("a  b"), "a-b");
});

test('kebab: kebab("") は空文字 (完了条件3)', () => {
  assert.equal(kebab(""), "");
});
