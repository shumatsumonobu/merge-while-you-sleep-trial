import assert from "node:assert/strict";
import { test } from "node:test";
import { capitalize } from "../src/strings.js";

test("capitalize: src/strings.js から名前付きエクスポートで import できる (完了条件1)", async () => {
  assert.equal(typeof capitalize, "function");
  const mod = await import("../src/strings.js");
  assert.equal(typeof mod.capitalize, "function");
  assert.equal(mod.capitalize, capitalize);
});

test("capitalize: 先頭の1文字だけ大文字にし、残りはそのまま (完了条件2)", () => {
  assert.equal(capitalize("hello world"), "Hello world");
});

test("capitalize: 2文字目以降の大文字・小文字は変わらない (完了条件3)", () => {
  assert.equal(capitalize("hELLO"), "HELLO");
});

test("capitalize: 1文字の a と z を大文字にする (完了条件4)", () => {
  assert.equal(capitalize("a"), "A");
  assert.equal(capitalize("z"), "Z");
});

test("capitalize: 先頭がすでに大文字ならそのまま (完了条件5)", () => {
  assert.equal(capitalize("Hello"), "Hello");
});

test("capitalize: 空文字は空文字を返し、例外を投げない (完了条件6)", () => {
  let result;
  assert.doesNotThrow(() => {
    result = capitalize("");
  });
  assert.equal(result, "");
});

test("capitalize: 先頭が数字ならそのまま (完了条件7)", () => {
  assert.equal(capitalize("1abc"), "1abc");
});

test("capitalize: 先頭が空白なら変えない (完了条件8)", () => {
  assert.equal(capitalize(" hello"), " hello");
});

test("capitalize: 先頭が記号なら変えない (完了条件9)", () => {
  assert.equal(capitalize("-abc"), "-abc");
});

test("capitalize: 先頭が é なら大文字にしない (完了条件10)", () => {
  assert.equal(capitalize("élan"), "élan");
});

test("capitalize: 先頭が ñ・ß なら変えず、文字数も変わらない (完了条件11)", () => {
  assert.equal(capitalize("ñandu"), "ñandu");
  assert.equal(capitalize("ßa"), "ßa");
  assert.equal(capitalize("ßa").length, 2);
});
