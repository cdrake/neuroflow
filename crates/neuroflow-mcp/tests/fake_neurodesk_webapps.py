#!/usr/bin/env python3
"""Test stand-in for `neurodesk-webapps --job JOB --output DIR`.
Validates the job against neurodesk/webapps sources, then writes outputs named
like the real apps' downloads, plus job-result.json."""
import json, re, sys, os, gzip, shutil
from pathlib import Path
import numpy as np, nibabel as nib

WEBAPPS = Path(os.environ.get("WEBAPPS_SRC", "/root/dev/webapps"))
args = sys.argv[1:]
job_path = Path(args[args.index("--job") + 1]); out = Path(args[args.index("--output") + 1])
job = json.loads(job_path.read_text())
assert job["schemaVersion"] == 1 and job["expectedDownloads"] >= 1
app_dir = WEBAPPS / "apps" / job["app"]
source = (app_dir / "index.html").read_text() + "".join(p.read_text() for p in (app_dir / "src").glob("*.js"))
source += (WEBAPPS / "packages/components/src/elements/file-field.js").read_text() if (WEBAPPS / "packages/components/src/elements/file-field.js").exists() else ""
for step in job["steps"]:
    assert step["action"] in {"upload", "click", "fill", "select", "check", "wait"}, step
    for ident in re.findall(r"#([A-Za-z][\w-]*)", step["selector"]):
        if f'id="{ident}"' not in source and f"'{ident}'" not in source and f'"{ident}"' not in source:
            print(f"FAKE: selector #{ident} not found in {job['app']} sources", file=sys.stderr); sys.exit(3)
    if step["action"] == "select":
        sel = re.search(r"#([\w-]+)", step["selector"]).group(1)
        block = re.search(rf'<select id="{sel}">(.*?)</select>', source, re.S)
        if block and f'value="{step["value"]}"' not in block.group(1):
            print(f"FAKE: option {step['value']!r} not in #{sel}", file=sys.stderr); sys.exit(3)
    if step["action"] == "upload":
        for p in step["paths"]:
            assert Path(p).is_file(), p
out.mkdir(parents=True, exist_ok=False)
upload = next(s for s in job["steps"] if s["action"] == "upload")["paths"][0]
stem = re.sub(r"\.nii(\.gz)?$", "", Path(upload).name)
img = nib.load(upload); data = np.asanyarray(img.dataobj).astype("float32")
files = []
if job["app"] == "brain-extraction":
    method = next(s["value"] for s in job["steps"] if s["selector"] == "#method")
    mask = (data > data.mean()).astype("uint8")
    for suffix, arr in (("brain", data * mask), ("mask", mask)):
        name = f"{stem}_{method}_{suffix}.nii"; nib.save(nib.Nifti1Image(arr, img.affine), str(out / name)); files.append(name)
elif job["app"] == "synthseg":
    # 1 mm grid label map with two hippocampi and cortex, like SynthSeg's label ids.
    lab = np.zeros((60, 60, 60), dtype="int32"); lab[10:50, 10:50, 10:50] = 3; lab[20:26, 20:30, 25:32] = 17; lab[34:40, 20:30, 25:32] = 53; lab[28:32, 28:32, 28:32] = 24
    name = f"{stem}_synthseg.nii.gz"; nib.save(nib.Nifti1Image(lab, np.eye(4)), str(out / name)); files.append(name)
    rep = f"{stem}_synthseg.json"; (out / rep).write_text(json.dumps({"seconds": 1.0, "outputShape": [60, 60, 60]})); files.append(rep)
else:
    print(f"FAKE: no simulation for {job['app']}", file=sys.stderr); sys.exit(4)
assert len(files) == job["expectedDownloads"], (files, job["expectedDownloads"])
(out / "job-result.json").write_text(json.dumps({"app": job["app"], "downloads": [{"filename": f, "bytes": (out / f).stat().st_size} for f in files]}, indent=2))
print(json.dumps({"app": job["app"], "downloads": files}))
