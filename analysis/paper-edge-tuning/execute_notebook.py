#!/usr/bin/env python3
"""Execute the audit notebook in place using nbclient."""

from pathlib import Path

import nbformat
from nbclient import NotebookClient


path = Path(__file__).resolve().parent / "paper_edge_tuning.ipynb"
notebook = nbformat.read(path, as_version=4)
NotebookClient(notebook, timeout=120, kernel_name="python3").execute(cwd=str(path.parent))
nbformat.write(notebook, path)
print(path)
