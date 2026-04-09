import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

export const CONFIG_PATH = path.join(ROOT, "automation.config.json");

export const DEFAULT_CONFIG = {
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

export async function loadOrCreateConfig(configPath = CONFIG_PATH) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return normalizeConfig(mergeConfig(DEFAULT_CONFIG, JSON.parse(raw)));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await saveConfig(DEFAULT_CONFIG, configPath);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(config, configPath = CONFIG_PATH) {
  await fs.writeFile(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
}

export function mergeConfig(base, override) {
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

export function normalizeConfig(config) {
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
  workflow.maxLoops = Math.max(0, readNumber(workflow.maxLoops, DEFAULT_CONFIG.workflow.maxLoops));
  workflow.sourceColumn = String(workflow.sourceColumn || DEFAULT_CONFIG.workflow.sourceColumn).trim().toUpperCase();
  workflow.targetColumn = String(workflow.targetColumn || DEFAULT_CONFIG.workflow.targetColumn).trim().toUpperCase();

  return normalized;
}

export function buildDerivedInfo(config) {
  const runsPerConversation = config.workflow.resetConversationEveryRuns;
  const totalConversations = config.workflow.newConversationLimit + 1;
  const totalRuns = totalConversations * runsPerConversation;
  const totalRows = totalRuns * config.workflow.batchSize;

  return {
    totalConversations,
    totalRuns,
    totalRows
  };
}

export function isBootstrapMissing(config) {
  return !config.chatgpt.projectUrl;
}

export function readNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
