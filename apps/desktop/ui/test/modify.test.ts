import assert from "node:assert/strict";
import { test } from "node:test";
import { ModifyStatus, type ModifyJob } from "@learningxxx/contracts";
import { STATUS_LABEL, actionLabel, actionsFor, canRequest, failureLines } from "../src/modify.ts";

test("every status has a label", () => {
  for (const status of ModifyStatus.options) assert.ok(STATUS_LABEL[status]);
});

test("apply is offered only after verification passed", () => {
  const offering = ModifyStatus.options.filter((status) => actionsFor(status).includes("apply"));
  assert.deepEqual(offering, ["verified"]);
});

test("a failed verification can be retried or thrown away, never applied", () => {
  assert.deepEqual(actionsFor("verify_failed"), ["verify", "discard"]);
});

test("a new request waits until the current job is settled", () => {
  const job = (status: ModifyJob["status"]) => ({ status }) as ModifyJob;
  assert.equal(canRequest(undefined), true);
  assert.equal(canRequest(job("review")), false);
  assert.equal(canRequest(job("failed")), false);
  assert.equal(canRequest(job("applied")), true);
});

test("a retry is labelled differently from the first verification", () => {
  assert.equal(actionLabel("verify", "review"), "Docker에서 검증");
  assert.equal(actionLabel("verify", "verify_failed"), "다시 검증");
});

test("the failure summary keeps what broke and drops the noise", () => {
  const log = "pnpm install\napps/desktop/ui check: src/a.ts(1,1): error TS2322: bad\nDone\n";
  assert.deepEqual(failureLines(log), ["apps/desktop/ui check: src/a.ts(1,1): error TS2322: bad"]);
});

test("a failure repeated in the runner's summary appears once", () => {
  assert.deepEqual(failureLines("✖ a\n✖ a\n"), ["✖ a"]);
});
