import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  buildDerivedInfo,
  mergeConfig,
  normalizeConfig
} from "../scripts/lib/automation-config.mjs";

test("mergeConfig deep-merges nested objects", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    workflow: {
      batchSize: 10
    },
    workbook: {
      filePath: " demo.xlsx "
    }
  });

  assert.equal(merged.workflow.batchSize, 10);
  assert.equal(merged.workflow.targetColumn, DEFAULT_CONFIG.workflow.targetColumn);
  assert.equal(merged.workbook.filePath, " demo.xlsx ");
});

test("normalizeConfig clamps numeric values and uppercases columns", () => {
  const normalized = normalizeConfig({
    browser: {
      mode: "unexpected",
      debugPort: 0
    },
    workbook: {
      filePath: " demo.xlsx ",
      sheetName: " Sheet1 "
    },
    workflow: {
      sourceColumn: " aa ",
      targetColumn: " b ",
      batchSize: "0",
      startRow: "-8",
      resetConversationEveryRuns: "0",
      newConversationLimit: "-1",
      maxLoops: "-10"
    }
  });

  assert.equal(normalized.browser.mode, "attach");
  assert.equal(normalized.browser.debugPort, 1);
  assert.equal(normalized.workbook.filePath, "demo.xlsx");
  assert.equal(normalized.workbook.sheetName, "Sheet1");
  assert.equal(normalized.workflow.sourceColumn, "AA");
  assert.equal(normalized.workflow.targetColumn, "B");
  assert.equal(normalized.workflow.batchSize, 1);
  assert.equal(normalized.workflow.startRow, 1);
  assert.equal(normalized.workflow.resetConversationEveryRuns, 1);
  assert.equal(normalized.workflow.newConversationLimit, 0);
  assert.equal(normalized.workflow.maxLoops, 0);
});

test("buildDerivedInfo reports total conversations, runs, and rows", () => {
  const derived = buildDerivedInfo(normalizeConfig({
    workflow: {
      batchSize: 20,
      resetConversationEveryRuns: 3,
      newConversationLimit: 2
    }
  }));

  assert.deepEqual(derived, {
    totalConversations: 3,
    totalRuns: 9,
    totalRows: 180
  });
});
