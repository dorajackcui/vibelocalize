import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getConfigPath,
  getDataRoot,
  getResourceRoot,
  getRuntimeEnvironmentInfo,
  getWorkbookHelperPath,
  resolveDataPath
} from "../scripts/runtime-paths.mjs";

const expectedResourceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("runtime paths default to the project root in plain Node mode", () => {
  withEnv({
    PORTABLE_EXECUTABLE_DIR: undefined,
    VIBELOCALIZE_DATA_ROOT: undefined,
    VIBELOCALIZE_RESOURCE_ROOT: undefined,
    VIBELOCALIZE_WORKBOOK_HELPER_PATH: undefined
  }, () => {
    assert.equal(getResourceRoot(), expectedResourceRoot);
    assert.equal(getDataRoot(), expectedResourceRoot);
    assert.equal(getConfigPath(), path.join(expectedResourceRoot, "automation.config.json"));
    assert.equal(resolveDataPath("./.chrome-profile"), path.join(expectedResourceRoot, ".chrome-profile"));
  });
});

test("runtime paths use a portable data directory when PORTABLE_EXECUTABLE_DIR is set", () => {
  withEnv({
    PORTABLE_EXECUTABLE_DIR: "C:\\Portable\\VibeLocalize",
    VIBELOCALIZE_DATA_ROOT: undefined
  }, () => {
    assert.equal(getDataRoot(), path.join("C:\\Portable\\VibeLocalize", "data"));
    assert.equal(
      resolveDataPath("./.chrome-profile"),
      path.join("C:\\Portable\\VibeLocalize", "data", ".chrome-profile")
    );
    assert.equal(getRuntimeEnvironmentInfo().usesPortableDataRoot, true);
  });
});

test("runtime paths respect explicit data and helper overrides", () => {
  withEnv({
    VIBELOCALIZE_DATA_ROOT: "D:\\AppData\\VibeLocalize",
    VIBELOCALIZE_WORKBOOK_HELPER_PATH: "D:\\bundle\\scripts\\workbook_helper.py"
  }, () => {
    assert.equal(getDataRoot(), "D:\\AppData\\VibeLocalize");
    assert.equal(getWorkbookHelperPath(), "D:\\bundle\\scripts\\workbook_helper.py");
  });
});

function withEnv(nextEnv, run) {
  const previous = new Map();

  for (const [key, value] of Object.entries(nextEnv)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
