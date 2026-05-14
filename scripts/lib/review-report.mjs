import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
export const DEBUG_DIR = path.join(ROOT, "debug");

export function buildBatchRowCountFinding({ config, startRow, sourceValues, outputMatrix }) {
  const expectedRowCount = sourceValues.length;
  const actualRowCount = outputMatrix.length;

  if (actualRowCount === expectedRowCount) {
    return null;
  }

  const endRow = startRow + expectedRowCount - 1;
  return {
    recordedAt: new Date().toISOString(),
    issueType: "row_count_mismatch",
    sourceRange: `${config.workflow.sourceColumn}${startRow}:${config.workflow.sourceColumn}${endRow}`,
    targetStartCell: `${config.workflow.targetColumn}${startRow}`,
    expectedRowCount,
    actualRowCount,
    rowDelta: actualRowCount - expectedRowCount
  };
}

export async function writeReviewReport({
  config,
  startRow,
  lastCompletedRow,
  loops,
  totalRuns,
  elapsedMs,
  stopReason,
  reviewFindings,
  debugDir = DEBUG_DIR
}) {
  await fs.mkdir(debugDir, { recursive: true });
  const reportPath = path.join(debugDir, `review-report-${Date.now()}.json`);
  const reviewCountsByType = countReviewFindingsByType(reviewFindings);
  const reportPayload = {
    createdAt: new Date().toISOString(),
    workbook: {
      filePath: config.workbook.filePath,
      sheetName: config.workbook.sheetName
    },
    run: {
      sourceColumn: config.workflow.sourceColumn,
      targetColumn: config.workflow.targetColumn,
      startRow,
      lastCompletedRow,
      batchSize: config.workflow.batchSize,
      completedRounds: loops,
      totalRuns,
      elapsedMs,
      stopReason
    },
    review: {
      totalItems: reviewFindings.length,
      countsByType: reviewCountsByType,
      items: reviewFindings.map((finding) => ({
        at: finding.recordedAt,
        type: finding.issueType,
        sourceRange: finding.sourceRange,
        targetStartCell: finding.targetStartCell,
        expectedRows: finding.expectedRowCount,
        actualRows: finding.actualRowCount,
        rowDelta: finding.rowDelta
      }))
    }
  };

  await fs.writeFile(reportPath, `${JSON.stringify(reportPayload, null, 2)}\n`, "utf8");
  return reportPath;
}

export function countReviewFindingsByType(reviewFindings) {
  return reviewFindings.reduce((counts, finding) => {
    const issueType = finding.issueType || "unknown";
    counts[issueType] = (counts[issueType] || 0) + 1;
    return counts;
  }, {});
}

export function buildReviewActionHint(reviewItems) {
  const ranges = reviewItems
    .map((item) => item.sourceRange)
    .filter(Boolean)
    .map(formatReviewSourceRange);

  if (ranges.length === 0) {
    return "";
  }

  return `Review: ${ranges.join("、")}`;
}

export function buildRunSummary({
  startRow,
  lastCompletedRow,
  sourceColumn,
  targetColumn,
  loops,
  totalRuns,
  elapsedMs,
  stopReason,
  reviewFindings,
  reviewReportPath
}) {
  const rowSummary = lastCompletedRow >= startRow
    ? `${sourceColumn}${startRow} -> ${sourceColumn}${lastCompletedRow}`
    : `none completed from ${sourceColumn}${startRow}`;

  const parts = [
    "Run summary:",
    `rows translated ${rowSummary}`,
    `target column ${targetColumn}`,
    `completed rounds ${loops}/${totalRuns}`,
    `elapsed ${formatDuration(elapsedMs)}`,
    `stop reason ${stopReason}`,
    `review items ${reviewFindings.length}`
  ];

  if (reviewReportPath) {
    parts.push(`review report ${reviewReportPath}`);
  }

  return parts.join(" | ");
}

export function formatDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatReviewSourceRange(sourceRange) {
  const text = String(sourceRange);
  const match = text.match(/^[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/i);
  if (!match) {
    return text;
  }

  const startRow = Number(match[1]);
  const endRow = Number(match[2] || match[1]);
  return startRow === endRow ? `第 ${startRow} 行` : `第 ${startRow}-${endRow} 行`;
}
