import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { emptyDraft, freeze, restoreIfEmpty, sendBlock, withSelection, withoutSelection } from "../src/composer.ts";
import { selectedText, type SelectionIntent } from "../src/selection.ts";

const assetId = randomUUID();
const inside = {} as Node, outside = {} as Node;
const layer = { contains: (node: Node | null) => node === inside };
const range = (text: string, anchorNode = inside, focusNode = inside) => ({
  isCollapsed: false, anchorNode, focusNode, toString: () => text,
});

describe("explicit selection boundary", () => {
  test("only the selected excerpt and its asset/page are captured", () => {
    assert.deepEqual(selectedText(range("  De Morgan's law  "), layer, assetId, 2), {
      assetId, page: 2, text: "De Morgan's law",
    });
  });
  test("cross-panel/cross-page ranges, blank and oversized selections are rejected", () => {
    assert.equal(selectedText(range("secret", inside, outside), layer, assetId, 1), undefined);
    assert.equal(selectedText(range("secret", outside, inside), layer, assetId, 1), undefined);
    assert.equal(selectedText(range(" \n "), layer, assetId, 1), undefined);
    assert.equal(selectedText(range("a".repeat(20001)), layer, assetId, 1), undefined);
    assert.equal(selectedText(null, layer, assetId, 1), undefined);
    assert.equal(selectedText({ ...range("x"), isCollapsed: true }, layer, assetId, 1), undefined);
  });
});

describe("selection requests stay explicit and session-bound", () => {
  for (const intent of ["translate_en_ko", "translate_ko_en", "explain_simply"] as SelectionIntent[]) {
    test(`${intent}: no course file or hidden attachment is sent, even for an independent session`, () => {
      const selection = { assetId, page: 3, text: "selected excerpt" };
      const draft = withSelection(emptyDraft(), selection, intent);
      const target = randomUUID();
      const sent = freeze(draft, target);
      selection.text = "different page later";
      draft.selection!.text = "another draft later";
      assert.equal(sent.intent, intent);
      assert.equal(sent.targetSessionId, target);
      assert.deepEqual(sent.selection, { assetId, page: 3, text: "selected excerpt" });
      assert.deepEqual(sent.attachmentIds, []);
      assert.deepEqual(sent.captureIds, []);
      assert.equal(sent.text, "");
    });
  }
  test("applying to one session preserves the other session's draft", () => {
    const a = randomUUID(), b = randomUUID();
    const drafts = { [a]: { ...emptyDraft(), text: "question A" }, [b]: { ...emptyDraft(), text: "question B" } };
    const next = { ...drafts, [a]: withSelection(drafts[a]!, { assetId, page: 1, text: "excerpt" }, "explain_simply") };
    assert.equal(next[b], drafts[b]);
    assert.equal(next[b]!.selection, undefined);
    assert.equal(next[a]!.text, "question A");
  });
  test("removing a selection resets its intent and preserves the user's question", () => {
    const draft = withoutSelection(withSelection({ ...emptyDraft(), text: "my question" }, { assetId, text: "x" }, "translate_en_ko"));
    assert.equal(draft.intent, "chat");
    assert.equal(draft.selection, undefined);
    assert.equal(draft.text, "my question");
    assert.equal(sendBlock(withoutSelection(withSelection(emptyDraft(), { assetId, text: "x" }, "explain_simply")), undefined, false), "no_session");
  });
  test("a refused send restores the excerpt but never replaces newly entered content", () => {
    const previous = withSelection(emptyDraft(), { assetId, page: 2, text: "keep me" }, "translate_ko_en");
    assert.equal(restoreIfEmpty(emptyDraft(), previous), previous);
    const newSelection = withSelection(emptyDraft(), { assetId, text: "new" }, "explain_simply");
    assert.equal(restoreIfEmpty(newSelection, previous), newSelection);
    const newQuestion = { ...emptyDraft(), text: "new question" };
    assert.equal(restoreIfEmpty(newQuestion, previous), newQuestion);
  });
});
