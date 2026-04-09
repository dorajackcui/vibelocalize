import test from "node:test";
import assert from "node:assert/strict";
import {
  sendPromptInCurrentChatAndWaitForResponse,
  sendPromptWithFreshChatRecovery
} from "../scripts/lib/chatgpt-interaction.mjs";

const projectUrl = "https://chatgpt.com/g/project-id/project";
const conversationUrl = "https://chatgpt.com/g/project-id/c/current-conversation";
const config = {
  chatgpt: {
    projectUrl
  },
  workflow: {
    pollIntervalMs: 0,
    responseTimeoutMs: 240000
  }
};

test("current-chat assistant timeout resets to the project page and resends in a fresh chat", async () => {
  const page = new MockPage({
    initialUrl: conversationUrl,
    projectUrl,
    waitForFunctionOutcomes: [timeoutError("page.waitForFunction: Timeout 240000ms exceeded."), "success"]
  });

  const result = await sendPromptInCurrentChatAndWaitForResponse(page, "bonjour", config);

  assert.equal(result, "translated result");
  assert.equal(page.sentPrompts.length, 2);
  assert.equal(page.gotoCalls, 1);
  assert.equal(page.reloadCalls, 1);
  assert.match(page.screenshots[0], /assistant-response-timeout/);
});

test("missing composer is treated as recoverable and retried through a fresh project chat", async () => {
  const page = new MockPage({
    composerVisible: false,
    initialUrl: conversationUrl,
    projectUrl,
    waitForFunctionOutcomes: ["success"]
  });

  const result = await sendPromptInCurrentChatAndWaitForResponse(page, "bonjour", config);

  assert.equal(result, "translated result");
  assert.equal(page.sentPrompts.length, 1);
  assert.equal(page.gotoCalls, 1);
  assert.match(page.screenshots[0], /composer-missing/);
});

test("non-recoverable send errors are not retried", async () => {
  const page = new MockPage({
    initialUrl: conversationUrl,
    projectUrl,
    waitForFunctionOutcomes: [new Error("Unexpected protocol error")]
  });

  await assert.rejects(
    () => sendPromptInCurrentChatAndWaitForResponse(page, "bonjour", config),
    /Unexpected protocol error/
  );

  assert.equal(page.sentPrompts.length, 1);
  assert.equal(page.gotoCalls, 0);
  assert.equal(page.reloadCalls, 0);
});

test("three recoverable failures still stop with the last error", async () => {
  const page = new MockPage({
    initialUrl: conversationUrl,
    projectUrl,
    waitForFunctionOutcomes: [
      timeoutError("page.waitForFunction: Timeout 240000ms exceeded."),
      timeoutError("page.waitForFunction: Timeout 240000ms exceeded."),
      timeoutError("page.waitForFunction: Timeout 240000ms exceeded.")
    ]
  });

  await assert.rejects(
    () => sendPromptInCurrentChatAndWaitForResponse(page, "bonjour", config),
    (error) => error.code === "ASSISTANT_RESPONSE_TIMEOUT"
  );

  assert.equal(page.sentPrompts.length, 3);
  assert.equal(page.gotoCalls, 2);
  assert.equal(page.reloadCalls, 2);
});

test("project-page recovery retries a navigation timeout on the next attempt", async () => {
  const page = new MockPage({
    initialUrl: projectUrl,
    projectUrl,
    gotoOutcomes: [timeoutError("page.goto: Timeout 30000ms exceeded.")],
    waitForFunctionOutcomes: [timeoutError("page.waitForFunction: Timeout 240000ms exceeded."), "success"]
  });

  const result = await sendPromptWithFreshChatRecovery(page, "bonjour", config);

  assert.equal(result, "translated result");
  assert.equal(page.sentPrompts.length, 2);
  assert.equal(page.gotoCalls, 2);
  assert.equal(page.reloadCalls, 1);
  assert.ok(page.screenshots.some((item) => /project-open-timeout/.test(item)));
});

class MockPage {
  constructor(options = {}) {
    this.projectUrl = options.projectUrl ?? projectUrl;
    this.urlValue = options.initialUrl ?? this.projectUrl;
    this.composerVisible = options.composerVisible ?? true;
    this.composerVisibleAfterGoto = options.composerVisibleAfterGoto ?? true;
    this.composerVisibleAfterReload = options.composerVisibleAfterReload ?? this.composerVisibleAfterGoto;
    this.gotoOutcomes = [...(options.gotoOutcomes ?? [])];
    this.reloadOutcomes = [...(options.reloadOutcomes ?? [])];
    this.waitForFunctionOutcomes = [...(options.waitForFunctionOutcomes ?? [])];
    this.sentPrompts = [];
    this.screenshots = [];
    this.gotoCalls = 0;
    this.reloadCalls = 0;
    this.pendingPrompt = "";
    this.userCount = options.userCount ?? 0;
    this.assistantCount = options.assistantCount ?? 0;
    this.latestAssistantText = options.latestAssistantText ?? "translated result";
    this.keyboard = {
      insertText: async (text) => {
        this.pendingPrompt = text;
      },
      press: async (key) => {
        if (key !== "Enter") {
          return;
        }

        this.sentPrompts.push(this.pendingPrompt);
        this.pendingPrompt = "";
        this.userCount += 1;

        if (isProjectUrl(this.urlValue, this.projectUrl)) {
          this.urlValue = `${this.projectUrl.replace(/\/project$/, "")}/c/retry-${this.sentPrompts.length}`;
        }
      }
    };
  }

  locator(selector) {
    return new MockLocator(this, selector);
  }

  url() {
    return this.urlValue;
  }

  async goto(url) {
    this.gotoCalls += 1;
    const outcome = this.gotoOutcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }

    this.urlValue = url;
    this.composerVisible = this.composerVisibleAfterGoto;
  }

  async reload() {
    this.reloadCalls += 1;
    const outcome = this.reloadOutcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }

    this.composerVisible = this.composerVisibleAfterReload;
  }

  async waitForTimeout() {}

  async waitForFunction() {
    const outcome = this.waitForFunctionOutcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }

    this.assistantCount += 1;
  }

  async screenshot({ path }) {
    this.screenshots.push(path);
  }

  getCount(selector) {
    if (selector === "[data-message-author-role='assistant']") {
      return this.assistantCount;
    }

    if (selector === "[data-message-author-role='user']") {
      return this.userCount;
    }

    if (isStopSelector(selector)) {
      return 0;
    }

    if (isComposerSelector(selector)) {
      return this.composerVisible ? 1 : 0;
    }

    return 0;
  }

  async isVisible(selector) {
    return this.getCount(selector) > 0;
  }

  async click() {}

  async evaluate() {
    return "";
  }

  async innerText() {
    return this.latestAssistantText;
  }
}

class MockLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  async count() {
    return this.page.getCount(this.selector);
  }

  nth() {
    return this;
  }

  first() {
    return this;
  }

  last() {
    return this;
  }

  async isVisible() {
    return this.page.isVisible(this.selector);
  }

  async click() {
    return this.page.click(this.selector);
  }

  async evaluate() {
    return this.page.evaluate(this.selector);
  }

  async innerText() {
    return this.page.innerText(this.selector);
  }
}

function isComposerSelector(selector) {
  return selector === "#prompt-textarea" || selector === "textarea[placeholder]" || selector === "div[contenteditable='true']";
}

function isProjectUrl(rawUrl, targetProjectUrl) {
  return rawUrl.replace(/\/+$/, "") === targetProjectUrl.replace(/\/+$/, "");
}

function isStopSelector(selector) {
  return selector.includes("Stop") || selector.includes("閸嬫粍顒");
}

function timeoutError(message) {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}
