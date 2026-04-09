import test from "node:test";
import assert from "node:assert/strict";
import {
  sendPromptInCurrentChatAndWaitForResponse,
  sendPromptWithFreshChatRecovery,
  waitForStableAssistantMessage
} from "../scripts/lib/chatgpt-interaction.mjs";

const COMPOSER_SELECTORS = new Set([
  "#prompt-textarea",
  "textarea[placeholder]",
  "div[contenteditable='true']"
]);
const SEND_BUTTON_SELECTORS = new Set([
  "button[data-testid='send-button']",
  "button[aria-label*='Send']",
  "button[aria-label*='\u53d1\u9001']"
]);
const GENERATING_SELECTORS = new Set([
  "button[aria-label*='Stop']",
  "button[aria-label*='\u505c\u6b62']",
  "button:has-text('Stop')",
  "button:has-text('\u505c\u6b62')",
  "button[aria-label*='\u505c\u6b62\u751f\u6210']",
  "button:has-text('\u505c\u6b62\u751f\u6210')"
]);
const ASSISTANT_SELECTOR = "[data-message-author-role='assistant']";
const USER_SELECTOR = "[data-message-author-role='user']";

test("sendPromptInCurrentChatAndWaitForResponse inserts text and waits for the send button to become ready", async () => {
  await withMockedClock(async (clock) => {
    let assistantCreated = false;
    const page = new MockPage({
      clock,
      initialUrl: "https://chatgpt.com/g/project-id/c/current-conversation",
      sendButtonVisible: false,
      sendButtonEnabled: false,
      onWait: (state) => {
        if (state.composerText && clock.now >= 500) {
          state.sendButtonVisible = true;
          state.sendButtonEnabled = true;
        }

        if (state.userCount > 0 && !assistantCreated) {
          assistantCreated = true;
          state.assistantCount = 1;
          state.latestAssistantText = "translated row";
        }
      },
      onSubmit: (state) => {
        state.userCount = 1;
      }
    });

    const responseText = await sendPromptInCurrentChatAndWaitForResponse(page, "hello world", {
      responseTimeoutMs: 100,
      pollIntervalMs: 1
    });

    assert.equal(responseText, "translated row");
    assert.deepEqual(page.insertedTexts, ["hello world"]);
    assert.equal(page.sendClickCount, 1);
    assert.equal(page.enterPressCount, 0);
    assert.equal(page.waitForFunctionCallCount, 1);
  });
});

test("sendPromptWithFreshChatRecovery accepts a conversation URL switch after send", async () => {
  await withMockedClock(async (clock) => {
    let assistantCreated = false;
    const projectUrl = "https://chatgpt.com/g/project-id/project";
    const page = new MockPage({
      clock,
      initialUrl: projectUrl,
      onInsertText: (state) => {
        state.sendButtonVisible = true;
        state.sendButtonEnabled = true;
      },
      onSubmit: (state) => {
        state.url = "https://chatgpt.com/g/project-id/c/new-conversation";
      },
      onWait: (state) => {
        if (state.url !== projectUrl && !assistantCreated) {
          assistantCreated = true;
          state.assistantCount = 1;
          state.latestAssistantText = "fresh chat reply";
        }
      }
    });

    const responseText = await sendPromptWithFreshChatRecovery(page, "hello project", {
      chatgpt: { projectUrl },
      workflow: {
        responseTimeoutMs: 100,
        pollIntervalMs: 1
      }
    });

    assert.equal(responseText, "fresh chat reply");
    assert.deepEqual(page.insertedTexts, ["hello project"]);
    assert.equal(page.sendClickCount, 1);
    assert.equal(page.enterPressCount, 0);
    assert.equal(page.waitForFunctionCallCount, 1);
  });
});

test("waitForStableAssistantMessage waits while a stop control is present", async () => {
  await withMockedClock(async (clock) => {
    const page = new MockPage({
      clock,
      initialUrl: "https://chatgpt.com/g/project-id/c/current-conversation",
      initialAssistantCount: 1,
      initialAssistantText: "same answer",
      generating: true,
      onWait: (state) => {
        if (clock.now >= 3) {
          state.generating = false;
        }
      }
    });

    const result = await waitForStableAssistantMessage(page, {
      responseTimeoutMs: 20,
      pollIntervalMs: 1
    });

    assert.equal(result, "same answer");
    assert.ok(clock.now >= 5);
  });
});

test("sendPromptInCurrentChatAndWaitForResponse fails when the prompt never appears in the draft area", async () => {
  await withMockedClock(async (clock) => {
    const page = new MockPage({
      clock,
      initialUrl: "https://chatgpt.com/g/project-id/c/current-conversation",
      acceptsInput: false
    });

    await assert.rejects(
      () =>
        sendPromptInCurrentChatAndWaitForResponse(page, "hello failure", {
          responseTimeoutMs: 100,
          pollIntervalMs: 1
        }),
      (error) => {
        assert.equal(error.code, "PROMPT_DRAFT_FAILED");
        assert.match(error.message, /Screenshot saved to/);
        return true;
      }
    );

    assert.deepEqual(page.insertedTexts, ["hello failure"]);
    assert.equal(page.sendClickCount, 0);
    assert.equal(page.enterPressCount, 0);
    assert.equal(page.waitForFunctionCallCount, 0);
    assert.equal(page.screenshots.length, 1);
  });
});

test("sendPromptInCurrentChatAndWaitForResponse fails when the send button never becomes enabled", async () => {
  await withMockedClock(async (clock) => {
    const page = new MockPage({
      clock,
      initialUrl: "https://chatgpt.com/g/project-id/c/current-conversation",
      onInsertText: (state) => {
        state.sendButtonVisible = true;
        state.sendButtonEnabled = false;
      }
    });

    await assert.rejects(
      () =>
        sendPromptInCurrentChatAndWaitForResponse(page, "hello wait", {
          responseTimeoutMs: 100,
          pollIntervalMs: 1
        }),
      (error) => {
        assert.equal(error.code, "PROMPT_NOT_READY_TO_SEND");
        assert.match(error.message, /Screenshot saved to/);
        return true;
      }
    );

    assert.equal(page.sendClickCount, 0);
    assert.equal(page.enterPressCount, 0);
  });
});

test("sendPromptInCurrentChatAndWaitForResponse still fails if clicking send produces no submission evidence", async () => {
  await withMockedClock(async (clock) => {
    const page = new MockPage({
      clock,
      initialUrl: "https://chatgpt.com/g/project-id/c/current-conversation",
      onInsertText: (state) => {
        state.sendButtonVisible = true;
        state.sendButtonEnabled = true;
      }
    });

    await assert.rejects(
      () =>
        sendPromptInCurrentChatAndWaitForResponse(page, "no confirmation", {
          responseTimeoutMs: 100,
          pollIntervalMs: 1
        }),
      (error) => {
        assert.equal(error.code, "PROMPT_SUBMISSION_FAILED");
        assert.match(error.message, /Screenshot saved to/);
        return true;
      }
    );

    assert.equal(page.sendClickCount, 1);
    assert.equal(page.enterPressCount, 0);
    assert.equal(page.waitForFunctionCallCount, 0);
  });
});

async function withMockedClock(run) {
  const clock = { now: 0 };
  const originalDateNow = Date.now;
  Date.now = () => clock.now;

  try {
    await run(clock);
  } finally {
    Date.now = originalDateNow;
  }
}

class MockPage {
  constructor({
    clock,
    initialUrl,
    initialAssistantCount = 0,
    initialAssistantText = "",
    generating = false,
    sendButtonVisible = false,
    sendButtonEnabled = false,
    acceptsInput = true,
    onInsertText = () => {},
    onSubmit = () => {},
    onWait = () => {}
  }) {
    this.clock = clock;
    this.acceptsInput = acceptsInput;
    this.onInsertText = onInsertText;
    this.onSubmit = onSubmit;
    this.onWait = onWait;
    this.selectionAll = false;
    this.state = {
      url: initialUrl,
      userCount: 0,
      assistantCount: initialAssistantCount,
      latestAssistantText: initialAssistantText,
      generating,
      sendButtonVisible,
      sendButtonEnabled,
      composerText: ""
    };
    this.insertedTexts = [];
    this.sendClickCount = 0;
    this.enterPressCount = 0;
    this.waitForFunctionCallCount = 0;
    this.screenshots = [];
    this.keyboard = {
      insertText: async (text) => {
        this.insertedTexts.push(text);
        if (this.acceptsInput) {
          this.state.composerText = text;
        }
        await this.onInsertText(this.state, this, text);
      },
      press: async (key) => {
        if (key === "ControlOrMeta+A") {
          this.selectionAll = true;
          return;
        }

        if ((key === "Backspace" || key === "Delete") && this.selectionAll) {
          this.state.composerText = "";
          this.selectionAll = false;
        }
      }
    };
  }

  locator(selector) {
    return new MockCollectionLocator(this, selector);
  }

  url() {
    return this.state.url;
  }

  async waitForTimeout(timeoutMs) {
    this.clock.now += timeoutMs;
    await this.onWait(this.state, this);
  }

  async waitForFunction(_predicate, initialAssistantCount, options = {}) {
    this.waitForFunctionCallCount += 1;
    const timeoutMs = options.timeout ?? 0;
    const startedAt = this.clock.now;

    while (this.clock.now - startedAt < timeoutMs) {
      if (this.state.assistantCount > initialAssistantCount) {
        return;
      }

      await this.waitForTimeout(1);
    }

    throw new Error("waitForFunction timed out in the mock page.");
  }

  async screenshot(options) {
    this.screenshots.push(options);
  }
}

class MockCollectionLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  async count() {
    if (COMPOSER_SELECTORS.has(this.selector)) {
      return 1;
    }

    if (SEND_BUTTON_SELECTORS.has(this.selector)) {
      return this.page.state.sendButtonVisible ? 1 : 0;
    }

    if (GENERATING_SELECTORS.has(this.selector)) {
      return this.page.state.generating ? 1 : 0;
    }

    if (this.selector === ASSISTANT_SELECTOR) {
      return this.page.state.assistantCount;
    }

    if (this.selector === USER_SELECTOR) {
      return this.page.state.userCount;
    }

    return 0;
  }

  nth() {
    return new MockElementLocator(this.page, this.selector);
  }

  first() {
    return new MockElementLocator(this.page, this.selector);
  }

  last() {
    return new MockElementLocator(this.page, this.selector);
  }
}

class MockElementLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  async count() {
    if (this.selector === ASSISTANT_SELECTOR) {
      return this.page.state.assistantCount > 0 ? 1 : 0;
    }

    if (COMPOSER_SELECTORS.has(this.selector)) {
      return 1;
    }

    if (SEND_BUTTON_SELECTORS.has(this.selector)) {
      return this.page.state.sendButtonVisible ? 1 : 0;
    }

    return 0;
  }

  async isVisible() {
    if (COMPOSER_SELECTORS.has(this.selector)) {
      return true;
    }

    if (SEND_BUTTON_SELECTORS.has(this.selector)) {
      return this.page.state.sendButtonVisible;
    }

    return false;
  }

  async click() {
    if (SEND_BUTTON_SELECTORS.has(this.selector)) {
      this.page.sendClickCount += 1;
      await this.page.onSubmit(this.page.state, this.page, "button");
      return;
    }
  }

  async focus() {}

  async evaluate(callback) {
    if (SEND_BUTTON_SELECTORS.has(this.selector)) {
      return callback({
        disabled: !this.page.state.sendButtonEnabled,
        getAttribute: (name) => {
          if (name === "aria-disabled") {
            return this.page.state.sendButtonEnabled ? "false" : "true";
          }

          return null;
        }
      });
    }

    if (COMPOSER_SELECTORS.has(this.selector)) {
      return callback({
        value: this.page.state.composerText,
        innerText: this.page.state.composerText,
        textContent: this.page.state.composerText
      });
    }

    return callback({
      querySelectorAll: () => []
    });
  }

  async innerText() {
    return this.page.state.latestAssistantText;
  }
}
