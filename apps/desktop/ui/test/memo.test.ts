import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE_QUOTE_CHARS, pageQuote } from "../src/memo.ts";

test("WBS-086: the page block starts on its own paragraph and quotes the page", () => {
  assert.equal(pageQuote("", "LAB2.pdf", 3, "WHERE  절\n사용"), "📄 LAB2.pdf 3쪽\n> WHERE 절 사용\n");
  assert.equal(pageQuote("메모", "A", 1, ""), "\n\n📄 A 1쪽\n");
  assert.equal(pageQuote("메모\n", "A", 1, ""), "\n📄 A 1쪽\n");
  assert.ok(pageQuote("", "A", 1, "가".repeat(PAGE_QUOTE_CHARS + 50)).endsWith("…\n"));
  assert.equal(pageQuote("", "A", 1, "\uf0a7 문자열 \uf0a7 날짜"), "📄 A 1쪽\n> 문자열 날짜\n");
});
