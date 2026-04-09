import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveProjectUrl,
  deriveProjectUrlSafe,
  isConversationUrl,
  isProjectHomeUrl,
  normalizeComparableUrl,
  normalizeOptionalComparableUrl
} from "../scripts/lib/chatgpt-url.mjs";

test("normalizeComparableUrl drops trailing slashes", () => {
  assert.equal(
    normalizeComparableUrl("https://chatgpt.com/g/abc/project///"),
    "https://chatgpt.com/g/abc/project"
  );
});

test("normalizeOptionalComparableUrl returns empty string on invalid URL", () => {
  assert.equal(normalizeOptionalComparableUrl("not-a-url"), "");
});

test("deriveProjectUrl supports both project and conversation URLs", () => {
  assert.equal(
    deriveProjectUrl("https://chatgpt.com/g/project-id/project"),
    "https://chatgpt.com/g/project-id/project"
  );
  assert.equal(
    deriveProjectUrl("https://chatgpt.com/g/project-id/c/conversation-id"),
    "https://chatgpt.com/g/project-id/project"
  );
});

test("deriveProjectUrlSafe returns empty string for unsupported URLs", () => {
  assert.equal(deriveProjectUrlSafe("https://chatgpt.com/"), "");
});

test("project and conversation helpers identify matching URLs", () => {
  const projectUrl = "https://chatgpt.com/g/project-id/project";
  assert.equal(isProjectHomeUrl("https://chatgpt.com/g/project-id/project/", projectUrl), true);
  assert.equal(
    isConversationUrl("https://chatgpt.com/g/project-id/c/conversation-id", projectUrl),
    true
  );
});
