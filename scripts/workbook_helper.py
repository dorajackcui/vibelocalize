import json
import sys
import time
from tempfile import NamedTemporaryFile
from pathlib import Path

from openpyxl import load_workbook


def main() -> None:
    configure_stdio()

    if len(sys.argv) != 2:
        raise SystemExit("Usage: workbook_helper.py <info|read-batch|write-batch>")

    command = sys.argv[1]
    payload = read_json_from_stdin()

    if command == "info":
        print_json(get_workbook_info(payload))
        return

    if command == "read-batch":
        print_json(read_batch(payload))
        return

    if command == "write-batch":
        print_json(write_batch(payload))
        return

    raise SystemExit(f"Unknown command: {command}")


def get_workbook_info(payload: dict) -> dict:
    workbook = open_workbook(payload["filePath"])
    try:
        return {
            "sheetNames": workbook.sheetnames,
            "activeSheetName": workbook.active.title,
        }
    finally:
        workbook.close()


def read_batch(payload: dict) -> dict:
    workbook = open_workbook(payload["filePath"])
    try:
        sheet = pick_sheet(workbook, payload.get("sheetName"))
        column = payload["column"]
        start_row = int(payload["startRow"])
        batch_size = int(payload["batchSize"])
        values = []

        for row in range(start_row, start_row + batch_size):
            cell_value = sheet[f"{column}{row}"].value
            values.append("" if cell_value is None else str(cell_value))

        return {"values": values}
    finally:
        workbook.close()


def write_batch(payload: dict) -> dict:
    workbook = open_workbook(payload["filePath"])
    temp_path: Path | None = None
    workbook_closed = False
    try:
        sheet = pick_sheet(workbook, payload.get("sheetName"))
        column = payload["column"]
        start_row = int(payload["startRow"])
        matrix = payload["matrix"]
        start_column_index = column_letter_to_index(column)

        for row_offset, row_values in enumerate(matrix):
            for column_offset, value in enumerate(row_values):
                sheet.cell(
                    row=start_row + row_offset,
                    column=start_column_index + column_offset,
                    value=value,
                )

        target_path = Path(payload["filePath"])
        with NamedTemporaryFile(delete=False, suffix=target_path.suffix, dir=target_path.parent) as handle:
            temp_path = Path(handle.name)

        workbook.save(temp_path)
        workbook.close()
        workbook_closed = True

        replace_with_retry(temp_path, target_path)
        return {"writtenRows": len(matrix)}
    finally:
        if not workbook_closed:
            workbook.close()
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)


def open_workbook(file_path: str):
    path = Path(file_path)
    keep_vba = path.suffix.lower() == ".xlsm"
    return load_workbook(filename=file_path, keep_vba=keep_vba)


def pick_sheet(workbook, sheet_name: str):
    if sheet_name:
        return workbook[sheet_name]
    return workbook.active


def replace_with_retry(temp_path: Path, target_path: Path) -> None:
    delays = [0.0, 0.2, 0.5, 1.0, 2.0, 4.0]
    last_error: PermissionError | None = None

    for delay in delays:
        if delay > 0:
            time.sleep(delay)

        try:
            temp_path.replace(target_path)
            return
        except PermissionError as error:
            last_error = error

    raise PermissionError(
        "Could not replace the workbook file after multiple retries. "
        f"Make sure '{target_path}' is not open in Excel/WPS and is not being watched by memoQ, sync software, antivirus, or Explorer preview."
    ) from last_error


def print_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def configure_stdio() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def read_json_from_stdin() -> dict:
    return json.loads(sys.stdin.read())


def column_letter_to_index(column: str) -> int:
    result = 0
    for char in column.upper():
        result = result * 26 + (ord(char) - 64)
    return result


if __name__ == "__main__":
    main()
