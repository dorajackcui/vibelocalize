import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";
const WINDOWS_PYTHON_CANDIDATES = [
  { command: "py", args: ["-3"], displayName: "py -3" },
  { command: "py", args: [], displayName: "py" },
  { command: "python", args: [], displayName: "python" },
  { command: "python3", args: [], displayName: "python3" }
];
const DEFAULT_PYTHON_CANDIDATES = [
  { command: "python3", args: [], displayName: "python3" },
  { command: "python", args: [], displayName: "python" }
];

let pythonCommandPromise = null;

export async function openUrlInBrowser(targetUrl) {
  if (process.platform === "darwin") {
    await execFileAsync("open", [targetUrl]);
    return true;
  }

  if (process.platform === "win32") {
    await execFileAsync(
      WINDOWS_POWERSHELL,
      ["-NoProfile", "-Command", `Start-Process ${toPowerShellString(targetUrl)}`],
      { windowsHide: true }
    );
    return true;
  }

  return false;
}

export async function openFileInDefaultApp(targetPath) {
  if (process.platform === "darwin") {
    await execFileAsync("open", [targetPath]);
    return true;
  }

  if (process.platform === "win32") {
    await execFileAsync(
      WINDOWS_POWERSHELL,
      ["-NoProfile", "-Command", `Start-Process ${toPowerShellString(targetPath)}`],
      { windowsHide: true }
    );
    return true;
  }

  return false;
}

export async function chooseWorkbookFile({ cwd } = {}) {
  if (process.versions.electron) {
    const { dialog, BrowserWindow } = await import("electron");
    const parentWindow = BrowserWindow.getFocusedWindow();
    const options = {
      title: "Select workbook (.xlsx or .xlsm)",
      filters: [{ name: "Excel Workbooks", extensions: ["xlsx", "xlsm"] }],
      properties: ["openFile"],
      ...(cwd ? { defaultPath: path.resolve(cwd) } : {})
    };
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) {
      const error = new Error("File selection was cancelled.");
      error.code = "FILE_SELECTION_CANCELLED";
      throw error;
    }
    return normalizeWorkbookSelection(result.filePaths[0]);
  }

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", 'POSIX path of (choose file with prompt "Select workbook (.xlsx or .xlsm)")'],
        cwd ? { cwd } : undefined
      );
      return normalizeWorkbookSelection(stdout.trim());
    } catch (error) {
      if (String(error.message || "").includes("-128")) {
        const cancellationError = new Error("File selection was cancelled.");
        cancellationError.code = "FILE_SELECTION_CANCELLED";
        throw cancellationError;
      }

      throw error;
    }
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "[System.Windows.Forms.Application]::EnableVisualStyles()",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$owner.ShowInTaskbar = $false",
      "$owner.StartPosition = 'CenterScreen'",
      "$owner.WindowState = 'Minimized'",
      "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
      "$dialog.Title = 'Select workbook (.xlsx or .xlsm)'",
      "$dialog.Filter = 'Excel Workbooks (*.xlsx;*.xlsm)|*.xlsx;*.xlsm'",
      "$dialog.FilterIndex = 1",
      "$dialog.Multiselect = $false",
      "$dialog.CheckFileExists = $true",
      "$dialog.CheckPathExists = $true",
      "$dialog.RestoreDirectory = $true",
      cwd ? `$dialog.InitialDirectory = ${toPowerShellString(path.resolve(cwd))}` : "",
      "$null = $owner.Show()",
      "$owner.Activate()",
      "$result = $dialog.ShowDialog($owner)",
      "$owner.Close()",
      "$owner.Dispose()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  Write-Output $dialog.FileName",
      "}"
    ]
      .filter(Boolean)
      .join("; ");

    const { stdout } = await execFileAsync(
      WINDOWS_POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-Command", script],
      { cwd, windowsHide: true, encoding: "utf8" }
    );
    return normalizeWorkbookSelection(stdout.trim());
  }

  const error = new Error("Workbook file selection dialog is only implemented for macOS and Windows.");
  error.code = "FILE_SELECTION_UNSUPPORTED";
  throw error;
}

export async function getPythonCommand() {
  pythonCommandPromise ??= detectPythonCommand();
  return pythonCommandPromise;
}

export async function inspectExternalDependencies() {
  const [python, chrome] = await Promise.all([
    inspectPythonDependency(),
    inspectChromeDependency()
  ]);

  return { python, chrome };
}

export async function launchChromeWithDebugPort({ debugPort, userDataDir }) {
  const chromeArgs = buildChromeDebuggingArgs({ debugPort, userDataDir });
  const manualCommand = buildManualChromeDebuggingCommand({ debugPort, userDataDir });

  if (process.platform === "darwin") {
    await execFileAsync("open", ["-na", "Google Chrome", "--args", ...chromeArgs]);

    return {
      browserName: "Google Chrome",
      manualCommand
    };
  }

  if (process.platform === "win32") {
    const { chromePath, searchedPaths } = await findWindowsChromeExecutable();
    const resolvedManualCommand = buildManualChromeDebuggingCommand({ debugPort, userDataDir, chromePath });
    if (!chromePath) {
      const error = new Error(
        [
          "Could not find Google Chrome in the standard Windows install locations.",
          `Checked: ${searchedPaths.join(", ") || "none"}.`,
          `Start Chrome manually with: ${manualCommand}`
        ].join(" ")
      );
      error.code = "CHROME_NOT_FOUND";
      error.searchedPaths = searchedPaths;
      error.manualCommand = manualCommand;
      throw error;
    }

    await spawnDetachedProcess(chromePath, chromeArgs);

    return {
      browserName: chromePath,
      manualCommand: resolvedManualCommand,
      searchedPaths
    };
  }

  const error = new Error(
    [
      `Could not reach Chrome remote debugging at http://127.0.0.1:${debugPort}.`,
      "Auto-launch is only implemented for macOS and Windows right now.",
      `Start Chrome manually with: ${manualCommand}`
    ].join(" ")
  );
  error.code = "CHROME_AUTO_LAUNCH_UNSUPPORTED";
  error.manualCommand = manualCommand;
  throw error;
}

export function buildManualChromeDebuggingCommand({ debugPort, userDataDir, chromePath }) {
  const executablePath = chromePath || "C:\\Path\\To\\chrome.exe";
  const chromeArgs = buildChromeDebuggingArgs({ debugPort, userDataDir });

  if (process.platform === "win32") {
    return [`"${executablePath}"`, ...chromeArgs.map((item) => quoteIfNeeded(item))].join(" ");
  }

  return ['open -na "Google Chrome" --args', ...chromeArgs.map((item) => quoteIfNeeded(item))].join(" ");
}

async function detectPythonCommand() {
  const candidates = process.platform === "win32" ? WINDOWS_PYTHON_CANDIDATES : DEFAULT_PYTHON_CANDIDATES;
  const attemptedCommands = [];

  for (const candidate of candidates) {
    attemptedCommands.push(candidate.displayName);
    try {
      await execFileAsync(candidate.command, [...candidate.args, "--version"], {
        windowsHide: true
      });
      return candidate;
    } catch {
      // Try the next Python command candidate.
    }
  }

  const error = new Error(
    [
      "Could not find a usable Python 3 runtime.",
      `Tried: ${attemptedCommands.join(", ")}.`,
      "Install Python 3 and make one of those commands available, then retry."
    ].join(" ")
  );
  error.code = "PYTHON_NOT_FOUND";
  error.attemptedCommands = attemptedCommands;
  throw error;
}

async function inspectPythonDependency() {
  try {
    const pythonCommand = await getPythonCommand();
    return {
      ok: true,
      command: pythonCommand.displayName
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.code || "PYTHON_NOT_FOUND",
      detail: error.message
    };
  }
}

async function inspectChromeDependency() {
  if (process.platform === "darwin") {
    return {
      ok: true,
      detail: "Google Chrome is required when running in attach mode."
    };
  }

  if (process.platform !== "win32") {
    return {
      ok: false,
      reason: "UNSUPPORTED_PLATFORM",
      detail: "Automatic Chrome detection is only implemented for Windows and macOS."
    };
  }

  const { chromePath, searchedPaths } = await findWindowsChromeExecutable();
  if (chromePath) {
    return {
      ok: true,
      path: chromePath
    };
  }

  return {
    ok: false,
    reason: "CHROME_NOT_FOUND",
    detail: "Could not find Google Chrome in the standard Windows install locations.",
    searchedPaths
  };
}

async function findWindowsChromeExecutable() {
  const candidatePaths = uniquePaths([
    buildChromePath(process.env.LOCALAPPDATA),
    buildChromePath(process.env.PROGRAMFILES),
    buildChromePath(process.env["PROGRAMFILES(X86)"]),
    buildChromePath(process.env.ProgramW6432)
  ]);

  for (const candidatePath of candidatePaths) {
    if (!candidatePath) {
      continue;
    }

    try {
      await fs.access(candidatePath);
      return {
        chromePath: candidatePath,
        searchedPaths: candidatePaths
      };
    } catch {
      // Continue searching.
    }
  }

  return {
    chromePath: "",
    searchedPaths: candidatePaths
  };
}

function buildChromePath(baseDir) {
  if (!baseDir) {
    return "";
  }

  return path.join(baseDir, "Google", "Chrome", "Application", "chrome.exe");
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function normalizeWorkbookSelection(filePath) {
  if (!filePath) {
    const error = new Error("File selection was cancelled.");
    error.code = "FILE_SELECTION_CANCELLED";
    throw error;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (![".xlsx", ".xlsm"].includes(ext)) {
    const error = new Error("Please choose an .xlsx or .xlsm workbook.");
    error.code = "INVALID_WORKBOOK_SELECTION";
    throw error;
  }

  return filePath;
}

function buildChromeDebuggingArgs({ debugPort, userDataDir }) {
  return [
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
}

function toPowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIfNeeded(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function spawnDetachedProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
