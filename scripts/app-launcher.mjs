import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UI_URL = "http://127.0.0.1:4312";

async function main() {
  const child = spawn(process.execPath, ["scripts/ui-server.mjs"], {
    cwd: process.cwd(),
    stdio: "inherit"
  });

  const cleanup = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });

  const ready = await waitForUiServer(15000);
  if (ready) {
    await openUiInBrowser();
    console.log(`Opened ${UI_URL}`);
  } else {
    console.warn(`UI did not become ready within 15s. You can open ${UI_URL} manually.`);
  }
}

async function waitForUiServer(timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${UI_URL}/api/status`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server is still starting.
    }

    await sleep(500);
  }

  return false;
}

async function openUiInBrowser() {
  if (process.platform !== "darwin") {
    return;
  }

  await execFileAsync("open", [UI_URL]);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
