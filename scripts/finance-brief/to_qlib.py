#!/usr/bin/env python3
"""U2: CSV 디렉터리 → qlib bin. 함정: dump_bin 인자는 --data_path(csv_path 아님)."""
import sys
import subprocess
import os


def main(csv_dir: str, qlib_dir: str) -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    subprocess.run(
        [
            sys.executable, os.path.join(here, "dump_bin.py"), "dump_all",
            "--data_path", csv_dir, "--qlib_dir", qlib_dir,
            "--include_fields", "open,high,low,close,volume,vwap,factor,change",
            "--date_field_name", "date",
        ],
        check=True,
    )
    idx = os.path.join(qlib_dir, "instruments", "all.txt")
    assert os.path.exists(idx), f"dump 실패: {idx} 없음"
    print(f"OK dump -> {qlib_dir}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
