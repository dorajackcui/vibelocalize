import test from "node:test";
import assert from "node:assert/strict";
import { createUiServer } from "../scripts/ui-server.mjs";
import { normalizeConfig } from "../scripts/lib/automation-config.mjs";

test("ui server exposes bootstrap state and completes bootstrap through the API", async () => {
  const state = createConfigState(normalizeConfig({}));
  const bootstrapController = createMockBootstrapController();
  const server = createUiServer({
    port: 0,
    loadConfigFn: state.load,
    saveConfigFn: state.save,
    inspectWorkbookFn: async () => ({
      sheetNames: ["Sheet1"],
      activeSheetName: "Sheet1",
      sheetAnalysis: null
    }),
    getWorkbookWriteCheckFn: async () => ({ ok: true, code: "OK" }),
    inspectEnvironmentFn: async () => ({
      appMode: "node",
      dataRoot: "D:\\data",
      usesPortableDataRoot: false,
      dependencies: {
        python: { ok: true, command: "python3" },
        chrome: { ok: true, path: "C:\\Chrome\\chrome.exe" }
      }
    }),
    bootstrapController
  });

  await server.start();

  try {
    const initialPayload = await fetchJson(`${server.getUrl()}/api/config`);
    assert.equal(initialPayload.status.missingBootstrap, true);
    assert.equal(initialPayload.bootstrap.inProgress, false);
    assert.equal(initialPayload.bootstrap.completed, false);
    assert.equal(initialPayload.bootstrap.lastCapturedProjectUrl, "");

    const startedPayload = await fetchJson(`${server.getUrl()}/api/bootstrap/start`, {
      method: "POST"
    });
    assert.equal(startedPayload.bootstrap.inProgress, true);

    const completedPayload = await fetchJson(`${server.getUrl()}/api/bootstrap/complete`, {
      method: "POST"
    });
    assert.equal(completedPayload.status.missingBootstrap, false);
    assert.equal(completedPayload.bootstrap.completed, true);
    assert.equal(
      completedPayload.bootstrap.lastCapturedProjectUrl,
      "https://chatgpt.com/g/project-id/project"
    );
    assert.equal(completedPayload.config.chatgpt.projectUrl, "https://chatgpt.com/g/project-id/project");
  } finally {
    await server.close();
  }
});

test("ui server saves bootstrap-only config changes without touching workbook or workflow settings", async () => {
  const state = createConfigState(normalizeConfig({
    workbook: {
      filePath: "D:\\original.xlsx",
      sheetName: "Sheet1"
    },
    workflow: {
      batchSize: 24,
      sourceColumn: "C",
      targetColumn: "D",
      startRow: 7
    }
  }));
  const server = createUiServer({
    port: 0,
    loadConfigFn: state.load,
    saveConfigFn: state.save,
    inspectWorkbookFn: async () => ({
      sheetNames: ["Sheet1"],
      activeSheetName: "Sheet1",
      sheetAnalysis: null
    }),
    getWorkbookWriteCheckFn: async () => ({ ok: true, code: "OK" }),
    inspectEnvironmentFn: async () => ({
      appMode: "node",
      dataRoot: "D:\\data",
      usesPortableDataRoot: false,
      dependencies: {
        python: { ok: true, command: "python3" },
        chrome: { ok: true, path: "C:\\Chrome\\chrome.exe" }
      }
    }),
    bootstrapController: createMockBootstrapController()
  });

  await server.start();

  try {
    const updatedPayload = await fetchJson(`${server.getUrl()}/api/bootstrap/config`, {
      method: "POST",
      body: JSON.stringify({
        browser: {
          mode: "launch",
          debugPort: 9333
        },
        workbook: {
          filePath: "D:\\ignored.xlsx"
        },
        workflow: {
          batchSize: 999
        }
      })
    });

    assert.equal(updatedPayload.config.browser.mode, "launch");
    assert.equal(updatedPayload.config.browser.debugPort, 9333);
    assert.equal(updatedPayload.config.workbook.filePath, "D:\\original.xlsx");
    assert.equal(updatedPayload.config.workbook.sheetName, "Sheet1");
    assert.equal(updatedPayload.config.workflow.batchSize, 24);
    assert.equal(updatedPayload.config.workflow.sourceColumn, "C");
    assert.equal(updatedPayload.config.workflow.targetColumn, "D");
    assert.equal(updatedPayload.config.workflow.startRow, 7);
  } finally {
    await server.close();
  }
});

test("ui server persists config updates and delegates run/stop to the runner controller", async () => {
  const state = createConfigState(normalizeConfig({
    chatgpt: {
      projectUrl: "https://chatgpt.com/g/project-id/project"
    },
    workbook: {
      filePath: "D:\\workbook.xlsx",
      sheetName: "Sheet1"
    }
  }));
  const runnerController = createMockRunnerController();
  const server = createUiServer({
    port: 0,
    loadConfigFn: state.load,
    saveConfigFn: state.save,
    inspectWorkbookFn: async () => ({
      sheetNames: ["Sheet1"],
      activeSheetName: "Sheet1",
      sheetAnalysis: {
        status: "auto_detected",
        sourceColumn: "B",
        targetColumn: "C",
        startRow: 3,
        sourceRowCount: 10,
        untranslatedRowCount: 4
      }
    }),
    getWorkbookWriteCheckFn: async () => ({ ok: true, code: "OK" }),
    inspectEnvironmentFn: async () => ({
      appMode: "node",
      dataRoot: "D:\\data",
      usesPortableDataRoot: false,
      dependencies: {
        python: { ok: true, command: "python3" },
        chrome: { ok: true, path: "C:\\Chrome\\chrome.exe" }
      }
    }),
    runnerController,
    bootstrapController: createMockBootstrapController({ initiallyBound: true })
  });

  await server.start();

  try {
    const savedPayload = await fetchJson(`${server.getUrl()}/api/config`, {
      method: "POST",
      body: JSON.stringify({
        workbook: {
          filePath: "D:\\updated.xlsx",
          sheetName: "Sheet2"
        },
        workflow: {
          batchSize: 12,
          sourceColumn: "d",
          targetColumn: "e",
          startRow: 5
        }
      })
    });
    assert.equal(savedPayload.config.workbook.filePath, "D:\\updated.xlsx");
    assert.equal(savedPayload.config.workflow.batchSize, 12);
    assert.equal(savedPayload.config.workflow.sourceColumn, "D");
    assert.equal(savedPayload.config.workflow.targetColumn, "E");

    const runPayload = await fetchJson(`${server.getUrl()}/api/run`, {
      method: "POST"
    });
    assert.equal(runPayload.status.running, true);
    assert.match(runPayload.status.logLines.join("\n"), /Mock run started/);

    const stopPayload = await fetchJson(`${server.getUrl()}/api/stop`, {
      method: "POST"
    });
    assert.equal(stopPayload.status.running, false);
  } finally {
    await server.close();
  }
});

function createConfigState(initialConfig) {
  let currentConfig = structuredClone(initialConfig);

  return {
    async load() {
      return structuredClone(currentConfig);
    },
    async save(config) {
      currentConfig = structuredClone(config);
    }
  };
}

function createMockBootstrapController({ initiallyBound = false } = {}) {
  const state = {
    inProgress: false,
    lastError: "",
    startedAt: ""
  };

  return {
    async start() {
      state.inProgress = true;
      state.startedAt = "2026-01-01T00:00:00.000Z";
      return this.getSnapshot();
    },
    async complete(config) {
      state.inProgress = false;
      state.startedAt = "";
      return {
        updatedConfig: normalizeConfig({
          ...config,
          chatgpt: {
            ...config.chatgpt,
            targetUrl: "https://chatgpt.com/g/project-id/project",
            projectUrl: "https://chatgpt.com/g/project-id/project"
          }
        })
      };
    },
    async close() {
      state.inProgress = false;
      state.startedAt = "";
    },
    getSnapshot() {
      return {
        ...state,
        inProgress: initiallyBound ? false : state.inProgress
      };
    }
  };
}

function createMockRunnerController() {
  const status = {
    running: false,
    pid: null,
    lastExitCode: null,
    logLines: []
  };

  return {
    async start() {
      status.running = true;
      status.logLines = ["[00:00:00] Mock run started"];
      return this.getSnapshot();
    },
    async stop() {
      status.running = false;
      status.lastExitCode = 0;
      status.logLines.push("[00:00:01] Mock run stopped");
      return { ok: true };
    },
    async close() {
      status.running = false;
    },
    getSnapshot() {
      return {
        ...status,
        logLines: [...status.logLines]
      };
    }
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}
