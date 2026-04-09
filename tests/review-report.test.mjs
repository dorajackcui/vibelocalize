import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBatchRowCountFinding,
  buildRunSummary,
  countReviewFindingsByType,
  formatDuration,
  writeReviewReport
} from "../scripts/lib/review-report.mjs";

const config = {
  workbook: {
    filePath: "demo.xlsx",
    sheetName: "Sheet1"
  },
  workflow: {
    sourceColumn: "A",
    targetColumn: "B",
    batchSize: 2
  }
};

test("buildBatchRowCountFinding returns null when row counts match", () => {
  const finding = buildBatchRowCountFinding({
    config,
    startRow: 1,
    sourceValues: ["a", "b"],
    outputMatrix: [["x"], ["y"]]
  });

  assert.equal(finding, null);
});

test("countReviewFindingsByType aggregates by issue type", () => {
  const counts = countReviewFindingsByType([
    { issueType: "row_count_mismatch" },
    { issueType: "row_count_mismatch" },
    { issueType: "unknown_shape" }
  ]);

  assert.deepEqual(counts, {
    row_count_mismatch: 2,
    unknown_shape: 1
  });
});

test("buildRunSummary and formatDuration render compact output", () => {
  assert.equal(formatDuration(3661000), "1h 1m 1s");

  const summary = buildRunSummary({
    startRow: 1,
    lastCompletedRow: 2,
    sourceColumn: "A",
    targetColumn: "B",
    loops: 1,
    totalRuns: 4,
    elapsedMs: 3661000,
    stopReason: "completed",
    reviewFindings: [],
    reviewReportPath: "debug/report.json"
  });

  assert.match(summary, /rows translated A1 -> A2/);
  assert.match(summary, /review report debug\/report\.json/);
});

test("writeReviewReport writes expected JSON payload", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-report-"));
  const reviewFindings = [
    {
      recordedAt: "2026-01-01T00:00:00.000Z",
      issueType: "row_count_mismatch",
      sourceRange: "A1:A2",
      targetStartCell: "B1",
      expectedRowCount: 2,
      actualRowCount: 1,
      rowDelta: -1
    }
  ];

  const reportPath = await writeReviewReport({
    config,
    startRow: 1,
    lastCompletedRow: 2,
    loops: 1,
    totalRuns: 4,
    elapsedMs: 1234,
    stopReason: "completed",
    reviewFindings,
    debugDir: tempDir
  });

  const payload = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(payload.workbook.filePath, "demo.xlsx");
  assert.equal(payload.review.totalItems, 1);
  assert.deepEqual(payload.review.countsByType, { row_count_mismatch: 1 });
});
