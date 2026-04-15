import fs from "node:fs/promises";
import http from "node:http";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  chooseWorkbookFile as chooseWorkbookFileWithDialog,
  inspectExternalDependencies,
  openFileInDefaultApp
} from "./runtime-platform.mjs";
import {
  getResourceRoot,
  getRuntimeEnvironmentInfo,
  getUiHtmlPath
} from "./runtime-paths.mjs";
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
  getWorkbookWriteCheck,
  inspectWorkbook
} from "./lib/workbook-service.mjs";
import { createJobRunnerController } from "./lib/job-runner-controller.mjs";
import { createBootstrapController } from "./lib/bootstrap-controller.mjs";

const DEFAULT_PORT = 4312;
const DEFAULT_HOST = "127.0.0.1";

export function createUiServer(options = {}) {
  const {
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    uiPath = getUiHtmlPath(),
    chooseWorkbookFile = () => chooseWorkbookFileWithDialog({ cwd: getResourceRoot() }),
    openFileInDefaultAppFn = openFileInDefaultApp,
    loadConfigFn = loadOrCreateConfig,
    saveConfigFn = saveConfig,
    mergeConfigFn = mergeConfig,
    normalizeConfigFn = normalizeConfig,
    inspectWorkbookFn = inspectWorkbook,
    getWorkbookWriteCheckFn = getWorkbookWriteCheck,
    formatWorkbookWriteIssueFn = formatWorkbookWriteIssue,
    inspectEnvironmentFn = buildEnvironmentInfo,
    runnerController = createJobRunnerController(),
    bootstrapController = createBootstrapController()
  } = options;

  let server = null;
  let activePort = port;
  let environmentPromise = null;

  const getEnvironment = async () => {
    environmentPromise ??= inspectEnvironmentFn();
    return environmentPromise;
  };

  const buildConfigPayload = async (configOverride) => {
    const config = configOverride ?? (await loadConfigFn());
    const workbookInspection = config.workbook.filePath
      ? await inspectWorkbookFn(config.workbook.filePath, config.workbook.sheetName)
      : null;
    const workbookInfo = workbookInspection
      ? {
          sheetNames: workbookInspection.sheetNames,
          activeSheetName: workbookInspection.activeSheetName
        }
      : null;
    const bootstrap = {
      ...bootstrapController.getSnapshot(),
      completed: !isBootstrapMissing(config),
      instructions: getBootstrapInstructions(),
      lastCapturedProjectUrl: config.chatgpt.projectUrl || ""
    };
    const runnerStatus = runnerController.getSnapshot();
    const status = {
      ...runnerStatus,
      missingBootstrap: isBootstrapMissing(config),
      missingWorkbook: !config.workbook.filePath,
      bootstrapInProgress: bootstrap.inProgress
    };

    return {
      config,
      status,
      bootstrap,
      environment: await getEnvironment(),
      derived: buildDerivedInfo(config),
      workbookInfo,
      sheetAnalysis: workbookInspection?.sheetAnalysis ?? null,
      writeCheck: config.workbook.filePath ? await getWorkbookWriteCheckFn(config.workbook.filePath) : null
    };
  };

  const handleRequest = async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/") {
        return respondHtml(res, await fs.readFile(uiPath, "utf8"));
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        return respondJson(res, 200, await buildConfigPayload());
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readJsonBody(req);
        const existing = await loadConfigFn();
        const nextConfig = normalizeConfigFn(
          mergeConfigFn(existing, {
            workbook: body.workbook,
            workflow: body.workflow
          })
        );

        await saveConfigFn(nextConfig);
        return respondJson(res, 200, await buildConfigPayload(nextConfig));
      }

      if (req.method === "POST" && url.pathname === "/api/bootstrap/config") {
        const body = await readJsonBody(req);
        const existing = await loadConfigFn();
        const nextConfig = normalizeConfigFn(
          mergeConfigFn(existing, {
            browser: {
              mode: body.browser?.mode,
              debugPort: body.browser?.debugPort
            }
          })
        );

        await saveConfigFn(nextConfig);
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

        const existing = await loadConfigFn();
        const workbookInfo = await inspectWorkbookFn(filePath);
        const nextConfig = normalizeConfigFn(
          mergeConfigFn(existing, {
            workbook: {
              filePath,
              sheetName: workbookInfo.activeSheetName
            }
          })
        );

        await saveConfigFn(nextConfig);
        return respondJson(res, 200, await buildConfigPayload(nextConfig));
      }

      if (req.method === "POST" && url.pathname === "/api/workbook/inspect") {
        const body = await readJsonBody(req);
        if (!body.filePath) {
          return respondJson(res, 400, { error: "Workbook file path is required." });
        }

        return respondJson(res, 200, await inspectWorkbookFn(body.filePath, body.sheetName || ""));
      }

      if (req.method === "POST" && url.pathname === "/api/open-workbook") {
        const body = await readJsonBody(req);
        const filePath = String(body.filePath || "").trim();

        if (!filePath) {
          return respondJson(res, 400, { error: "Workbook file path is required." });
        }

        await fs.access(filePath);
        const opened = await openFileInDefaultAppFn(filePath);
        if (!opened) {
          return respondJson(res, 400, {
            error: "Opening workbook files is only implemented for macOS and Windows."
          });
        }

        return respondJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/bootstrap/start") {
        const config = await loadConfigFn();
        await bootstrapController.start(config);
        return respondJson(res, 200, await buildConfigPayload(config));
      }

      if (req.method === "POST" && url.pathname === "/api/bootstrap/complete") {
        const config = await loadConfigFn();
        const result = await bootstrapController.complete(config);
        const nextConfig = normalizeConfigFn(result.updatedConfig ?? config);
        await saveConfigFn(nextConfig);
        return respondJson(res, 200, await buildConfigPayload(nextConfig));
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        if (runnerController.getSnapshot().running) {
          return respondJson(res, 409, { error: "A job is already running." });
        }

        if (bootstrapController.getSnapshot().inProgress) {
          return respondJson(res, 409, {
            error: "Bootstrap is still in progress. Complete it before starting a job."
          });
        }

        const config = await loadConfigFn();
        if (isBootstrapMissing(config)) {
          return respondJson(res, 400, {
            error: "Bootstrap is incomplete. Use the in-app bootstrap flow first."
          });
        }

        if (!config.workbook.filePath) {
          return respondJson(res, 400, {
            error: "No workbook selected yet. Choose a file first."
          });
        }

        const writeCheck = await getWorkbookWriteCheckFn(config.workbook.filePath);
        if (!writeCheck.ok) {
          return respondJson(res, 400, {
            error: formatWorkbookWriteIssueFn(writeCheck, config.workbook.filePath)
          });
        }

        await runnerController.start(config);
        return respondJson(res, 200, await buildConfigPayload(config));
      }

      if (req.method === "POST" && url.pathname === "/api/stop") {
        await runnerController.stop();
        return respondJson(res, 200, await buildConfigPayload());
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const payload = await buildConfigPayload();
        return respondJson(res, 200, {
          status: payload.status,
          bootstrap: payload.bootstrap,
          environment: payload.environment,
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
  };

  return {
    async start() {
      if (server?.listening) {
        return this;
      }

      server = http.createServer((req, res) => {
        handleRequest(req, res);
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          activePort = typeof address === "object" && address ? address.port : port;
          server.off("error", reject);
          resolve();
        });
      });

      return this;
    },

    async close() {
      await Promise.allSettled([
        runnerController.close?.(),
        bootstrapController.close?.()
      ]);

      if (!server) {
        return;
      }

      const currentServer = server;
      server = null;
      await new Promise((resolve, reject) => {
        currentServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },

    getPort() {
      return activePort;
    },

    getUrl() {
      return `http://${host}:${activePort}`;
    }
  };
}

export async function startUiServer(options = {}) {
  const server = createUiServer(options);
  await server.start();
  return server;
}

async function buildEnvironmentInfo() {
  return {
    ...getRuntimeEnvironmentInfo(),
    dependencies: await inspectExternalDependencies()
  };
}

function getBootstrapInstructions() {
  return [
    "点击“启动绑定”后，应用会尝试连接或拉起可调试的 Chrome。",
    "在打开的 Chrome 里登录 ChatGPT，并完成任何人机验证。",
    "打开目标 project 页面，或者该 project 内的任意对话。",
    "回到应用点击“完成绑定”，保存 projectUrl。"
  ];
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

async function main() {
  const uiServer = await startUiServer();
  console.log(`UI ready at ${uiServer.getUrl()}`);

  const cleanup = async () => {
    await uiServer.close().catch(() => null);
    process.exit(0);
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
