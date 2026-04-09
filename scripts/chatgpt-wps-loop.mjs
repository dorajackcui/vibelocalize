import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadOrCreateConfig } from "./lib/automation-config.mjs";
import {
  bootstrapChatgpt,
  launchBrowser
} from "./lib/chatgpt-browser-session.mjs";
import {
  openFreshProjectChat,
  sendPromptInCurrentChatAndWaitForResponse,
  sendPromptWithFreshChatRecovery,
  waitForComposer
} from "./lib/chatgpt-interaction.mjs";
import { parseAssistantResponseToMatrix } from "./lib/chatgpt-response-parser.mjs";
import { isProjectHomeUrl } from "./lib/chatgpt-url.mjs";
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

const rl = readline.createInterface({ input, output });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadOrCreateConfig();

  const browserSession = await launchBrowser(config);

  try {
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
    await browserSession.close();
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

async function runLoop({
  config,
  page,
  startRow,
  runsInCurrentConversation: initialRunsInCurrentConversation,
  newConversationsOpened: initialNewConversationsOpened,
  maxLoopsOverride
}) {
  const batchSize = config.workflow.batchSize;
  const limit = maxLoopsOverride ?? config.workflow.maxLoops;
  const runsPerConversation = config.workflow.resetConversationEveryRuns;
  const newConversationLimit = config.workflow.newConversationLimit;
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
    while (true) {
      if (limit > 0 && loops >= limit) {
        stopReason = "Reached the max loop limit";
        console.log("Reached the max loop limit and stopped.");
        break;
      }

      if (runsPerConversation > 0 && runsInCurrentConversation >= runsPerConversation) {
        if (newConversationsOpened >= newConversationLimit) {
          stopReason = "Reached the new conversation limit";
          console.log("Reached the new conversation limit and stopped.");
          break;
        }

        const nextConversationIndex = newConversationsOpened + 2;
        console.log(
          `Opening a fresh chat in the same project. Switching to conversation ${nextConversationIndex}/${getTotalConversations(config)}.`
        );
        await openFreshProjectChat(page, config);
        await waitForComposer(page);
        runsInCurrentConversation = 0;
        newConversationsOpened += 1;
      }

      const values = await readWorkbookBatch(config, currentRow, batchSize);
      if (config.workflow.stopWhenEntireBatchEmpty && values.every((item) => item.trim() === "")) {
        stopReason = "The whole batch is empty";
        console.log("The whole batch is empty. Stopping here.");
        break;
      }

      console.log(
        [
          `Conversation ${getCurrentConversationIndex(newConversationsOpened)}/${getTotalConversations(config)}`,
          `round ${getCurrentConversationRoundIndex(runsInCurrentConversation)}/${config.workflow.resetConversationEveryRuns}`,
          `overall ${getOverallRunIndex(loops)}/${getTotalRuns(config)}`,
          `sending ${config.workflow.sourceColumn}${currentRow}:${config.workflow.sourceColumn}${currentRow + batchSize - 1} to ChatGPT.`
        ].join(" | ")
      );

      const prompt = values.join("\n");
      await waitForComposer(page);
      const responseText = isProjectHomeUrl(page.url(), config.chatgpt.projectUrl)
        ? await sendPromptWithFreshChatRecovery(page, prompt, config)
        : await sendPromptInCurrentChatAndWaitForResponse(page, prompt, config.workflow);
      const outputMatrix = parseAssistantResponseToMatrix(responseText, config.response);
      const reviewFinding = buildBatchRowCountFinding({
        config,
        startRow: currentRow,
        sourceValues: values,
        outputMatrix
      });
      if (reviewFinding) {
        reviewFindings.push(reviewFinding);
        console.log(
          [
            `Review required for ${reviewFinding.sourceRange}.`,
            `Expected ${reviewFinding.expectedRowCount} rows but got ${reviewFinding.actualRowCount}.`,
            "The result was still written back and recorded in the review report."
          ].join(" ")
        );
      }

      await writeWorkbookBatch(config, currentRow, outputMatrix);
      console.log(
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
      reviewReportPath = await writeReviewReport({
        config,
        startRow,
        lastCompletedRow,
        loops,
        totalRuns: getTotalRuns(config),
        elapsedMs,
        stopReason,
        reviewFindings
      });
    } catch (reviewError) {
      console.log(`Could not write review report: ${reviewError.message}`);
    }

    console.log(buildRunSummary({
      startRow,
      lastCompletedRow,
      sourceColumn: config.workflow.sourceColumn,
      targetColumn: config.workflow.targetColumn,
      loops,
      totalRuns: getTotalRuns(config),
      elapsedMs,
      stopReason,
      reviewFindings,
      reviewReportPath
    }));
  }
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

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await rl.close();
  process.exitCode = 1;
});
