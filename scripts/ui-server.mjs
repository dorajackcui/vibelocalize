import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "automation.config.json");
const UI_PATH = path.join(ROOT, "ui", "index.html");
const WORKBOOK_HELPER = path.join(ROOT, "scripts", "workbook_helper.py");
const PORT = 4312;

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

const status = {
  running: false,
  pid: null,
  lastExitCode: null,
  logLines: [],
  missingBootstrap: false,
  missingWorkbook: true
};

let runner = null;

startServer();

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/") {
        return respondHtml(res, await fs.readFile(UI_PATH, "utf8"));
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        return respondJson(res, 200, await buildConfigPayload());
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readJsonBody(req);
        const existing = await loadOrCreateConfig();
        const nextConfig = normalizeConfig(
          mergeConfig(existing, {
            workbook: body.workbook,
            workflow: body.workflow
          })
        );

        await saveConfig(nextConfig);
        return respondJson(res, 200, await buildConfigPayload(nextConfig));
      }

      if (req.method === "POST" && url.pathname === "/api/choose-file") {
        const filePath = await chooseWorkbookFile();
        const existing = await loadOrCreateConfig();
        const workbookInfo = await getWorkbookInfo(filePath);
        const nextConfig = normalizeConfig(
          mergeConfig(existing, {
            workbook: {
              filePath,
              sheetName: workbookInfo.activeSheetName
            }
          })
        );

        await saveConfig(nextConfig);
        return respondJson(res, 200, await buildConfigPayload(nextConfig));
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        if (runner) {
          return respondJson(res, 409, { error: "A job is already running." });
        }

        const config = await loadOrCreateConfig();
        if (isBootstrapMissing(config)) {
          status.missingBootstrap = true;
          return respondJson(res, 400, {
            error: "Bootstrap is incomplete. Please run `npm run bootstrap` once in Terminal."
          });
        }

        if (!config.workbook.filePath) {
          status.missingWorkbook = true;
          return respondJson(res, 400, {
            error: "No workbook selected yet. Choose a file first."
          });
        }

        startRunner();
        return respondJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/stop") {
        if (!runner) {
          return respondJson(res, 200, { ok: true, message: "No running job." });
        }

        runner.kill("SIGTERM");
        return respondJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const payload = await buildConfigPayload();
        return respondJson(res, 200, {
          status: payload.status,
          derived: payload.derived,
          workbookInfo: payload.workbookInfo
        });
      }

      respondJson(res, 404, { error: "Not found." });
    } catch (error) {
      respondJson(res, 500, { error: error.message });
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`UI ready at http://127.0.0.1:${PORT}`);
  });
}

async function buildConfigPayload(configOverride) {
  const config = configOverride ?? (await loadOrCreateConfig());
  const workbookInfo = config.workbook.filePath ? await getWorkbookInfo(config.workbook.filePath) : null;

  status.missingBootstrap = isBootstrapMissing(config);
  status.missingWorkbook = !config.workbook.filePath;

  return {
    config,
    status,
    derived: buildDerivedInfo(config),
    workbookInfo
  };
}

function startRunner() {
  status.running = true;
  status.pid = null;
  status.lastExitCode = null;
  appendLog(`Starting job at ${new Date().toLocaleString()}`);

  runner = spawn(process.execPath, ["scripts/chatgpt-wps-loop.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  status.pid = runner.pid;

  runner.stdout.on("data", (chunk) => {
    appendLog(chunk.toString());
  });

  runner.stderr.on("data", (chunk) => {
    appendLog(chunk.toString());
  });

  runner.on("close", (code) => {
    status.running = false;
    status.pid = null;
    status.lastExitCode = code;
    appendLog(`Job finished with exit code ${code}`);
    runner = null;
  });

  runner.on("error", (error) => {
    status.running = false;
    status.pid = null;
    status.lastExitCode = 1;
    appendLog(`Runner error: ${error.message}`);
    runner = null;
  });
}

async function loadOrCreateConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return normalizeConfig(mergeConfig(DEFAULT_CONFIG, JSON.parse(raw)));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await saveConfig(DEFAULT_CONFIG);
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
  workflow.sourceColumn = String(workflow.sourceColumn || DEFAULT_CONFIG.workflow.sourceColumn).trim().toUpperCase();
  workflow.targetColumn = String(workflow.targetColumn || DEFAULT_CONFIG.workflow.targetColumn).trim().toUpperCase();

  return normalized;
}

function readNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildDerivedInfo(config) {
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

function isBootstrapMissing(config) {
  return !config.chatgpt.projectUrl;
}

function appendLog(text) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    status.logLines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  status.logLines = status.logLines.slice(-300);
}

async function chooseWorkbookFile() {
  const { stdout } = await execFileAsync("osascript", [
    "-e",
    'POSIX path of (choose file with prompt "Select workbook (.xlsx or .xlsm)")'
  ], {
    cwd: ROOT
  });

  const filePath = stdout.trim();
  const ext = path.extname(filePath).toLowerCase();

  if (![".xlsx", ".xlsm"].includes(ext)) {
    throw new Error("Please choose an .xlsx or .xlsm workbook.");
  }

  return filePath;
}

async function getWorkbookInfo(filePath) {
  const stdout = await runCommandWithInput("python3", [WORKBOOK_HELPER, "info"], JSON.stringify({ filePath }));
  return JSON.parse(stdout);
}

function runCommandWithInput(command, args, inputText) {
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function respondHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function respondJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
