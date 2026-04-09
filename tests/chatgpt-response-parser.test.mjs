import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAssistantForPaste,
  parseAssistantResponseToMatrix,
  stripLeadingCodeLanguageLabel
} from "../scripts/lib/chatgpt-response-parser.mjs";

test("parseAssistantResponseToMatrix supports JSON arrays", () => {
  const matrix = parseAssistantResponseToMatrix('["a", "b"]', { stripCodeFences: true });
  assert.deepEqual(matrix, [["a"], ["b"]]);
});

test("parseAssistantResponseToMatrix supports wrapped results arrays", () => {
  const matrix = parseAssistantResponseToMatrix('{"results":[["x","y"]]}', { stripCodeFences: true });
  assert.deepEqual(matrix, [["x", "y"]]);
});

test("parseAssistantResponseToMatrix supports fenced TSV blocks", () => {
  const matrix = parseAssistantResponseToMatrix("```tsv\nhello\tworld\nfoo\tbar\n```", {
    stripCodeFences: true
  });
  assert.deepEqual(matrix, [["hello", "world"], ["foo", "bar"]]);
});

test("stripLeadingCodeLanguageLabel removes standalone language labels", () => {
  assert.equal(stripLeadingCodeLanguageLabel("json\n[1,2]"), "[1,2]");
});

test("normalizeAssistantForPaste preserves raw text when fence stripping is disabled", () => {
  assert.equal(
    normalizeAssistantForPaste("text\nhello", { stripCodeFences: false }),
    "hello"
  );
});
