import { runConfiguredLoop } from "../chatgpt-wps-loop.mjs";

export function createJobRunnerController({
  runConfiguredLoopFn = runConfiguredLoop
} = {}) {
  const status = {
    running: false,
    pid: null,
    lastExitCode: null,
    logLines: []
  };

  let activeRun = null;

  return {
    async start(config, options = {}) {
      if (activeRun) {
        throw new Error("A job is already running.");
      }

      status.running = true;
      status.pid = null;
      status.lastExitCode = null;
      appendLog(status, `Starting job at ${new Date().toLocaleString()}`);

      const stopState = {
        requested: false
      };

      activeRun = {
        stopState,
        browserSession: null,
        promise: null
      };

      activeRun.promise = (async () => {
        try {
          await runConfiguredLoopFn({
            config,
            startRow: options.startRow,
            maxLoopsOverride: options.maxLoopsOverride,
            logger: (message) => appendLog(status, message),
            shouldStopFn: () => stopState.requested
          }, {
            onBrowserSessionCreated(browserSession) {
              if (activeRun) {
                activeRun.browserSession = browserSession;
              }
            }
          });
          status.lastExitCode = 0;
        } catch (error) {
          if (stopState.requested) {
            appendLog(status, "Job stopped by user.");
            status.lastExitCode = 0;
          } else {
            appendLog(status, error.stack || error.message);
            status.lastExitCode = 1;
          }
        } finally {
          status.running = false;
          appendLog(status, `Job finished with exit code ${status.lastExitCode ?? 1}`);
          activeRun = null;
        }
      })();

      activeRun.promise.catch(() => {});
      return this.getSnapshot();
    },

    async stop() {
      if (!activeRun) {
        return {
          ok: true,
          message: "No running job."
        };
      }

      activeRun.stopState.requested = true;
      appendLog(status, "Stop requested. Cleaning up the current run...");
      await activeRun.browserSession?.close?.().catch(() => null);
      return { ok: true };
    },

    async close() {
      if (!activeRun) {
        return;
      }

      await this.stop();
      await activeRun.promise.catch(() => null);
    },

    getSnapshot() {
      return {
        ...status,
        logLines: [...status.logLines]
      };
    }
  };
}

function appendLog(status, text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    status.logLines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  status.logLines = status.logLines.slice(-300);
}
