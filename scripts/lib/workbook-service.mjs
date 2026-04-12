import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { getPythonCommand } from "../runtime-platform.mjs";

const ROOT = process.cwd();
const WORKBOOK_HELPER = path.join(ROOT, "scripts", "workbook_helper.py");

export async function getWorkbookInfo(filePath) {
  return runWorkbookHelper("info", { filePath });
}

export async function inspectWorkbook(filePath, sheetName = "") {
  return runWorkbookHelper("inspect", { filePath, sheetName });
}

export async function getWorkbookWriteCheck(filePath) {
  return runWorkbookHelper("write-check", { filePath });
}

export async function readWorkbookBatch(config, startRow, batchSize) {
  const payload = await runWorkbookHelper("read-batch", {
    filePath: config.workbook.filePath,
    sheetName: config.workbook.sheetName,
    column: config.workflow.sourceColumn,
    startRow,
    batchSize
  });

  return payload.values.map((item) => String(item ?? ""));
}

export async function writeWorkbookBatch(config, startRow, matrix) {
  await runWorkbookHelper("write-batch", {
    filePath: config.workbook.filePath,
    sheetName: config.workbook.sheetName,
    column: config.workflow.targetColumn,
    startRow,
    matrix
  });
}

export async function runWorkbookHelper(command, payload) {
  const pythonCommand = await getPythonCommand();
  const stdout = await runCommandWithInput(
    pythonCommand.command,
    [...pythonCommand.args, WORKBOOK_HELPER, command],
    JSON.stringify(payload),
    pythonCommand.displayName
  );
  return JSON.parse(stdout);
}

export function formatWorkbookWriteIssue(writeCheck, filePath) {
  switch (writeCheck.code) {
    case "READ_ONLY_ATTRIBUTE":
      return `The selected workbook is marked read-only: ${filePath}. Remove the file's read-only attribute, then try again.`;
    case "LOCKED_FOR_UPDATE":
      return `The selected workbook is currently locked for writing: ${filePath}. Close the read-only/open copy in Excel or WPS, then try again.`;
    case "NO_WRITE_ACCESS":
      return `The selected workbook is not writable: ${filePath}. Check the file permissions, then try again.`;
    case "NO_DIRECTORY_WRITE_ACCESS":
      return `The workbook folder is not writable: ${filePath}. The app needs to create a temporary file in the same folder before replacing the workbook.`;
    default:
      if (writeCheck.detail) {
        return `Workbook write check failed for ${filePath}: ${writeCheck.detail}`;
      }
      return `Workbook write check failed for ${filePath}.`;
  }
}

export async function runCommandWithInput(command, args, inputText, commandDisplay = command) {
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

      reject(new Error(`${commandDisplay} exited with code ${code}: ${stderr.trim()}`));
    });

    child.stdin.write(inputText);
    child.stdin.end();
  });
}
