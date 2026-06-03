#!/usr/bin/env python3
"""NeuroFlow gallery tool: python-volume-filter.

Reads the NeuroFlow session context, filters the NIfTI volumes of a BIDS
dataset, and writes the results to the session output directory. See
docs/neuroflow-session-contract.md.

Env:
  NEUROFLOW_SESSION     session dir containing context.json (+ provenance.jsonl)
  NEUROFLOW_OUTPUT_DIR  where to write outputs (delivery: filtered/)

Run standalone for testing:
  NEUROFLOW_SESSION=/tmp/sess NEUROFLOW_OUTPUT_DIR=/tmp/sess/outputs/filter \
    python3 filter_volumes.py
"""
from __future__ import annotations

import datetime
import json
import os
import shutil
import sys
from pathlib import Path

TOOL_ID = "neuroflow.gallery.tools/python-volume-filter"
STEP = os.environ.get("NEUROFLOW_STEP", "filter")


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_context() -> dict:
    session = os.environ.get("NEUROFLOW_SESSION")
    if not session:
        return {}
    ctx_path = Path(session) / "context.json"
    if not ctx_path.is_file():
        return {}
    return json.loads(ctx_path.read_text())


def output_dir(ctx: dict) -> Path:
    out = os.environ.get("NEUROFLOW_OUTPUT_DIR") or ctx.get("outputDir")
    if not out:
        session = os.environ.get("NEUROFLOW_SESSION", ".")
        out = str(Path(session) / "outputs" / STEP)
    # tool declares delivery: core:result-dir at path "filtered"
    return Path(out) / "filtered"


def append_provenance(entry: dict) -> None:
    session = os.environ.get("NEUROFLOW_SESSION")
    if not session:
        return
    line = json.dumps({"ts": _now(), "step": STEP, "tool": TOOL_ID,
                       "agent": "python-volume-filter", **entry})
    with (Path(session) / "provenance.jsonl").open("a") as fh:
        fh.write(line + "\n")


def find_volumes(bids_dir: Path) -> list[Path]:
    vols: list[Path] = []
    for pat in ("*.nii", "*.nii.gz"):
        vols.extend(bids_dir.rglob(pat))
    return sorted(v for v in vols if v.is_file())


def apply_filter(src: Path, dst: Path, operation: str, amount: float) -> str:
    """Filter one volume. Falls back to a copy if deps are absent or the file
    cannot be read/processed as a NIfTI, so one bad input never fails the step."""
    try:
        import nibabel as nib  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        shutil.copy2(src, dst)
        return "passthrough (nibabel/numpy unavailable)"

    try:
        img = nib.load(str(src))
        data = img.get_fdata().astype("float32")

        if operation == "threshold":
            data[data < amount] = 0
        elif operation == "zscore":
            std = data.std() or 1.0
            data = (data - data.mean()) / std
        elif operation == "smooth":
            try:
                from scipy.ndimage import gaussian_filter  # type: ignore
                zooms = img.header.get_zooms()[:3] or (1.0, 1.0, 1.0)
                fwhm_to_sigma = 1.0 / 2.354820045
                sigma = [max(amount, 0) * fwhm_to_sigma / (z or 1.0) for z in zooms]
                data = gaussian_filter(data, sigma=sigma)
            except ImportError:
                shutil.copy2(src, dst)
                return "passthrough (scipy unavailable)"
        # operation == "passthrough" -> write data unchanged

        nib.save(nib.Nifti1Image(data, img.affine, img.header), str(dst))
        return operation
    except Exception as exc:  # noqa: BLE001 - reference script must stay resilient
        shutil.copy2(src, dst)
        return f"passthrough ({type(exc).__name__})"


def main() -> int:
    ctx = load_context()
    inputs = ctx.get("inputs", {})
    bids_dir = inputs.get("bids_dir") or os.environ.get("NEUROFLOW_BIDS_DIR")
    if not bids_dir:
        print("filter_volumes: no bids_dir in context; nothing to do", file=sys.stderr)
        return 1
    operation = str(inputs.get("operation", "smooth"))
    amount = float(inputs.get("amount", 3))

    out = output_dir(ctx)
    out.mkdir(parents=True, exist_ok=True)

    volumes = find_volumes(Path(bids_dir))
    written: list[str] = []
    mode = "passthrough"
    for src in volumes:
        dst = out / src.name
        mode = apply_filter(src, dst, operation, amount)
        written.append(dst.name)
        print(f"filter_volumes: {src.name} -> {dst} [{mode}]")

    append_provenance({
        "action": "filter",
        "operation": operation,
        "amount": amount,
        "mode": mode,
        "inputCount": len(volumes),
        "outputs": {"filtered_volumes": [f"filtered/{n}" for n in written]},
    })
    print(f"filter_volumes: wrote {len(written)} volume(s) to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
