import json
import sys
from tempfile import NamedTemporaryFile
from pathlib import Path

from openpyxl import load_workbook


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: workbook_helper.py <info|read-batch|write-batch>")

    command = sys.argv[1]
    payload = json.load(sys.stdin)

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
        temp_path.replace(target_path)
        return {"writtenRows": len(matrix)}
    finally:
        workbook.close()


def open_workbook(file_path: str):
    path = Path(file_path)
    keep_vba = path.suffix.lower() == ".xlsm"
    return load_workbook(filename=file_path, keep_vba=keep_vba)


def pick_sheet(workbook, sheet_name: str):
    if sheet_name:
        return workbook[sheet_name]
    return workbook.active


def print_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def column_letter_to_index(column: str) -> int:
    result = 0
    for char in column.upper():
        result = result * 26 + (ord(char) - 64)
    return result


if __name__ == "__main__":
    main()
