import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const UI_PORT = 4312;
const portableExecutableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();

if (portableExecutableDir) {
  app.setPath("userData", path.join(path.resolve(portableExecutableDir), "data"));
}

let mainWindow = null;
let uiServer = null;

app.whenReady().then(async () => {
  process.env.VIBELOCALIZE_DATA_ROOT = app.getPath("userData");
  process.env.VIBELOCALIZE_WORKBOOK_HELPER_PATH = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "scripts", "workbook_helper.py")
    : path.join(ROOT, "scripts", "workbook_helper.py");

  const { startUiServer } = await import("../scripts/ui-server.mjs");
  uiServer = await startUiServer({ port: UI_PORT });
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(handleFatalError);
    }
  });
}).catch(handleFatalError);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  uiServer?.close?.().catch(() => null);
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 940,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4efe6",
    webPreferences: {
      preload: path.join(ROOT, "electron", "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`http://127.0.0.1:${UI_PORT}`);
}

function handleFatalError(error) {
  console.error(error.stack || error.message);
  app.exit(1);
}
