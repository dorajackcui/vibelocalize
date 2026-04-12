import importlib.util
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "workbook_helper.py"
MODULE_SPEC = importlib.util.spec_from_file_location("workbook_helper", MODULE_PATH)
workbook_helper = importlib.util.module_from_spec(MODULE_SPEC)
assert MODULE_SPEC.loader is not None
MODULE_SPEC.loader.exec_module(workbook_helper)


class WorkbookInspectTests(unittest.TestCase):
    def inspect_payload(self, workbook_path: Path, sheet_name: str = "") -> dict:
        return workbook_helper.inspect_workbook({
            "filePath": str(workbook_path),
            "sheetName": sheet_name,
        })

    def create_workbook(self, builder) -> Path:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        workbook_path = Path(temp_dir.name) / "demo.xlsx"

        workbook = Workbook()
        builder(workbook)
        workbook.save(workbook_path)
        workbook.close()
        return workbook_path

    def test_inspect_workbook_detects_columns_and_first_untranslated_row(self) -> None:
        def build(workbook: Workbook) -> None:
            sheet = workbook.active
            sheet.title = "Sheet1"
            sheet["C1"] = " source "
            sheet["D1"] = "TARGET"

            for row in range(2, 33):
                sheet[f"C{row}"] = f"source-{row}"
                if row <= 31:
                    sheet[f"D{row}"] = f"target-{row}"

        payload = self.inspect_payload(self.create_workbook(build))

        self.assertEqual(payload["sheetAnalysis"], {
            "status": "auto_detected",
            "message": "已自动识别 source=C，target=D，开始行=32。",
            "sourceColumn": "C",
            "targetColumn": "D",
            "startRow": 32,
            "sourceRowCount": 31,
            "untranslatedRowCount": 1,
        })

    def test_inspect_workbook_skips_rows_without_source_content(self) -> None:
        def build(workbook: Workbook) -> None:
            sheet = workbook.active
            sheet["A1"] = "source"
            sheet["B1"] = "target"
            sheet["A2"] = "done"
            sheet["B2"] = "已完成"
            sheet["A3"] = ""
            sheet["B3"] = ""
            sheet["A4"] = "pending"
            sheet["B4"] = ""

        payload = self.inspect_payload(self.create_workbook(build))

        self.assertEqual(payload["sheetAnalysis"]["startRow"], 4)

    def test_inspect_workbook_requires_unique_headers(self) -> None:
        def build(workbook: Workbook) -> None:
            sheet = workbook.active
            sheet["A1"] = "source"
            sheet["B1"] = "source"
            sheet["C1"] = "target"
            sheet["A2"] = "pending"

        payload = self.inspect_payload(self.create_workbook(build))

        self.assertEqual(payload["sheetAnalysis"]["status"], "needs_manual_review")
        self.assertIn("多个 source 表头", payload["sheetAnalysis"]["message"])
        self.assertIsNone(payload["sheetAnalysis"]["sourceColumn"])
        self.assertIsNone(payload["sheetAnalysis"]["targetColumn"])
        self.assertIsNone(payload["sheetAnalysis"]["startRow"])
        self.assertIsNone(payload["sheetAnalysis"]["sourceRowCount"])
        self.assertIsNone(payload["sheetAnalysis"]["untranslatedRowCount"])

    def test_inspect_workbook_requires_pending_row(self) -> None:
        def build(workbook: Workbook) -> None:
            sheet = workbook.active
            sheet["A1"] = "source"
            sheet["B1"] = "target"
            sheet["A2"] = "done"
            sheet["B2"] = "translated"

        payload = self.inspect_payload(self.create_workbook(build))

        self.assertEqual(payload["sheetAnalysis"]["status"], "needs_manual_review")
        self.assertIn("未找到待处理行", payload["sheetAnalysis"]["message"])
        self.assertEqual(payload["sheetAnalysis"]["sourceRowCount"], 1)
        self.assertEqual(payload["sheetAnalysis"]["untranslatedRowCount"], 0)


if __name__ == "__main__":
    unittest.main()
