import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "automation.config.json");
const DEBUG_DIR = path.join(ROOT, "debug");
const WORKBOOK_HELPER = path.join(ROOT, "scripts", "workbook_helper.py");

const DEFAULT_CONFIG = {
  browser: {
    mode: "attach",
    channel: "chrome",
    userDataDir: "./.chrome-profile",
    headless: false,
    debugPort: 9222
  },
  chatgpt: {
    homeUrl: "https://chatgpt.com/",
    targetUrl: "",
    projectUrl: ""
  },
  workbook: {
    filePath: "",
    sheetName: ""
  },
  workflow: {
    sourceColumn: "A",
    targetColumn: "B",
    startRow: 1,
    batchSize: 50,
    resetConversationEveryRuns: 8,
    newConversationLimit: 5,
    pollIntervalMs: 2000,
    responseTimeoutMs: 240000,
    maxLoops: 0,
    stopWhenEntireBatchEmpty: true
  },
  response: {
    stripCodeFences: true
  }
};

const rl = readline.createInterface({ input, output });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadOrCreateConfig();

  const browserSession = await launchBrowser(config);

  try {
    let { page } = browserSession;

    if (!config.chatgpt.projectUrl || args.bootstrap) {
      page = await bootstrapChatgpt(config, browserSession);
      if (args.bootstrap) {
        console.log("Bootstrap complete. You can now run: npm run run");
        return;
      }
    }

    if (!config.workbook.filePath) {
      throw new Error("No workbook selected. Choose a file in the UI or set workbook.filePath in automation.config.json.");
    }

    const startRow = args.fromRow ?? config.workflow.startRow;
    const runsInCurrentConversation = 0;
    const newConversationsOpened = 0;

    await runLoop({
      config,
      page,
      startRow,
      runsInCurrentConversation,
      newConversationsOpened,
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

async function loadOrCreateConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return normalizeConfig(mergeConfig(DEFAULT_CONFIG, JSON.parse(raw)));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    return structuredClone(DEFAULT_CONFIG);
  }
}

async function saveConfig(config) {
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
}

function mergeConfig(base, override) {
  const output = Array.isArray(base) ? [...base] : { ...base };

  for (const [key, value] of Object.entries(override ?? {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      output[key] = mergeConfig(base[key], value);
      continue;
    }

    output[key] = value;
  }

  return output;
}

function normalizeConfig(config) {
  const normalized = mergeConfig(DEFAULT_CONFIG, config ?? {});
  const browser = normalized.browser;
  const workbook = normalized.workbook;
  const workflow = normalized.workflow;

  browser.mode = browser.mode === "launch" ? "launch" : "attach";
  browser.debugPort = Math.max(1, readNumber(browser.debugPort, DEFAULT_CONFIG.browser.debugPort));
  workbook.filePath = String(workbook.filePath || "").trim();
  workbook.sheetName = String(workbook.sheetName || "").trim();
  workflow.batchSize = Math.max(1, readNumber(workflow.batchSize, DEFAULT_CONFIG.workflow.batchSize));
  workflow.startRow = Math.max(1, readNumber(workflow.startRow, DEFAULT_CONFIG.workflow.startRow));
  workflow.resetConversationEveryRuns = Math.max(
    1,
    readNumber(workflow.resetConversationEveryRuns, DEFAULT_CONFIG.workflow.resetConversationEveryRuns)
  );
  workflow.newConversationLimit = Math.max(
    0,
    readNumber(workflow.newConversationLimit, DEFAULT_CONFIG.workflow.newConversationLimit)
  );
  workflow.maxLoops = Math.max(0, readNumber(workflow.maxLoops, 0));
  workflow.sourceColumn = String(workflow.sourceColumn || DEFAULT_CONFIG.workflow.sourceColumn).trim().toUpperCase();
  workflow.targetColumn = String(workflow.targetColumn || DEFAULT_CONFIG.workflow.targetColumn).trim().toUpperCase();

  return normalized;
}

function readNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function launchBrowser(config) {
  if (config.browser.mode === "attach") {
    await ensureChromeDebugPort(config);
    return connectToExistingChrome(config);
  }

  const userDataDir = path.resolve(ROOT, config.browser.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(DEBUG_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: config.browser.channel,
    headless: config.browser.headless,
    viewport: null
  });

  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  await page.goto(config.chatgpt.homeUrl, { waitUntil: "domcontentloaded" });
  return {
    page,
    refreshPage: async () => page,
    close: async () => {
      await context.close();
    }
  };
}

async function ensureChromeDebugPort(config) {
  const debugUrl = getChromeDebugUrl(config);
  if (await isChromeDebugPortReady(debugUrl)) {
    return;
  }

  if (process.platform !== "darwin") {
    throw new Error(
      [
        `Could not reach Chrome remote debugging at ${debugUrl}.`,
        "Auto-launch is only implemented for macOS right now.",
        `Please start Chrome manually with --remote-debugging-port=${config.browser.debugPort} and retry.`
      ].join(" ")
    );
  }

  const userDataDir = path.resolve(ROOT, config.browser.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });

  console.log(`Chrome debug port ${config.browser.debugPort} is not ready. Launching Google Chrome for you...`);
  await execFileAsync("open", [
    "-na",
    "Google Chrome",
    "--args",
    `--remote-debugging-port=${config.browser.debugPort}`,
    `--user-data-dir=${userDataDir}`
  ]);

  const ready = await waitForChromeDebugPort(debugUrl, 15000);
  if (!ready) {
    throw new Error(
      [
        `Google Chrome was launched, but the remote debugging port ${config.browser.debugPort} did not become available in time.`,
        "Make sure Chrome is installed and retry."
      ].join(" ")
    );
  }
}

async function connectToExistingChrome(config) {
  const debugUrl = getChromeDebugUrl(config);
  const browser = await chromium.connectOverCDP(debugUrl);
  const page = await pickChatgptPage(browser, config);

  if (!page) {
    await browser.close();
    throw new Error(
      [
        `Could not find a ChatGPT tab in the Chrome instance at ${debugUrl}.`,
        "Open your logged-in ChatGPT tab manually, then retry."
      ].join(" ")
    );
  }

  await fs.mkdir(DEBUG_DIR, { recursive: true });
  return {
    page,
    refreshPage: async () => {
      const nextPage = await pickChatgptPage(browser, config);
      if (!nextPage) {
        throw new Error("Could not refresh the ChatGPT tab from your existing Chrome.");
      }

      return nextPage;
    },
    close: async () => {
      await browser.close();
    }
  };
}

async function pickChatgptPage(browser, config) {
  const contexts = browser.contexts();
  const allPages = contexts.flatMap((context) => context.pages());
  const matchingPages = allPages.filter((page) => {
    const url = page.url();
    return url.startsWith(config.chatgpt.homeUrl) || url.startsWith("https://chatgpt.com/");
  });

  if (matchingPages.length > 0) {
    return matchingPages.at(-1);
  }

  for (const context of contexts) {
    const page = await context.newPage();
    await page.goto(config.chatgpt.homeUrl, { waitUntil: "domcontentloaded" });
    return page;
  }

  return null;
}

async function bootstrapChatgpt(config, browserSession) {
  if (config.browser.mode === "attach") {
    console.log(`Attach mode is enabled. Connected to Chrome on port ${config.browser.debugPort}.`);
    console.log("If needed, log in to ChatGPT in that Chrome window first and finish any human verification there.");
  } else {
    console.log("A dedicated Chrome window is open.");
    console.log("Log in to ChatGPT if needed.");
  }

  console.log("Open any chat page inside the target project, or the project page itself.");
  console.log("If you have multiple ChatGPT tabs, make this one the most recently opened or the only ChatGPT tab.");
  console.log("When that page is ready, press Enter here.");
  await rl.question("");

  const page = await browserSession.refreshPage();
  config.chatgpt.targetUrl = page.url();
  config.chatgpt.projectUrl = deriveProjectUrl(page.url());
  await saveConfig(config);
  console.log(`Captured project URL: ${config.chatgpt.projectUrl}`);
  return page;
}

function getChromeDebugUrl(config) {
  return `http://127.0.0.1:${config.browser.debugPort}`;
}

async function isChromeDebugPortReady(debugUrl) {
  try {
    const response = await fetch(`${debugUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForChromeDebugPort(debugUrl, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await isChromeDebugPortReady(debugUrl)) {
      return true;
    }

    await sleep(500);
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    console.log(buildRunSummary({
      startRow,
      lastCompletedRow,
      sourceColumn: config.workflow.sourceColumn,
      targetColumn: config.workflow.targetColumn,
      loops,
      totalRuns: getTotalRuns(config),
      elapsedMs: Date.now() - startedAt,
      stopReason
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

function buildRunSummary({ startRow, lastCompletedRow, sourceColumn, targetColumn, loops, totalRuns, elapsedMs, stopReason }) {
  const rowSummary = lastCompletedRow >= startRow
    ? `${sourceColumn}${startRow} -> ${sourceColumn}${lastCompletedRow}`
    : `none completed from ${sourceColumn}${startRow}`;

  return [
    "Run summary:",
    `rows translated ${rowSummary}`,
    `target column ${targetColumn}`,
    `completed rounds ${loops}/${totalRuns}`,
    `elapsed ${formatDuration(elapsedMs)}`,
    `stop reason ${stopReason}`
  ].join(" | ");
}

function formatDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

async function readWorkbookBatch(config, startRow, batchSize) {
  const payload = await runWorkbookHelper("read-batch", {
    filePath: config.workbook.filePath,
    sheetName: config.workbook.sheetName,
    column: config.workflow.sourceColumn,
    startRow,
    batchSize
  });

  return payload.values.map((item) => String(item ?? ""));
}

async function writeWorkbookBatch(config, startRow, matrix) {
  await runWorkbookHelper("write-batch", {
    filePath: config.workbook.filePath,
    sheetName: config.workbook.sheetName,
    column: config.workflow.targetColumn,
    startRow,
    matrix
  });
}

async function runWorkbookHelper(command, payload) {
  const stdout = await runCommandWithInput("python3", [WORKBOOK_HELPER, command], JSON.stringify(payload));
  return JSON.parse(stdout);
}

async function waitForComposer(page) {
  const selectors = [
    "#prompt-textarea",
    "textarea[placeholder]",
    "div[contenteditable='true']"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.waitFor({ state: "visible", timeout: 30000 });
      return selector;
    }
  }

  throw new Error("Could not find the ChatGPT composer.");
}

async function sendPromptAndWaitForResponse(page, prompt, workflow) {
  const composerSelector = await waitForComposer(page);
  const assistantLocator = page.locator("[data-message-author-role='assistant']");
  const userLocator = page.locator("[data-message-author-role='user']");
  const initialCount = await assistantLocator.count();
  const initialUserCount = await userLocator.count();
  const initialUrl = page.url();

  await page.locator(composerSelector).first().click();
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");

  return {
    initialAssistantCount: initialCount,
    initialUserCount,
    initialUrl
  };
}

async function sendPromptInCurrentChatAndWaitForResponse(page, prompt, workflow) {
  const { initialAssistantCount } = await sendPromptAndWaitForResponse(page, prompt, workflow);

  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-message-author-role='assistant']").length > count,
    initialAssistantCount,
    { timeout: workflow.responseTimeoutMs }
  );

  return waitForStableAssistantMessage(page, workflow);
}

async function openFreshProjectChat(page, config) {
  if (!config.chatgpt.projectUrl) {
    throw new Error("Missing chatgpt.projectUrl. Run bootstrap again.");
  }

  await page.goto(config.chatgpt.projectUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  if (await hasVisibleComposer(page)) {
    return;
  }

  const selectors = [
    'button[aria-label*="New chat"]',
    'button[aria-label*="New Chat"]',
    'button[aria-label*="new chat"]',
    'button[aria-label*="新对话"]',
    'button[aria-label*="新建对话"]',
    '[role="button"][aria-label*="New chat"]',
    '[role="button"][aria-label*="新对话"]',
    'button:has-text("New chat")',
    'button:has-text("New Chat")',
    'button:has-text("Start new chat")',
    'button:has-text("新对话")',
    'button:has-text("新建对话")',
    '[role="button"]:has-text("New chat")',
    '[role="button"]:has-text("New Chat")',
    '[role="button"]:has-text("Start new chat")',
    '[role="button"]:has-text("新对话")',
    '[role="button"]:has-text("新建对话")',
    'div:has-text("New chat")',
    'div:has-text("新对话")',
    'a:has-text("New chat")',
    'a:has-text("新对话")'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.click({ timeout: 3000 }).catch(() => null);
      await page.waitForTimeout(1000);
      if (await hasVisibleComposer(page)) {
        return;
      }
    }
  }

  const debugPath = path.join(DEBUG_DIR, `project-open-failed-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);
  throw new Error(
    `Could not open a fresh chat from the project page. Screenshot saved to ${debugPath}.`
  );
}

async function sendPromptWithFreshChatRecovery(page, prompt, config) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const promptState = await sendPromptAndWaitForResponse(page, prompt, config.workflow);

      await waitForFreshConversationCreation(page, config, promptState);

      await page.waitForFunction(
        (count) => document.querySelectorAll("[data-message-author-role='assistant']").length > count,
        promptState.initialAssistantCount,
        { timeout: config.workflow.responseTimeoutMs }
      );

      return await waitForStableAssistantMessage(page, config.workflow);
    } catch (error) {
      lastError = error;
      if (error.code !== "FRESH_CHAT_CREATION_FAILED" || attempt >= maxAttempts) {
        throw error;
      }

      console.log(
        `Fresh project chat was not created successfully. Returning to the project page and retrying (${attempt + 1}/${maxAttempts}).`
      );
      await resetToProjectPage(page, config);
    }
  }

  throw lastError;
}

async function waitForFreshConversationCreation(page, config, promptState) {
  const timeoutMs = Math.min(config.workflow.responseTimeoutMs, 15000);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentUrl = page.url();
    const userCount = await page.locator("[data-message-author-role='user']").count();
    const assistantCount = await page.locator("[data-message-author-role='assistant']").count();

    if (isConversationUrl(currentUrl, config.chatgpt.projectUrl)) {
      return;
    }

    if (userCount > promptState.initialUserCount || assistantCount > promptState.initialAssistantCount) {
      return;
    }

    if (normalizeComparableUrl(currentUrl) !== normalizeComparableUrl(promptState.initialUrl) && !isProjectHomeUrl(currentUrl, config.chatgpt.projectUrl)) {
      return;
    }

    await page.waitForTimeout(500);
  }

  const debugPath = path.join(DEBUG_DIR, `fresh-chat-create-failed-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);
  const error = new Error(
    `Timed out while waiting for a fresh project chat to be created. Screenshot saved to ${debugPath}`
  );
  error.code = "FRESH_CHAT_CREATION_FAILED";
  throw error;
}

async function resetToProjectPage(page, config) {
  await page.goto(config.chatgpt.projectUrl, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForTimeout(1500);
  await openFreshProjectChat(page, config);
  await waitForComposer(page);
}

async function waitForStableAssistantMessage(page, workflow) {
  const start = Date.now();
  let previousText = "";
  let stableCount = 0;

  while (Date.now() - start < workflow.responseTimeoutMs) {
    const text = await getLatestAssistantText(page);
    const generating = await isGenerating(page);

    if (text && text === previousText && !generating) {
      stableCount += 1;
      if (stableCount >= 3) {
        return text;
      }
    } else {
      stableCount = 0;
      previousText = text;
    }

    await page.waitForTimeout(workflow.pollIntervalMs);
  }

  const debugPath = path.join(DEBUG_DIR, `timeout-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true });
  throw new Error(`Timed out while waiting for ChatGPT. Screenshot saved to ${debugPath}`);
}

async function hasVisibleComposer(page) {
  const selectors = [
    "#prompt-textarea",
    "textarea[placeholder]",
    "div[contenteditable='true']"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
}

function normalizeComparableUrl(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
}

function isProjectHomeUrl(rawUrl, projectUrl) {
  return normalizeComparableUrl(rawUrl) === normalizeComparableUrl(projectUrl);
}

function isConversationUrl(rawUrl, projectUrl) {
  const url = new URL(rawUrl);
  const project = new URL(projectUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const projectParts = project.pathname.split("/").filter(Boolean);

  return parts.length >= 4 && parts[0] === "g" && parts[1] === projectParts[1] && parts[2] === "c";
}

async function getLatestAssistantText(page) {
  const locator = page.locator("[data-message-author-role='assistant']").last();
  if ((await locator.count()) === 0) {
    return "";
  }

  const codeBlockText = await locator.evaluate((element) => {
    const codeNodes = Array.from(element.querySelectorAll("pre code"));
    if (codeNodes.length > 0) {
      return codeNodes
        .map((node) => (node.textContent || "").trim())
        .filter(Boolean)
        .join("\n\n");
    }

    return "";
  });

  if (codeBlockText) {
    return codeBlockText;
  }

  return (await locator.innerText()).trim();
}

async function isGenerating(page) {
  const selectors = [
    "button[aria-label*='Stop']",
    "button[aria-label*='停止']",
    "button:has-text('Stop')",
    "button:has-text('停止')"
  ];

  for (const selector of selectors) {
    if ((await page.locator(selector).count()) > 0) {
      return true;
    }
  }

  return false;
}

function parseAssistantResponseToMatrix(rawText, responseConfig) {
  const cleaned = normalizeAssistantForPaste(rawText, responseConfig);

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return coerceMatrix(parsed);
    }

    if (Array.isArray(parsed.results)) {
      return coerceMatrix(parsed.results);
    }
  } catch {
    // Fall through to plain-text parsing.
  }

  const matrix = parseDelimitedBlock(cleaned);
  if (matrix.length > 0) {
    return matrix;
  }

  throw new Error(
    [
      "Could not parse ChatGPT response into a paste block.",
      "Configure your ChatGPT project to return either a JSON array/object or a plain-text block."
    ].join(" ")
  );
}

function coerceMatrix(items) {
  const matrix = items.map((item) => {
    if (Array.isArray(item)) {
      return item.map((cell) => String(cell ?? ""));
    }

    return [String(item ?? "")];
  });

  if (matrix.length === 0) {
    throw new Error("ChatGPT returned an empty result block.");
  }

  return matrix;
}

function parseDelimitedBlock(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\t"));
}

function normalizeAssistantForPaste(rawText, responseConfig) {
  if (!responseConfig.stripCodeFences) {
    return stripLeadingCodeLanguageLabel(rawText.trim());
  }

  const fencedBlockMatch = rawText.match(/```[\w-]*\n([\s\S]*?)\n```/);
  const candidate = fencedBlockMatch ? fencedBlockMatch[1] : rawText;

  return stripLeadingCodeLanguageLabel(
    candidate
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
  );
}

function stripLeadingCodeLanguageLabel(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");

  if (lines.length <= 1) {
    return normalized;
  }

  const firstLine = lines[0].trim();
  const knownLabels = new Set([
    "markdown",
    "md",
    "plaintext",
    "text",
    "txt",
    "json",
    "yaml",
    "yml",
    "csv",
    "tsv"
  ]);

  if (knownLabels.has(firstLine.toLowerCase())) {
    return lines.slice(1).join("\n").trim();
  }

  return normalized;
}

function deriveProjectUrl(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length >= 3 && parts[0] === "g" && parts[2] === "project") {
    return `${url.origin}/g/${parts[1]}/project`;
  }

  if (parts.length >= 4 && parts[0] === "g" && parts[2] === "c") {
    return `${url.origin}/g/${parts[1]}/project`;
  }

  throw new Error(`Could not derive project URL from ${rawUrl}`);
}

async function runCommandWithInput(command, args, inputText) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });

    child.stdin.write(inputText);
    child.stdin.end();
  });
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await rl.close();
  process.exitCode = 1;
});
