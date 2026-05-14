import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  chooseWorkbookFile as chooseWorkbookFileWithDialog,
  openFileInDefaultApp
} from "./runtime-platform.mjs";
import {
  buildDerivedInfo,
  isBootstrapMissing,
  loadOrCreateConfig,
  mergeConfig,
  normalizeConfig,
  saveConfig
} from "./lib/automation-config.mjs";
import {
  formatWorkbookWriteIssue,
  inspectWorkbook,
  getWorkbookWriteCheck
} from "./lib/workbook-service.mjs";
import { buildReviewActionHint } from "./lib/review-report.mjs";

const ROOT = process.cwd();
const UI_PATH = path.join(ROOT, "ui", "index.html");
const PORT = 4312;

const status = {
  running: false,
  pid: null,
  lastExitCode: null,
  logLines: [],
  missingBootstrap: false,
  missingWorkbook: true
};

let runner = null;
let runnerReviewReportPath = "";

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
        let filePath = "";
        try {
          filePath = await chooseWorkbookFile();
        } catch (error) {
          if (
            error.code === "FILE_SELECTION_CANCELLED" ||
            error.code === "INVALID_WORKBOOK_SELECTION" ||
            error.code === "FILE_SELECTION_UNSUPPORTED"
          ) {
            return respondJson(res, 400, { error: error.message });
          }

          throw error;
        }

        const existing = await loadOrCreateConfig();
        const workbookInfo = await inspectWorkbook(filePath);
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

      if (req.method === "POST" && url.pathname === "/api/workbook/inspect") {
        const body = await readJsonBody(req);
        if (!body.filePath) {
          return respondJson(res, 400, { error: "Workbook file path is required." });
        }

        return respondJson(res, 200, await inspectWorkbook(body.filePath, body.sheetName || ""));
      }

      if (req.method === "POST" && url.pathname === "/api/open-workbook") {
        const body = await readJsonBody(req);
        const filePath = String(body.filePath || "").trim();

        if (!filePath) {
          return respondJson(res, 400, { error: "Workbook file path is required." });
        }

        await fs.access(filePath);
        const opened = await openFileInDefaultApp(filePath);
        if (!opened) {
          return respondJson(res, 400, {
            error: "Opening workbook files is only implemented for macOS and Windows."
          });
        }

        return respondJson(res, 200, { ok: true });
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

        const writeCheck = await getWorkbookWriteCheck(config.workbook.filePath);
        if (!writeCheck.ok) {
          return respondJson(res, 400, {
            error: formatWorkbookWriteIssue(writeCheck, config.workbook.filePath)
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
          workbookInfo: payload.workbookInfo,
          sheetAnalysis: payload.sheetAnalysis,
          writeCheck: payload.writeCheck
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
  const workbookInspection = config.workbook.filePath
    ? await inspectWorkbook(config.workbook.filePath, config.workbook.sheetName)
    : null;
  const workbookInfo = workbookInspection
    ? {
        sheetNames: workbookInspection.sheetNames,
        activeSheetName: workbookInspection.activeSheetName
      }
    : null;
  const sheetAnalysis = workbookInspection?.sheetAnalysis ?? null;
  const writeCheck = config.workbook.filePath ? await getWorkbookWriteCheck(config.workbook.filePath) : null;

  status.missingBootstrap = isBootstrapMissing(config);
  status.missingWorkbook = !config.workbook.filePath;

  return {
    config,
    status,
    derived: buildDerivedInfo(config),
    workbookInfo,
    sheetAnalysis,
    writeCheck
  };
}

function startRunner() {
  status.running = true;
  status.pid = null;
  status.lastExitCode = null;
  runnerReviewReportPath = "";
  appendLog(`Starting job at ${new Date().toLocaleString()}`);

  runner = spawn(process.execPath, ["scripts/chatgpt-wps-loop.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  status.pid = runner.pid;

  runner.stdout.on("data", (chunk) => {
    recordRunnerLog(chunk.toString());
  });

  runner.stderr.on("data", (chunk) => {
    recordRunnerLog(chunk.toString());
  });

  runner.on("close", async (code) => {
    status.running = false;
    status.pid = null;
    status.lastExitCode = code;
    appendLog(`Job finished with exit code ${code}`);
    await appendFinalReviewHint(runnerReviewReportPath);
    runnerReviewReportPath = "";
    runner = null;
  });

  runner.on("error", (error) => {
    status.running = false;
    status.pid = null;
    status.lastExitCode = 1;
    appendLog(`Runner error: ${error.message}`);
    runnerReviewReportPath = "";
    runner = null;
  });
}

function appendLog(text) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const stampedLines = lines.map((line) => `[${new Date().toLocaleTimeString()}] ${line}`);
  status.logLines.push(...stampedLines);

  status.logLines = status.logLines.slice(-300);
  return stampedLines;
}

function recordRunnerLog(text) {
  const lines = appendLog(text);
  const reportPath = findLatestReviewReportPath(lines);
  if (reportPath) {
    runnerReviewReportPath = reportPath;
  }
}

async function appendFinalReviewHint(reportPath) {
  if (!reportPath) {
    return;
  }

  try {
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    const hint = buildReviewActionHint(report.review?.items || []);
    if (hint) {
      appendLog(hint);
    }
  } catch {
    // The report hint is best-effort; keep the UI completion log quiet on read failures.
  }
}

function findLatestReviewReportPath(logLines) {
  for (let index = logLines.length - 1; index >= 0; index -= 1) {
    const match = logLines[index].match(/review report (.+?review-report-\d+\.json)/);
    if (match) {
      return match[1].trim();
    }
  }

  return "";
}

async function chooseWorkbookFile() {
  return chooseWorkbookFileWithDialog({ cwd: ROOT });
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
