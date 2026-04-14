import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { loadOrCreateConfig } from "./lib/automation-config.mjs";
import {
  bootstrapChatgpt,
  launchBrowser
} from "./lib/chatgpt-browser-session.mjs";
import {
  openFreshProjectChat,
  sendPromptAndWaitForResponse,
  waitForComposer
} from "./lib/chatgpt-interaction.mjs";
import { parseAssistantResponseToMatrix } from "./lib/chatgpt-response-parser.mjs";
import {
  buildBatchRowCountFinding,
  buildRunSummary,
  writeReviewReport
} from "./lib/review-report.mjs";
import {
  formatWorkbookWriteIssue,
  getWorkbookWriteCheck,
  readWorkbookBatch,
  writeWorkbookBatch
} from "./lib/workbook-service.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadOrCreateConfig();
  const rl = readline.createInterface({ input, output });
  let browserSession = null;

  try {
    browserSession = await launchBrowser(config);
    let { page } = browserSession;

    if (!config.chatgpt.projectUrl || args.bootstrap) {
      page = await bootstrapChatgpt(config, browserSession, rl);
      if (args.bootstrap) {
        console.log("Bootstrap complete. You can now run: npm run run");
        return;
      }
    }

    if (!config.workbook.filePath) {
      throw new Error("No workbook selected. Choose a file in the UI or set workbook.filePath in automation.config.json.");
    }

    const writeCheck = await getWorkbookWriteCheck(config.workbook.filePath);
    if (!writeCheck.ok) {
      throw new Error(formatWorkbookWriteIssue(writeCheck, config.workbook.filePath));
    }

    const startRow = args.fromRow ?? config.workflow.startRow;

    await runLoop({
      config,
      page,
      startRow,
      runsInCurrentConversation: 0,
      newConversationsOpened: 0,
      maxLoopsOverride: args.maxLoops
    });
  } finally {
    await browserSession?.close();
    await rl.close();
  }
}

function parseArgs(argv) {
  const args = { bootstrap: false, fromRow: null, maxLoops: null };

  for (const item of argv) {
    if (item === "--bootstrap") {
      args.bootstrap = true;
      continue;
    }

    if (item.startsWith("--from-row=")) {
      args.fromRow = Number(item.split("=")[1]);
      continue;
    }

    if (item.startsWith("--max-loops=")) {
      args.maxLoops = Number(item.split("=")[1]);
    }
  }

  return args;
}

export async function runLoop({
  config,
  page,
  startRow,
  runsInCurrentConversation: initialRunsInCurrentConversation,
  newConversationsOpened: initialNewConversationsOpened,
  maxLoopsOverride
}, dependencies = {}) {
  const {
    logger = console.log,
    openFreshProjectChatFn = openFreshProjectChat,
    waitForComposerFn = waitForComposer,
    sendPromptAndWaitForResponseFn = sendPromptAndWaitForResponse,
    parseAssistantResponseToMatrixFn = parseAssistantResponseToMatrix,
    buildBatchRowCountFindingFn = buildBatchRowCountFinding,
    buildRunSummaryFn = buildRunSummary,
    writeReviewReportFn = writeReviewReport,
    readWorkbookBatchFn = readWorkbookBatch,
    writeWorkbookBatchFn = writeWorkbookBatch
  } = dependencies;

  const batchSize = config.workflow.batchSize;
  const limit = maxLoopsOverride ?? config.workflow.maxLoops;
  const runsPerConversation = config.workflow.resetConversationEveryRuns;
  const newConversationLimit = config.workflow.newConversationLimit;
  const tipsPrompt = getConfiguredTipsPrompt(config);
  const totalConversations = getTotalConversations(config);
  const totalRuns = getTotalRuns(config);
  const startedAt = Date.now();

  let currentRow = startRow;
  let loops = 0;
  let runsInCurrentConversation =
    typeof initialRunsInCurrentConversation === "number" ? initialRunsInCurrentConversation : 0;
  let newConversationsOpened =
    typeof initialNewConversationsOpened === "number" ? initialNewConversationsOpened : 0;
  let lastCompletedRow = startRow - 1;
  let stopReason = "completed";
  const reviewFindings = [];

  try {
    if (tipsPrompt) {
      await prepareConversationForWork({
        page,
        config,
        conversationIndex: getCurrentConversationIndex(newConversationsOpened),
        totalConversations,
        openFreshChat: true,
        tipsPrompt,
        logger,
        openFreshProjectChatFn,
        waitForComposerFn,
        sendPromptAndWaitForResponseFn
      });
    }

    while (true) {
      if (limit > 0 && loops >= limit) {
        stopReason = "Reached the max loop limit";
        logger("Reached the max loop limit and stopped.");
        break;
      }

      if (runsPerConversation > 0 && runsInCurrentConversation >= runsPerConversation) {
        if (newConversationsOpened >= newConversationLimit) {
          stopReason = "Reached the new conversation limit";
          logger("Reached the new conversation limit and stopped.");
          break;
        }

        const nextConversationIndex = getCurrentConversationIndex(newConversationsOpened + 1);
        await prepareConversationForWork({
          page,
          config,
          conversationIndex: nextConversationIndex,
          totalConversations,
          openFreshChat: true,
          tipsPrompt,
          logger,
          openFreshProjectChatFn,
          waitForComposerFn,
          sendPromptAndWaitForResponseFn
        });
        runsInCurrentConversation = 0;
        newConversationsOpened += 1;
      }

      const values = await readWorkbookBatchFn(config, currentRow, batchSize);
      if (config.workflow.stopWhenEntireBatchEmpty && values.every((item) => item.trim() === "")) {
        stopReason = "The whole batch is empty";
        logger("The whole batch is empty. Stopping here.");
        break;
      }

      logger(
        [
          `Conversation ${getCurrentConversationIndex(newConversationsOpened)}/${totalConversations}`,
          `round ${getCurrentConversationRoundIndex(runsInCurrentConversation)}/${config.workflow.resetConversationEveryRuns}`,
          `overall ${getOverallRunIndex(loops)}/${totalRuns}`,
          `sending ${config.workflow.sourceColumn}${currentRow}:${config.workflow.sourceColumn}${currentRow + batchSize - 1} to ChatGPT.`
        ].join(" | ")
      );

      const prompt = values.join("\n");
      await waitForComposerFn(page);
      const responseText = await sendPromptAndWaitForResponseFn(page, prompt, config);
      const outputMatrix = parseAssistantResponseToMatrixFn(responseText, config.response);
      const reviewFinding = buildBatchRowCountFindingFn({
        config,
        startRow: currentRow,
        sourceValues: values,
        outputMatrix
      });
      if (reviewFinding) {
        reviewFindings.push(reviewFinding);
        logger(
          [
            `Review required for ${reviewFinding.sourceRange}.`,
            `Expected ${reviewFinding.expectedRowCount} rows but got ${reviewFinding.actualRowCount}.`,
            "The result was still written back and recorded in the review report."
          ].join(" ")
        );
      }

      await writeWorkbookBatchFn(config, currentRow, outputMatrix);
      logger(
        `Wrote a ${outputMatrix.length}x${Math.max(...outputMatrix.map((row) => row.length), 0)} block starting at ${config.workflow.targetColumn}${currentRow}.`
      );

      lastCompletedRow = currentRow + batchSize - 1;
      currentRow += batchSize;
      loops += 1;
      runsInCurrentConversation += 1;
    }
  } catch (error) {
    stopReason = `Stopped with error: ${error.message}`;
    throw error;
  } finally {
    const elapsedMs = Date.now() - startedAt;
    let reviewReportPath = "";

    try {
      reviewReportPath = await writeReviewReportFn({
        config,
        startRow,
        lastCompletedRow,
        loops,
        totalRuns,
        elapsedMs,
        stopReason,
        reviewFindings
      });
    } catch (reviewError) {
      logger(`Could not write review report: ${reviewError.message}`);
    }

    logger(buildRunSummaryFn({
      startRow,
      lastCompletedRow,
      sourceColumn: config.workflow.sourceColumn,
      targetColumn: config.workflow.targetColumn,
      loops,
      totalRuns,
      elapsedMs,
      stopReason,
      reviewFindings,
      reviewReportPath
    }));
  }
}

async function prepareConversationForWork({
  page,
  config,
  conversationIndex,
  totalConversations,
  openFreshChat,
  tipsPrompt,
  logger,
  openFreshProjectChatFn,
  waitForComposerFn,
  sendPromptAndWaitForResponseFn
}) {
  if (openFreshChat) {
    logger(
      `Opening a fresh chat in the same project. Switching to conversation ${conversationIndex}/${totalConversations}.`
    );
    await openFreshProjectChatFn(page, config);
    await waitForComposerFn(page);
  }

  if (!tipsPrompt) {
    return;
  }

  logger(`Sending tips prompt for conversation ${conversationIndex}/${totalConversations}.`);
  await sendPromptAndWaitForResponseFn(page, tipsPrompt, config);
  logger(`Tips prompt completed for conversation ${conversationIndex}/${totalConversations}.`);
  await waitForComposerFn(page);
}

function getConfiguredTipsPrompt(config) {
  return String(config.workflow.tipsPrompt || "").trim();
}

function getTotalConversations(config) {
  return config.workflow.newConversationLimit + 1;
}

function getTotalRuns(config) {
  return getTotalConversations(config) * config.workflow.resetConversationEveryRuns;
}

function getCurrentConversationIndex(newConversationsOpened) {
  return newConversationsOpened + 1;
}

function getCurrentConversationRoundIndex(runsInCurrentConversation) {
  return runsInCurrentConversation + 1;
}

function getOverallRunIndex(loops) {
  return loops + 1;
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
