"""Run the single canonical toolkit without duplicating its implementation."""
import runpy
import sys
from pathlib import Path

toolkit = Path(__file__).resolve().parents[1] / "kits/workbench-tutorial/toolkit"
sys.path.insert(0, str(toolkit))
runpy.run_path(str(toolkit / "kickstart.py"), run_name="__main__")

