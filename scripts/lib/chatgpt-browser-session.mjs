import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  buildManualChromeDebuggingCommand,
  launchChromeWithDebugPort
} from "../runtime-platform.mjs";
import { saveConfig } from "./automation-config.mjs";
import {
  deriveProjectUrl,
  deriveProjectUrlSafe,
  getInitialChatgptUrl,
  isChatgptUrl,
  isConversationUrl,
  isProjectHomeUrl,
  normalizeOptionalComparableUrl
} from "./chatgpt-url.mjs";

const ROOT = process.cwd();
const DEBUG_DIR = path.join(ROOT, "debug");

export async function launchBrowser(config) {
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

  await page.goto(getInitialChatgptUrl(config), { waitUntil: "domcontentloaded" });
  return {
    page,
    refreshPage: async () => page,
    close: async () => {
      await context.close();
    }
  };
}

export async function ensureChromeDebugPort(config) {
  const debugUrl = getChromeDebugUrl(config);
  if (await isChromeDebugPortReady(debugUrl)) {
    return;
  }

  const userDataDir = path.resolve(ROOT, config.browser.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });

  console.log(`Chrome debug port ${config.browser.debugPort} is not ready. Launching Google Chrome for you...`);
  const launchInfo = await launchChromeWithDebugPort({
    debugPort: config.browser.debugPort,
    userDataDir
  });

  const ready = await waitForChromeDebugPort(debugUrl, 30000);
  if (!ready) {
    throw new Error(
      [
        `${launchInfo.browserName} was launched, but the remote debugging port ${config.browser.debugPort} did not become available in time.`,
        "Make sure Chrome is installed and retry.",
        `If needed, start Chrome manually with: ${launchInfo.manualCommand ?? buildManualChromeDebuggingCommand({ debugPort: config.browser.debugPort, userDataDir })}`
      ].join(" ")
    );
  }
}

export async function connectToExistingChrome(config) {
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
    listPages: async () => listChatgptPages(browser, config),
    close: async () => {
      await browser.close();
    }
  };
}

export async function pickChatgptPage(browser, config) {
  const contexts = browser.contexts();
  const matchingPages = listChatgptPages(browser, config);
  const configuredPage = pickConfiguredChatgptPage(matchingPages, config);

  if (configuredPage) {
    return configuredPage;
  }

  if (!config.chatgpt.projectUrl && matchingPages.length > 0) {
    return matchingPages.at(-1);
  }

  for (const context of contexts) {
    const page = await context.newPage();
    await page.goto(getInitialChatgptUrl(config), { waitUntil: "domcontentloaded" });
    return page;
  }

  if (matchingPages.length > 0) {
    return matchingPages.at(-1);
  }

  return null;
}

export function listChatgptPages(browser, config) {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => isChatgptUrl(page.url(), config.chatgpt.homeUrl));
}

export function pickConfiguredChatgptPage(pages, config) {
  const targetUrl = normalizeOptionalComparableUrl(config.chatgpt.targetUrl);
  const projectUrl = normalizeOptionalComparableUrl(config.chatgpt.projectUrl);

  if (targetUrl) {
    const exactTargetMatch = pages.filter((page) => normalizeOptionalComparableUrl(page.url()) === targetUrl);
    if (exactTargetMatch.length > 0) {
      return exactTargetMatch.at(-1);
    }
  }

  if (!projectUrl) {
    return null;
  }

  const projectHomeMatches = pages.filter((page) => isProjectHomeUrl(page.url(), config.chatgpt.projectUrl));
  if (projectHomeMatches.length > 0) {
    return projectHomeMatches.at(-1);
  }

  const projectConversationMatches = pages.filter((page) => isConversationUrl(page.url(), config.chatgpt.projectUrl));
  if (projectConversationMatches.length > 0) {
    return projectConversationMatches.at(-1);
  }

  return null;
}

export async function bootstrapChatgpt(config, browserSession, rl) {
  if (config.browser.mode === "attach") {
    console.log(`Attach mode is enabled. Connected to Chrome on port ${config.browser.debugPort}.`);
    console.log("If needed, log in to ChatGPT in that Chrome window first and finish any human verification there.");
  } else {
    console.log("A dedicated Chrome window is open.");
    console.log("Log in to ChatGPT if needed.");
  }

  console.log("Open any chat page inside the target project, or the project page itself.");
  console.log("If you have other ChatGPT tabs from different projects open, close them first.");
  console.log("When that page is ready, press Enter here.");
  await rl.question("");

  const pageCandidates =
    typeof browserSession.listPages === "function"
      ? await browserSession.listPages()
      : [await browserSession.refreshPage()];
  const page = pickBootstrapChatgptPage(pageCandidates);
  config.chatgpt.targetUrl = page.url();
  config.chatgpt.projectUrl = deriveProjectUrl(page.url());
  await saveConfig(config);
  console.log(`Captured project URL: ${config.chatgpt.projectUrl}`);
  return page;
}

export function pickBootstrapChatgptPage(pages) {
  if (pages.length === 0) {
    throw new Error("Could not find an open ChatGPT tab for bootstrap.");
  }

  const projectCandidates = pages
    .map((page) => ({
      page,
      projectUrl: deriveProjectUrlSafe(page.url())
    }))
    .filter((candidate) => candidate.projectUrl);
  const uniqueProjectUrls = [...new Set(projectCandidates.map((candidate) => candidate.projectUrl))];

  if (uniqueProjectUrls.length === 1) {
    const matchingProjectPages = projectCandidates.filter(
      (candidate) => candidate.projectUrl === uniqueProjectUrls[0]
    );
    return matchingProjectPages.at(-1)?.page ?? pages.at(-1);
  }

  if (uniqueProjectUrls.length > 1) {
    throw new Error(
      [
        "Bootstrap found multiple ChatGPT projects open at the same time.",
        "Close the other ChatGPT project tabs, keep only the target project tab open, then run bootstrap again.",
        `Detected projects: ${uniqueProjectUrls.join(", ")}`
      ].join(" ")
    );
  }

  if (pages.length === 1) {
    return pages[0];
  }

  throw new Error(
    "Bootstrap could not determine which ChatGPT tab belongs to the target project. Open the target project page in a single ChatGPT tab and retry."
  );
}

export function getChromeDebugUrl(config) {
  return `http://127.0.0.1:${config.browser.debugPort}`;
}

export async function isChromeDebugPortReady(debugUrl) {
  try {
    const response = await fetch(`${debugUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForChromeDebugPort(debugUrl, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await isChromeDebugPortReady(debugUrl)) {
      return true;
    }

    await sleep(500);
  }

  return false;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
