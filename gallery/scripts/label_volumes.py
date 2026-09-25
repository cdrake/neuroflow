#!/usr/bin/env python3
"""NeuroFlow gallery tool: label-volumes.

Measures the volume of every label in a segmentation and, optionally, of a
brain mask. Writes volumes.tsv to the session output directory and returns the
same rows inline as {"table": ...} in $NEUROFLOW_OUTPUT_FILE, so an agent can
answer "what is the left hippocampal volume?" without reading the file.
"""
from __future__ import annotations

import datetime
import json
import os
import sys
from pathlib import Path

TOOL_ID = "neuroflow.gallery.tools/label-volumes"
STEP = os.environ.get("NEUROFLOW_STEP", "volumes")

# FreeSurfer names for the SynthSeg 2.0 label set (FreeSurferColorLUT.txt).
NAMES = {
    2: "Left-Cerebral-White-Matter", 3: "Left-Cerebral-Cortex", 4: "Left-Lateral-Ventricle",
    5: "Left-Inf-Lat-Vent", 7: "Left-Cerebellum-White-Matter", 8: "Left-Cerebellum-Cortex",
    10: "Left-Thalamus", 11: "Left-Caudate", 12: "Left-Putamen", 13: "Left-Pallidum",
    14: "3rd-Ventricle", 15: "4th-Ventricle", 16: "Brain-Stem", 17: "Left-Hippocampus",
    18: "Left-Amygdala", 24: "CSF", 26: "Left-Accumbens-area", 28: "Left-VentralDC",
    41: "Right-Cerebral-White-Matter", 42: "Right-Cerebral-Cortex", 43: "Right-Lateral-Ventricle",
    44: "Right-Inf-Lat-Vent", 46: "Right-Cerebellum-White-Matter", 47: "Right-Cerebellum-Cortex",
    49: "Right-Thalamus", 50: "Right-Caudate", 51: "Right-Putamen", 52: "Right-Pallidum",
    53: "Right-Hippocampus", 54: "Right-Amygdala", 58: "Right-Accumbens-area", 60: "Right-VentralDC",
}
# Labels that are fluid rather than tissue, excluded from brain_tissue_ml.
FLUID = {4, 5, 14, 15, 24, 43, 44}


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    import nibabel as nib  # type: ignore
    import numpy as np  # type: ignore

    session = Path(os.environ["NEUROFLOW_SESSION"])
    ctx = json.loads((session / "context.json").read_text())
    inputs = ctx.get("inputs", {})
    out_dir = Path(os.environ.get("NEUROFLOW_OUTPUT_DIR") or ctx["outputDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    result_file = Path(os.environ.get("NEUROFLOW_OUTPUT_FILE") or out_dir / "result.json")

    img = nib.load(inputs["labels"])
    data = np.asanyarray(img.dataobj)
    if not np.issubdtype(data.dtype, np.integer):
        data = np.rint(data)
    data = data.astype(np.int64)
    voxel_ml = float(abs(np.linalg.det(img.affine[:3, :3]))) / 1000.0

    ids, counts = np.unique(data, return_counts=True)
    rows = []
    for label, n in zip(ids.tolist(), counts.tolist()):
        if label == 0:
            continue
        rows.append({
            "label": label,
            "name": NAMES.get(label, f"label-{label}"),
            "voxels": n,
            "volume_ml": round(n * voxel_ml, 3),
        })

    totals = {
        "labeled_ml": round(sum(r["volume_ml"] for r in rows), 3),
        "brain_tissue_ml": round(sum(r["volume_ml"] for r in rows if r["label"] not in FLUID), 3),
    }
    if inputs.get("mask"):
        mimg = nib.load(inputs["mask"])
        m = np.asanyarray(mimg.dataobj)
        mvox = float(abs(np.linalg.det(mimg.affine[:3, :3]))) / 1000.0
        totals["brain_mask_ml"] = round(int(np.count_nonzero(m)) * mvox, 3)

    with (out_dir / "volumes.tsv").open("w") as fh:
        fh.write("label\tname\tvoxels\tvolume_ml\n")
        for r in rows:
            fh.write(f"{r['label']}\t{r['name']}\t{r['voxels']}\t{r['volume_ml']}\n")
    table = {"voxel_volume_ml": round(voxel_ml, 6), "totals": totals, "rows": rows}
    result_file.write_text(json.dumps({"table": table}, indent=2) + "\n")

    line = {"ts": now(), "step": STEP, "tool": TOOL_ID, "agent": "label-volumes", "action": "measure",
            "outputs": {"volumes": "volumes.tsv"}}
    with (session / "provenance.jsonl").open("a") as fh:
        fh.write(json.dumps(line) + "\n")
    print(f"label_volumes: {len(rows)} labels, {totals}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
