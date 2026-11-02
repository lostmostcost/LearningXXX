import assert from "node:assert/strict";
import { test } from "node:test";
import { ModifyStatus, type ModifyJob } from "@learningxxx/contracts";
import { STATUS_LABEL, actionsFor, canRequest } from "../src/modify.ts";

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
