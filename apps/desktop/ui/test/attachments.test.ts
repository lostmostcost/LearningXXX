import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { emptyDraft, freeze, sendBlock } from "../src/composer.ts";
import type { Session } from "@learningxxx/contracts";

test("unconfirmed attachments cannot be frozen or sent, confirmed IDs remain tied to the target", () => {
  const id = randomUUID(), target = randomUUID();
  const draft = { ...emptyDraft(), attachments: [{ id, name: "notes.txt", status: "unconfirmed" as const }] };
  assert.equal(sendBlock(draft, { status: "idle" } as Session, false), "unconfirmed_attachment");
  assert.throws(() => freeze(draft, target));
  const ready = { ...draft, attachments: [{ ...draft.attachments[0]!, status: "ready" as const }] };
  const sent = freeze(ready, target);
  assert.equal(sent.targetSessionId, target);
  ready.attachments.length = 0;
  assert.deepEqual(sent.attachmentIds, [id]);
  assert.deepEqual(freeze({ ...emptyDraft(), text: "later turn" }, target).attachmentIds, []);
});
