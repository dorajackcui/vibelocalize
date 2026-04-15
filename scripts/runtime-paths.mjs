import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function getResourceRoot() {
  const explicitRoot = String(process.env.VIBELOCALIZE_RESOURCE_ROOT || "").trim();
  return explicitRoot ? path.resolve(explicitRoot) : PROJECT_ROOT;
}

export function getDataRoot() {
  const explicitRoot = String(process.env.VIBELOCALIZE_DATA_ROOT || "").trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const portableExecutableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  if (portableExecutableDir) {
    return path.join(path.resolve(portableExecutableDir), "data");
  }

  return getResourceRoot();
}

export function resolveDataPath(targetPath = "") {
  const normalizedPath = String(targetPath || "").trim();
  if (!normalizedPath || normalizedPath === ".") {
    return getDataRoot();
  }

  if (path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  return path.resolve(getDataRoot(), normalizedPath.replace(/^[.][\\/]/, ""));
}

export function getConfigPath() {
  return path.join(getDataRoot(), "automation.config.json");
}

export function getDebugDir() {
  return path.join(getDataRoot(), "debug");
}

export function getUiHtmlPath() {
  return path.join(getResourceRoot(), "ui", "index.html");
}

export function getWorkbookHelperPath() {
  const explicitPath = String(process.env.VIBELOCALIZE_WORKBOOK_HELPER_PATH || "").trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  return path.join(getResourceRoot(), "scripts", "workbook_helper.py");
}

export function getRuntimeEnvironmentInfo() {
  return {
    appMode: process.versions.electron ? "electron" : "node",
    resourceRoot: getResourceRoot(),
    dataRoot: getDataRoot(),
    usesPortableDataRoot: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    workbookHelperPath: getWorkbookHelperPath()
  };
}
