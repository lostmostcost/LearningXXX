import assert from "node:assert/strict";
import { test } from "node:test";
import { signInSummary } from "../src/signin.ts";

test("top bar shows what is saved, never values (WBS-040)", () => {
  const base = { school: false, schoolRejected: false, canvasToken: false, available: true };
  assert.equal(signInSummary(undefined), "로그인 설정");
  assert.equal(signInSummary(base), "로그인 설정");
  assert.equal(signInSummary({ ...base, school: true }), "자동 로그인 켜짐");
  assert.equal(signInSummary({ ...base, school: true, schoolRejected: true }), "로그인 설정 ⚠︎ 비밀번호 거부됨");
  assert.equal(signInSummary({ ...base, available: false }), "로그인 설정 (저장 불가)");
});
