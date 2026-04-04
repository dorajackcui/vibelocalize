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

  if (!config.workbook.filePath) {
    throw new Error("No workbook selected. Choose a file in the UI or set workbook.filePath in automation.config.json.");
  }

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

async function connectToExistingChrome(config) {
  const debugUrl = `http://127.0.0.1:${config.browser.debugPort}`;
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
    console.log(`Attach mode is enabled. Use your own Chrome started with remote debugging on port ${config.browser.debugPort}.`);
    console.log("Log in to ChatGPT in that Chrome window first, and finish any human verification there.");
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

  let currentRow = startRow;
  let loops = 0;
  let runsInCurrentConversation =
    typeof initialRunsInCurrentConversation === "number" ? initialRunsInCurrentConversation : 0;
  let newConversationsOpened =
    typeof initialNewConversationsOpened === "number" ? initialNewConversationsOpened : 0;

  while (true) {
    if (limit > 0 && loops >= limit) {
      console.log("Reached the max loop limit and stopped.");
      break;
    }

    if (runsPerConversation > 0 && runsInCurrentConversation >= runsPerConversation) {
      if (newConversationsOpened >= newConversationLimit) {
        console.log("Reached the new conversation limit and stopped.");
        break;
      }

      console.log("Opening a fresh chat in the same project.");
      await openFreshProjectChat(page, config);
      await waitForComposer(page);
      runsInCurrentConversation = 0;
      newConversationsOpened += 1;
    }

    const values = await readWorkbookBatch(config, currentRow, batchSize);
    if (config.workflow.stopWhenEntireBatchEmpty && values.every((item) => item.trim() === "")) {
      console.log("The whole batch is empty. Stopping here.");
      break;
    }

    console.log(
      `Sending ${config.workflow.sourceColumn}${currentRow}:${config.workflow.sourceColumn}${currentRow + batchSize - 1} to ChatGPT.`
    );

    const prompt = values.join("\n");
    await waitForComposer(page);
    const responseText = await sendPromptAndWaitForResponse(page, prompt, config.workflow);
    const outputMatrix = parseAssistantResponseToMatrix(responseText, config.response);

    await writeWorkbookBatch(config, currentRow, outputMatrix);
    console.log(
      `Wrote a ${outputMatrix.length}x${Math.max(...outputMatrix.map((row) => row.length), 0)} block starting at ${config.workflow.targetColumn}${currentRow}.`
    );

    currentRow += batchSize;
    loops += 1;
    runsInCurrentConversation += 1;
  }
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
  const initialCount = await assistantLocator.count();

  await page.locator(composerSelector).first().click();
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");

  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-message-author-role='assistant']").length > count,
    initialCount,
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
