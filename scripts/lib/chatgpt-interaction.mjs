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
const SEND_BUTTON_SELECTORS = [
  "button[data-testid='send-button']",
  "button[aria-label*='Send']",
  "button[aria-label*='\u53d1\u9001']"
];
const GENERATING_SELECTORS = [
  "button[aria-label*='Stop']",
  "button[aria-label*='\u505c\u6b62']",
  "button:has-text('Stop')",
  "button:has-text('\u505c\u6b62')",
  "button[aria-label*='\u505c\u6b62\u751f\u6210']",
  "button:has-text('\u505c\u6b62\u751f\u6210')"
];
const PROMPT_DRAFT_TIMEOUT_MS = 8000;
const PROMPT_READY_TIMEOUT_MS = 8000;
const PROMPT_SUBMISSION_TIMEOUT_MS = 8000;

export async function waitForComposer(page) {
  const composer = await findVisibleComposer(page, 30000);
  if (composer) {
    return composer;
  }

  throw new Error("Could not find the ChatGPT composer.");
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

export async function sendPromptInCurrentChatAndWaitForResponse(page, prompt, workflow) {
  const { initialAssistantCount } = await sendPrompt(page, prompt);

  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-message-author-role='assistant']").length > count,
    initialAssistantCount,
    { timeout: workflow.responseTimeoutMs }
  );

  return waitForStableAssistantMessage(page, workflow);
}

export async function sendPromptAndWaitForResponse(page, prompt, config) {
  if (isProjectHomeUrl(page.url(), config.chatgpt.projectUrl)) {
    return sendPromptWithFreshChatRecovery(page, prompt, config);
  }

  return sendPromptInCurrentChatAndWaitForResponse(page, prompt, config.workflow);
}

export async function openFreshProjectChat(page, config) {
  if (!config.chatgpt.projectUrl) {
    throw new Error("Missing chatgpt.projectUrl. Run bootstrap again.");
  }

  await page.goto(config.chatgpt.projectUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  if (await hasVisibleComposer(page, 8000)) {
    return;
  }

  const projectComposerSelectors = [
    "#prompt-textarea",
    "textarea[placeholder*='\u65b0\u804a\u5929']",
    "textarea[aria-label*='\u65b0\u804a\u5929']",
    "[role='textbox'][aria-label*='\u65b0\u804a\u5929']",
    "[contenteditable='true'][aria-label*='\u65b0\u804a\u5929']",
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
    'button[aria-label*="\u65b0\u5bf9\u8bdd"]',
    'button[aria-label*="\u65b0\u5efa\u5bf9\u8bdd"]',
    'button[aria-label*="\u65b0\u804a\u5929"]',
    '[role="button"][aria-label*="New chat"]',
    '[role="button"][aria-label*="\u65b0\u5bf9\u8bdd"]',
    '[role="button"][aria-label*="\u65b0\u5efa\u5bf9\u8bdd"]',
    '[role="button"][aria-label*="\u65b0\u804a\u5929"]',
    'button:has-text("New chat")',
    'button:has-text("New Chat")',
    'button:has-text("Start new chat")',
    'button:has-text("\u65b0\u5bf9\u8bdd")',
    'button:has-text("\u65b0\u5efa\u5bf9\u8bdd")',
    'button:has-text("\u65b0\u804a\u5929")',
    '[role="button"]:has-text("New chat")',
    '[role="button"]:has-text("New Chat")',
    '[role="button"]:has-text("Start new chat")',
    '[role="button"]:has-text("\u65b0\u5bf9\u8bdd")',
    '[role="button"]:has-text("\u65b0\u5efa\u5bf9\u8bdd")',
    '[role="button"]:has-text("\u65b0\u804a\u5929")',
    'div:has-text("New chat")',
    'div:has-text("\u65b0\u5bf9\u8bdd")',
    'div:has-text("\u65b0\u5efa\u5bf9\u8bdd")',
    'div:has-text("\u65b0\u804a\u5929")',
    'a:has-text("New chat")',
    'a:has-text("\u65b0\u5bf9\u8bdd")',
    'a:has-text("\u65b0\u5efa\u5bf9\u8bdd")',
    'a:has-text("\u65b0\u804a\u5929")'
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

export async function sendPromptWithFreshChatRecovery(page, prompt, config) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const promptState = await sendPrompt(page, prompt, config.chatgpt.projectUrl);

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

  const debugPath = path.join(DEBUG_DIR, `fresh-chat-create-failed-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);
  const error = new Error(
    `Timed out while waiting for a fresh project chat to be created. Screenshot saved to ${debugPath}`
  );
  error.code = "FRESH_CHAT_CREATION_FAILED";
  throw error;
}

export async function resetToProjectPage(page, config) {
  await page.goto(config.chatgpt.projectUrl, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForTimeout(1500);
  await openFreshProjectChat(page, config);
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

export async function getLatestAssistantText(page) {
  const locator = page.locator("[data-message-author-role='assistant']").last();
  if ((await locator.count()) === 0) {
    return "";
  }

  const codeBlockText = await locator.evaluate((element) => {
    const extractCodeBlockText = (node) => {
      const lines = [];
      let currentLine = "";

      const appendNodeText = (currentNode) => {
        if (currentNode.nodeName === "BR") {
          lines.push(currentLine);
          currentLine = "";
          return;
        }

        if (currentNode.nodeType === 3) {
          currentLine += currentNode.nodeValue || "";
          return;
        }

        const children = Array.from(currentNode.childNodes || []);
        if (children.length === 0) {
          currentLine += currentNode.textContent || "";
          return;
        }

        for (const child of children) {
          appendNodeText(child);
        }
      };

      appendNodeText(node);
      lines.push(currentLine);
      return lines.join("\n").trim();
    };

    const codeNodes = Array.from(element.querySelectorAll("pre code"));
    if (codeNodes.length > 0) {
      return codeNodes
        .map((node) => extractCodeBlockText(node))
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
  for (const selector of GENERATING_SELECTORS) {
    if ((await page.locator(selector).count()) > 0) {
      return true;
    }
  }

  return false;
}

async function capturePromptState(page) {
  const assistantLocator = page.locator("[data-message-author-role='assistant']");
  const userLocator = page.locator("[data-message-author-role='user']");

  return {
    initialAssistantCount: await assistantLocator.count(),
    initialUserCount: await userLocator.count(),
    initialUrl: page.url()
  };
}

async function sendPrompt(page, prompt, projectUrl = "") {
  const composerLocator = await waitForComposer(page);
  const promptState = await capturePromptState(page);

  await populateComposer(page, composerLocator, prompt);
  await submitPrompt(page);
  await waitForPromptSubmission(page, promptState, projectUrl);

  return promptState;
}

async function populateComposer(page, composerLocator, prompt) {
  await focusComposer(composerLocator);
  await clearComposer(page, composerLocator);
  await page.keyboard.insertText(prompt);
  await waitForPromptDraft(page, composerLocator);
}

async function submitPrompt(page) {
  const sendButton = await findVisibleSendButton(page, PROMPT_READY_TIMEOUT_MS);
  if (!sendButton) {
    throw await buildPromptReadyFailure(page);
  }

  await waitForSendButtonEnabled(page, sendButton);
  await sendButton.click();
}

async function waitForPromptSubmission(page, promptState, projectUrl = "") {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PROMPT_SUBMISSION_TIMEOUT_MS) {
    const currentUrl = page.url();
    const userCount = await page.locator("[data-message-author-role='user']").count();
    const assistantCount = await page.locator("[data-message-author-role='assistant']").count();

    if (userCount > promptState.initialUserCount || assistantCount > promptState.initialAssistantCount) {
      return;
    }

    if (projectUrl && isConversationUrl(currentUrl, projectUrl)) {
      return;
    }

    if (
      normalizeComparableUrl(currentUrl) !== normalizeComparableUrl(promptState.initialUrl) &&
      (!projectUrl || !isProjectHomeUrl(currentUrl, projectUrl))
    ) {
      return;
    }

    await page.waitForTimeout(250);
  }

  throw await buildPromptSubmissionFailure(page);
}

async function focusComposer(composerLocator) {
  await composerLocator.click().catch(() => null);
  if (typeof composerLocator.focus === "function") {
    await composerLocator.focus().catch(() => null);
  }
}

async function clearComposer(page, composerLocator) {
  if (!(await getComposerText(composerLocator))) {
    return;
  }

  await focusComposer(composerLocator);
  await page.keyboard.press("ControlOrMeta+A").catch(() => null);
  await page.keyboard.press("Backspace").catch(() => null);
}

async function waitForPromptDraft(page, composerLocator) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PROMPT_DRAFT_TIMEOUT_MS) {
    if (await getComposerText(composerLocator)) {
      return;
    }

    if (await findVisibleSendButton(page)) {
      return;
    }

    await page.waitForTimeout(250);
  }

  throw await buildPromptDraftFailure(page);
}

async function getComposerText(composerLocator) {
  return composerLocator.evaluate((element) => {
    if (!element) {
      return "";
    }

    if (typeof element.value === "string") {
      return element.value.trim();
    }

    return (element.innerText || element.textContent || "").trim();
  }).catch(() => "");
}

async function findVisibleSendButton(page, timeoutMs = 0) {
  const startedAt = Date.now();

  do {
    for (const selector of SEND_BUTTON_SELECTORS) {
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

async function waitForSendButtonEnabled(page, sendButton) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PROMPT_READY_TIMEOUT_MS) {
    if (await isButtonEnabled(sendButton)) {
      return;
    }

    await page.waitForTimeout(250);
  }

  throw await buildPromptReadyFailure(page);
}

async function isButtonEnabled(buttonLocator) {
  return buttonLocator.evaluate((element) => {
    if (!element) {
      return false;
    }

    if ("disabled" in element && element.disabled) {
      return false;
    }

    return element.getAttribute("aria-disabled") !== "true";
  }).catch(() => false);
}

async function buildPromptDraftFailure(page) {
  const debugPath = path.join(DEBUG_DIR, `prompt-draft-failed-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);
  const error = new Error(
    `ChatGPT showed the composer, but the prompt text never appeared in the draft area. Screenshot saved to ${debugPath}`
  );
  error.code = "PROMPT_DRAFT_FAILED";
  return error;
}

async function buildPromptReadyFailure(page) {
  const debugPath = path.join(DEBUG_DIR, `prompt-not-ready-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);
  const error = new Error(
    `ChatGPT showed the composer, but the send button never became ready. Screenshot saved to ${debugPath}`
  );
  error.code = "PROMPT_NOT_READY_TO_SEND";
  return error;
}

async function buildPromptSubmissionFailure(page) {
  const debugPath = path.join(DEBUG_DIR, `prompt-submit-failed-${Date.now()}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);
  const error = new Error(
    `Clicked send, but ChatGPT never confirmed that the prompt was submitted. Screenshot saved to ${debugPath}`
  );
  error.code = "PROMPT_SUBMISSION_FAILED";
  return error;
}
