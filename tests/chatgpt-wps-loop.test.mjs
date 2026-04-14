import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../scripts/lib/automation-config.mjs";
import { runLoop } from "../scripts/chatgpt-wps-loop.mjs";

test("runLoop opens a fresh first conversation and sends tips before the first batch", async () => {
  const events = [];
  const writes = [];
  const logs = [];
  const config = buildConfig({
    batchSize: 2,
    newConversationLimit: 2,
    tipsPrompt: "Follow these tips"
  });

  await runLoop({
    config,
    page: {},
    startRow: 5,
    runsInCurrentConversation: 0,
    newConversationsOpened: 0,
    maxLoopsOverride: 1
  }, buildDependencies({
    logs,
    onOpenFreshChat() {
      events.push("open-fresh-chat");
    },
    onSendPrompt(prompt) {
      events.push(`send:${prompt}`);
      return prompt === config.workflow.tipsPrompt ? "tips reply" : "translated rows";
    },
    onParse(responseText) {
      events.push(`parse:${responseText}`);
      return [["row-1"], ["row-2"]];
    },
    onReadBatch(_cfg, row, batchSize) {
      assert.equal(row, 5);
      assert.equal(batchSize, 2);
      return ["alpha", "beta"];
    },
    onWriteBatch(_cfg, row, outputMatrix) {
      writes.push({ row, outputMatrix });
    }
  }));

  assert.deepEqual(events, [
    "open-fresh-chat",
    "send:Follow these tips",
    "send:alpha\nbeta",
    "parse:translated rows"
  ]);
  assert.deepEqual(writes, [
    {
      row: 5,
      outputMatrix: [["row-1"], ["row-2"]]
    }
  ]);
  assert.match(logs.join("\n"), /Tips prompt completed for conversation 1\/3\./);
  assert.match(logs.join("\n"), /Conversation 1\/3 \| round 1\/8 \| overall 1\/24/);
});

test("runLoop sends tips once per new conversation and does not count tips as a batch run", async () => {
  const prompts = [];
  const parsedResponses = [];
  const logs = [];
  const config = buildConfig({
    batchSize: 1,
    resetConversationEveryRuns: 1,
    newConversationLimit: 1,
    tipsPrompt: "Keep terminology consistent"
  });
  const batches = [["first row"], ["second row"]];

  await runLoop({
    config,
    page: {},
    startRow: 10,
    runsInCurrentConversation: 0,
    newConversationsOpened: 0,
    maxLoopsOverride: 2
  }, buildDependencies({
    logs,
    onOpenFreshChat() {
      prompts.push("[open]");
    },
    onSendPrompt(prompt) {
      prompts.push(prompt);
      if (prompt === config.workflow.tipsPrompt) {
        return "tips reply";
      }

      return `assistant:${prompt}`;
    },
    onParse(responseText) {
      parsedResponses.push(responseText);
      return [[responseText]];
    },
    onReadBatch() {
      return batches.shift() ?? [""];
    }
  }));

  assert.deepEqual(prompts, [
    "[open]",
    "Keep terminology consistent",
    "first row",
    "[open]",
    "Keep terminology consistent",
    "second row"
  ]);
  assert.deepEqual(parsedResponses, [
    "assistant:first row",
    "assistant:second row"
  ]);
  assert.match(logs.join("\n"), /Conversation 1\/2 \| round 1\/1 \| overall 1\/2/);
  assert.match(logs.join("\n"), /Conversation 2\/2 \| round 1\/1 \| overall 2\/2/);
});

test("runLoop keeps the old start behavior when tips prompt is empty", async () => {
  const events = [];
  const config = buildConfig({
    batchSize: 1,
    tipsPrompt: "   "
  });

  await runLoop({
    config,
    page: {},
    startRow: 3,
    runsInCurrentConversation: 0,
    newConversationsOpened: 0,
    maxLoopsOverride: 1
  }, buildDependencies({
    onOpenFreshChat() {
      events.push("open-fresh-chat");
    },
    onSendPrompt(prompt) {
      events.push(`send:${prompt}`);
      return "assistant reply";
    },
    onReadBatch() {
      return ["only row"];
    },
    onParse() {
      return [["done"]];
    }
  }));

  assert.deepEqual(events, ["send:only row"]);
});

function buildConfig(workflowOverrides = {}) {
  return normalizeConfig({
    chatgpt: {
      projectUrl: "https://chatgpt.com/g/project-id/project"
    },
    workflow: {
      batchSize: 1,
      resetConversationEveryRuns: 8,
      newConversationLimit: 2,
      pollIntervalMs: 1,
      responseTimeoutMs: 100,
      maxLoops: 0,
      sourceColumn: "A",
      targetColumn: "B",
      stopWhenEntireBatchEmpty: false,
      ...workflowOverrides
    }
  });
}

function buildDependencies({
  logs = [],
  onOpenFreshChat = async () => {},
  onWaitForComposer = async () => {},
  onSendPrompt = async () => "",
  onParse = () => [[]],
  onReadBatch = async () => [""],
  onWriteBatch = async () => {}
} = {}) {
  return {
    logger(message) {
      logs.push(message);
    },
    async openFreshProjectChatFn(page, config) {
      await onOpenFreshChat(page, config);
    },
    async waitForComposerFn(page) {
      await onWaitForComposer(page);
    },
    async sendPromptAndWaitForResponseFn(page, prompt, config) {
      return onSendPrompt(prompt, page, config);
    },
    parseAssistantResponseToMatrixFn(responseText, responseConfig) {
      return onParse(responseText, responseConfig);
    },
    buildBatchRowCountFindingFn() {
      return null;
    },
    buildRunSummaryFn(summary) {
      return `summary:${summary.loops}`;
    },
    async writeReviewReportFn() {
      return "";
    },
    async readWorkbookBatchFn(config, row, batchSize) {
      return onReadBatch(config, row, batchSize);
    },
    async writeWorkbookBatchFn(config, row, outputMatrix) {
      await onWriteBatch(config, row, outputMatrix);
    }
  };
}
