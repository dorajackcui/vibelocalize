import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "workbook_helper.py"
MODULE_SPEC = importlib.util.spec_from_file_location("workbook_helper", MODULE_PATH)
workbook_helper = importlib.util.module_from_spec(MODULE_SPEC)
assert MODULE_SPEC.loader is not None
MODULE_SPEC.loader.exec_module(workbook_helper)


class PersistWorkbookUpdateTests(unittest.TestCase):
    def test_falls_back_to_in_place_overwrite_when_replace_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir) / "temp.xlsx"
            target_path = Path(temp_dir) / "target.xlsx"
            temp_path.write_bytes(b"new")
            target_path.write_bytes(b"old")

            with (
                patch.object(workbook_helper, "replace_with_retry", side_effect=PermissionError("locked")) as replace_mock,
                patch.object(workbook_helper, "overwrite_in_place_with_retry") as overwrite_mock,
            ):
                result = workbook_helper.persist_workbook_update(temp_path, target_path)

            self.assertEqual(result, "in-place-overwrite")
            replace_mock.assert_called_once_with(temp_path, target_path)
            overwrite_mock.assert_called_once_with(temp_path, target_path)

    def test_copy_file_contents_overwrites_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "source.xlsx"
            target_path = Path(temp_dir) / "target.xlsx"
            source_path.write_bytes(b"updated workbook bytes")
            target_path.write_bytes(b"stale workbook bytes")

            workbook_helper.copy_file_contents(source_path, target_path)

            self.assertEqual(target_path.read_bytes(), b"updated workbook bytes")


if __name__ == "__main__":
    unittest.main()
