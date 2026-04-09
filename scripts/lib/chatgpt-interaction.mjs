import path from "node:path";
import process from "node:process";
import {
  isConversationUrl,
  isProjectHomeUrl,
  normalizeComparableUrl
} from "./chatgpt-url.mjs";

const ROOT = process.cwd();
const DEBUG_DIR = path.join(ROOT, "debug");
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "textarea[placeholder]",
  "div[contenteditable='true']"
];
const MAX_PAGE_RECOVERY_ATTEMPTS = 3;
const CHATGPT_PAGE_ERROR_CODES = {
  assistantResponseTimeout: "ASSISTANT_RESPONSE_TIMEOUT",
  composerMissing: "COMPOSER_MISSING",
  freshChatCreateFailed: "FRESH_CHAT_CREATION_FAILED",
  projectOpenTimeout: "PROJECT_OPEN_TIMEOUT"
};
const CHATGPT_PAGE_ERROR_LABELS = {
  [CHATGPT_PAGE_ERROR_CODES.assistantResponseTimeout]: "assistant-response-timeout",
  [CHATGPT_PAGE_ERROR_CODES.composerMissing]: "composer-missing",
  [CHATGPT_PAGE_ERROR_CODES.freshChatCreateFailed]: "fresh-chat-create-failed",
  [CHATGPT_PAGE_ERROR_CODES.projectOpenTimeout]: "project-open-timeout"
};

export async function waitForComposer(page) {
  const composer = await findVisibleComposer(page, 30000);
  if (composer) {
    return composer;
  }

  throw await createChatgptPageError(
    page,
    CHATGPT_PAGE_ERROR_CODES.composerMissing,
    "Could not find the ChatGPT composer."
  );
}

export async function findVisibleComposer(page, timeoutMs = 0) {
  const startedAt = Date.now();

  do {
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector);
      const count = await locator.count();

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }

    if (timeoutMs <= 0 || Date.now() - startedAt >= timeoutMs) {
      return null;
    }

    await page.waitForTimeout(250);
  } while (true);
}

export async function hasVisibleComposer(page, timeoutMs = 0) {
  return Boolean(await findVisibleComposer(page, timeoutMs));
}

export async function sendPromptAndWaitForResponse(page, prompt) {
  const composerLocator = await waitForComposer(page);
  const assistantLocator = page.locator("[data-message-author-role='assistant']");
  const userLocator = page.locator("[data-message-author-role='user']");
  const initialCount = await assistantLocator.count();
  const initialUserCount = await userLocator.count();
  const initialUrl = page.url();

  await composerLocator.click();
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");

  return {
    initialAssistantCount: initialCount,
    initialUserCount,
    initialUrl
  };
}

export async function sendPromptInCurrentChatAndWaitForResponse(page, prompt, config) {
  return sendPromptWithPageRecovery(page, prompt, config, "current");
}

export async function openFreshProjectChat(page, config, options = {}) {
  if (!config.chatgpt.projectUrl) {
    throw new Error("Missing chatgpt.projectUrl. Run bootstrap again.");
  }

  if (!options.skipProjectNavigation) {
    await gotoProjectPage(page, config.chatgpt.projectUrl);
  }

  await page.waitForTimeout(1000);

  if (await hasVisibleComposer(page, 8000)) {
    return;
  }

  const projectComposerSelectors = [
    "#prompt-textarea",
    "textarea[placeholder*='鏂拌亰澶?]",
    "textarea[aria-label*='鏂拌亰澶?]",
    "[role='textbox'][aria-label*='鏂拌亰澶?]",
    "[contenteditable='true'][aria-label*='鏂拌亰澶?]",
    "main textarea[placeholder]",
    "main [role='textbox'][aria-label]",
    "main div[contenteditable='true']"
  ];

  for (const selector of projectComposerSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      await candidate.click({ timeout: 3000 }).catch(() => null);
      await page.waitForTimeout(800);
      if (await hasVisibleComposer(page, 3000) || isConversationUrl(page.url(), config.chatgpt.projectUrl)) {
        return;
      }
    }
  }

  const selectors = [
    'button[aria-label*="New chat"]',
    'button[aria-label*="New Chat"]',
    'button[aria-label*="new chat"]',
    'button[aria-label*="鏂板璇?]',
    'button[aria-label*="鏂板缓瀵硅瘽"]',
    '[role="button"][aria-label*="New chat"]',
    '[role="button"][aria-label*="鏂板璇?]',
    'button:has-text("New chat")',
    'button:has-text("New Chat")',
    'button:has-text("Start new chat")',
    'button:has-text("鏂板璇?)',
    'button:has-text("鏂板缓瀵硅瘽")',
    '[role="button"]:has-text("New chat")',
    '[role="button"]:has-text("New Chat")',
    '[role="button"]:has-text("Start new chat")',
    '[role="button"]:has-text("鏂板璇?)',
    '[role="button"]:has-text("鏂板缓瀵硅瘽")',
    'div:has-text("New chat")',
    'div:has-text("鏂板璇?)',
    'a:has-text("New chat")',
    'a:has-text("鏂板璇?)'
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

  throw await createChatgptPageError(
    page,
    CHATGPT_PAGE_ERROR_CODES.freshChatCreateFailed,
    "Could not open a fresh chat from the project page."
  );
}

export async function sendPromptWithFreshChatRecovery(page, prompt, config) {
  return sendPromptWithPageRecovery(page, prompt, config, "fresh");
}

export async function waitForFreshConversationCreation(page, config, promptState) {
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

    if (
      normalizeComparableUrl(currentUrl) !== normalizeComparableUrl(promptState.initialUrl) &&
      !isProjectHomeUrl(currentUrl, config.chatgpt.projectUrl)
    ) {
      return;
    }

    await page.waitForTimeout(500);
  }

  const error = await createChatgptPageError(
    page,
    CHATGPT_PAGE_ERROR_CODES.freshChatCreateFailed,
    "Timed out while waiting for a fresh project chat to be created."
  );
  throw error;
}

export async function resetToProjectPage(page, config) {
  await gotoProjectPage(page, config.chatgpt.projectUrl);
  await reloadProjectPage(page, config.chatgpt.projectUrl);
  await page.waitForTimeout(1500);
  await openFreshProjectChat(page, config, { skipProjectNavigation: true });
  await waitForComposer(page);
}

export async function waitForStableAssistantMessage(page, workflow) {
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

async function sendPromptWithPageRecovery(page, prompt, config, mode) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_PAGE_RECOVERY_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        await resetToProjectPage(page, config);
        mode = "fresh";
      }

      if (mode === "fresh") {
        return await sendPromptToFreshProjectChat(page, prompt, config);
      }

      return await sendPromptToCurrentChat(page, prompt, config.workflow);
    } catch (error) {
      lastError = error;
      if (!isRecoverableChatgptPageError(error) || attempt >= MAX_PAGE_RECOVERY_ATTEMPTS) {
        throw error;
      }

      console.log(
        [
          `[Recovery ${attempt}/${MAX_PAGE_RECOVERY_ATTEMPTS}]`,
          `${getRecoverableChatgptPageErrorLabel(error)}.`,
          "Returning to the project page, refreshing, opening a fresh chat, and retrying."
        ].join(" ")
      );
      mode = "fresh";
    }
  }

  throw lastError;
}

async function sendPromptToCurrentChat(page, prompt, workflow) {
  const { initialAssistantCount } = await sendPromptAndWaitForResponse(page, prompt);
  await waitForAssistantMessage(page, initialAssistantCount, workflow.responseTimeoutMs);
  return waitForStableAssistantMessage(page, workflow);
}

async function sendPromptToFreshProjectChat(page, prompt, config) {
  const promptState = await sendPromptAndWaitForResponse(page, prompt);
  await waitForFreshConversationCreation(page, config, promptState);
  await waitForAssistantMessage(page, promptState.initialAssistantCount, config.workflow.responseTimeoutMs);
  return waitForStableAssistantMessage(page, config.workflow);
}

async function waitForAssistantMessage(page, initialAssistantCount, timeoutMs) {
  try {
    await page.waitForFunction(
      (count) => document.querySelectorAll("[data-message-author-role='assistant']").length > count,
      initialAssistantCount,
      { timeout: timeoutMs }
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      throw await createChatgptPageError(
        page,
        CHATGPT_PAGE_ERROR_CODES.assistantResponseTimeout,
        "Timed out while waiting for a new ChatGPT assistant message."
      );
    }

    throw error;
  }
}

async function gotoProjectPage(page, projectUrl) {
  try {
    await page.goto(projectUrl, { waitUntil: "domcontentloaded" });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw await createChatgptPageError(
        page,
        CHATGPT_PAGE_ERROR_CODES.projectOpenTimeout,
        `Timed out while opening the project page (${projectUrl}).`
      );
    }

    throw error;
  }
}

async function reloadProjectPage(page, projectUrl) {
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw await createChatgptPageError(
        page,
        CHATGPT_PAGE_ERROR_CODES.projectOpenTimeout,
        `Timed out while reloading the project page (${projectUrl}).`
      );
    }

    throw error;
  }
}

async function createChatgptPageError(page, code, message) {
  const label = CHATGPT_PAGE_ERROR_LABELS[code] || "chatgpt-page-error";
  const debugPath = path.join(DEBUG_DIR, `${label}-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);

  const error = new Error(`${message} Screenshot saved to ${debugPath}`);
  error.code = code;
  return error;
}

function isRecoverableChatgptPageError(error) {
  return Object.values(CHATGPT_PAGE_ERROR_CODES).includes(error?.code);
}

function getRecoverableChatgptPageErrorLabel(error) {
  return CHATGPT_PAGE_ERROR_LABELS[error?.code] || "chatgpt-page-error";
}

function isTimeoutError(error) {
  return Boolean(error?.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(error?.message || ""));
}

export async function getLatestAssistantText(page) {
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

export async function isGenerating(page) {
  const selectors = [
    "button[aria-label*='Stop']",
    "button[aria-label*='鍋滄']",
    "button:has-text('Stop')",
    "button:has-text('鍋滄')"
  ];

  for (const selector of selectors) {
    if ((await page.locator(selector).count()) > 0) {
      return true;
    }
  }

  return false;
}
