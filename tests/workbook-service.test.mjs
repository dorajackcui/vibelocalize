import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectWorkbook } from "../scripts/lib/workbook-service.mjs";
import { getPythonCommand } from "../scripts/runtime-platform.mjs";

const execFileAsync = promisify(execFile);

async function createWorkbookFixture() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workbook-service-test-"));
  const workbookPath = path.join(tempDir, "fixture.xlsx");
  const python = await getPythonCommand();
  const script = `
from openpyxl import Workbook
from pathlib import Path
import sys

workbook_path = Path(sys.argv[1])
wb = Workbook()
ready = wb.active
ready.title = "Ready"
ready["B1"] = "source"
ready["C1"] = "target"
ready["B2"] = "done"
ready["C2"] = "done"
ready["B3"] = "pending"
ready["C3"] = ""

manual = wb.create_sheet("NeedsManual")
manual["A1"] = "source"
manual["B1"] = "target"
manual["A2"] = "done"
manual["B2"] = "translated"

wb.save(workbook_path)
wb.close()
`;

  await execFileAsync(python.command, [...python.args, "-c", script, workbookPath]);

  return {
    workbookPath,
    async cleanup() {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

test("inspectWorkbook returns auto-detected columns and start row for the selected sheet", async () => {
  const fixture = await createWorkbookFixture();

  try {
    const payload = await inspectWorkbook(fixture.workbookPath, "Ready");

    assert.deepEqual(payload.sheetAnalysis, {
      status: "auto_detected",
      message: "已自动识别 source=B，target=C，开始行=3。",
      sourceColumn: "B",
      targetColumn: "C",
      startRow: 3,
      sourceRowCount: 2,
      untranslatedRowCount: 1
    });
  } finally {
    await fixture.cleanup();
  }
});

test("inspectWorkbook surfaces manual-review state without overwriting detected values", async () => {
  const fixture = await createWorkbookFixture();

  try {
    const payload = await inspectWorkbook(fixture.workbookPath, "NeedsManual");

    assert.equal(payload.sheetAnalysis.status, "needs_manual_review");
    assert.equal(payload.sheetAnalysis.sourceColumn, null);
    assert.equal(payload.sheetAnalysis.targetColumn, null);
    assert.equal(payload.sheetAnalysis.startRow, null);
    assert.equal(payload.sheetAnalysis.sourceRowCount, 1);
    assert.equal(payload.sheetAnalysis.untranslatedRowCount, 0);
    assert.match(payload.sheetAnalysis.message, /未找到待处理行/);
  } finally {
    await fixture.cleanup();
  }
});
