#!/usr/bin/env python3
"""End-to-end smoke test for neuroflow-mcp over stdio.

Builds a tiny synthetic BIDS dataset, starts the server against the gallery
registry, and drives it like an MCP client: initialize, list tools, validate a
broken workflow (expects a repair hint), run a single tool, run the gallery
filter-qa workflow, read artifact summaries, and read the provenance record.

Requires: python3 with nibabel + numpy (+ scipy for smoothing), node, and a
built binary (cargo build -p neuroflow-mcp).

Usage (from the neuroflow repo root):
    python3 crates/neuroflow-mcp/tests/smoke.py [--bin target/debug/neuroflow-mcp] [--spec ../neuroflow-spec]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


class Client:
    def __init__(self, cmd: list[str]):
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.next_id = 0
        self.progress: list[dict] = []

    def request(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("server closed stdout")
            reply = json.loads(line)
            if reply.get("method") == "notifications/progress":
                self.progress.append(reply["params"])
                continue
            if reply.get("id") == self.next_id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply["result"]

    def notify(self, method: str) -> None:
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.proc.stdin.flush()

    def call(self, name: str, arguments: dict, token: str | None = None) -> dict:
        params: dict = {"name": name, "arguments": arguments}
        if token:
            params["_meta"] = {"progressToken": token}
        return self.request("tools/call", params)

    def read(self, uri: str) -> dict:
        return self.request("resources/read", {"uri": uri})["contents"][0]

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def check(cond: bool, label: str, detail: object = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'}  {label}")
    if not cond:
        print(f"        {detail}")
        sys.exit(1)


def make_data(root: Path) -> Path:
    import nibabel as nib  # type: ignore
    import numpy as np  # type: ignore

    bids = root / "bids"
    for sub in ("01", "02"):
        anat = bids / f"sub-{sub}" / "anat"
        anat.mkdir(parents=True)
        x, y, z = np.mgrid[:40, :48, :36]
        img = (1000 * np.exp(-((x - 20) ** 2 + (y - 24) ** 2 + (z - 18) ** 2) / 200)).astype("float32")
        aff = np.diag([2.0, 2.0, 2.0, 1.0])
        nib.save(nib.Nifti1Image(img, aff), str(anat / f"sub-{sub}_T1w.nii.gz"))
    (bids / "dataset_description.json").write_text(json.dumps({"Name": "smoke", "BIDSVersion": "1.9.0"}))
    return bids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default="target/debug/neuroflow-mcp")
    ap.add_argument("--registry", default="gallery")
    ap.add_argument("--spec", default="../neuroflow-spec")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="neuroflow-mcp-smoke-"))
    data = tmp / "data"
    bids = make_data(data)
    cmd = [args.bin, "--registry", args.registry, "--data-root", str(data), "--sessions", str(tmp / "runs")]
    if Path(args.spec).is_dir():
        cmd += ["--spec", args.spec]
    c = Client(cmd)

    print("handshake:")
    init = c.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                    "clientInfo": {"name": "smoke-test", "version": "1.0.0"}})
    c.notify("notifications/initialized")
    check(init["protocolVersion"] == "2025-11-25", "negotiated 2025-11-25")
    tools = {t["name"]: t for t in c.request("tools/list")["tools"]}
    for name in ("neuroflow_list", "neuroflow_validate", "neuroflow_run",
                 "neuroflow.gallery.tools.python-volume-filter", "neuroflow.gallery.filter-qa"):
        check(name in tools, f"tool {name} listed")
    schema = tools["neuroflow.gallery.tools.python-volume-filter"]["inputSchema"]
    check(schema["properties"]["bids_dir"].get("x-neuroflow-type") == "neuro:bids-dataset",
          "generated inputSchema carries x-neuroflow-type")

    print("discovery:")
    listed = c.call("neuroflow_list", {"acceptsType": "neuro:volume"})["structuredContent"]
    ids = [i["id"] for i in listed["items"]]
    check("neuroflow.gallery.tools/niivue-qa-page" in ids, "acceptsType neuro:volume finds the QA page", ids)

    print("inspect inputs:")
    t1 = next(bids.rglob("*_T1w.nii.gz"))
    info = c.call("neuroflow_inspect", {"path": str(t1)})["structuredContent"]
    check(info["summary"]["dims"] == [40, 48, 36] and "nonzeroVolumeMl" in info["summary"]["intensity"],
          "NIfTI geometry and nonzero volume", info)
    ds = c.call("neuroflow_inspect", {"path": str(bids)})["structuredContent"]
    check(ds["type"] == "neuro:bids-dataset" and ds["summary"]["bids"]["subjects"] == ["sub-01", "sub-02"],
          "BIDS dataset detected with subjects", ds.get("summary", {}).get("bids"))
    import nibabel as nib, numpy as np  # type: ignore
    lab = np.zeros((10, 10, 10), dtype="int16"); lab[:2, :2, :2] = 17
    nib.save(nib.Nifti1Image(lab, np.diag([2.0, 2.0, 2.0, 1.0])), str(data / "labels.nii.gz"))
    labs = c.call("neuroflow_inspect", {"path": str(data / "labels.nii.gz"), "type": "neuro:label-map"})["structuredContent"]
    check(labs["summary"]["labels"]["17"]["volumeMl"] == 0.064, "label volumes when typed as label-map", labs["summary"].get("labels"))
    denied = c.call("neuroflow_inspect", {"path": "/etc/hosts"})
    check(denied.get("isError") is True, "inspect is confined to data roots")

    print("validate a broken workflow:")
    broken = json.loads(json.dumps(json.load(open(Path(args.registry) / "workflows" / "filter-qa.neuroflow.json"))))
    broken["steps"]["qa"]["inputs"]["volumes"]["ref"] = "steps.filter.outputs.volumes"
    report = c.call("neuroflow_validate", {"document": broken})["structuredContent"]
    diag = next((d for d in report["diagnostics"] if d["severity"] == "error"), {})
    check(not report["valid"], "reported invalid")
    check("filtered_volumes" in diag.get("hint", ""), "hint lists the declared output", diag)
    check(diag.get("pointer") == "/steps/qa/inputs/volumes", "pointer locates the binding", diag)
    rejected = c.call("neuroflow_run", {"workflow": broken, "inputs": {"bids_dir": str(bids)}})
    check(rejected.get("isError") is True, "neuroflow_run refuses the invalid workflow")

    print("path confinement:")
    outside = c.call("neuroflow.gallery.tools.python-volume-filter", {"bids_dir": "/etc"})
    check(outside.get("isError") is True and "outside the allowed data roots" in outside["content"][0]["text"],
          "rejects inputs outside --data-root", outside["content"][0]["text"])

    print("run one tool:")
    r = c.call("neuroflow.gallery.tools.python-volume-filter",
               {"bids_dir": str(bids), "operation": "threshold", "amount": 100}, token="t1")
    sc = r["structuredContent"]
    check(sc["status"] == "completed", "filter completed", r["content"][0]["text"])
    vols = sc["outputs"]["filtered_volumes"]
    check(len(vols) == 2 and vols[0]["uri"].startswith("neuroflow://runs/"), "two volume artifacts", vols)
    check(any(p.get("progressToken") == "t1" for p in c.progress), "progress notifications sent")
    links = [x for x in r["content"] if x["type"] == "resource_link"]
    check(len(links) == 2, "resource_link per artifact")

    print("chain by URI into the workflow:")
    r2 = c.call("neuroflow.gallery.filter-qa", {"bids_dir": str(bids), "operation": "zscore"})
    sc2 = r2["structuredContent"]
    check(sc2["status"] == "completed", "filter-qa completed", r2["content"][0]["text"])
    html = sc2["outputs"]["qa_html"]
    check(html["path"].endswith("index.html"), "QA page produced", html)
    qa_via_uri = c.call("neuroflow.gallery.tools.niivue-qa-page", {"volumes": [v["uri"] for v in vols]})
    check(qa_via_uri["structuredContent"]["status"] == "completed", "QA tool accepts neuroflow:// URIs as inputs",
          qa_via_uri["content"][0]["text"])

    print("artifact summaries:")
    summary = json.loads(c.read(vols[0]["uri"])["text"])
    s = summary["summary"]
    check(s["dims"] == [40, 48, 36], "NIfTI dims", s)
    check(s["voxelSizeMm"] == [2.0, 2.0, 2.0], "voxel size", s)
    check("intensity" in s and s["intensity"]["min"] == 0.0, "thresholded intensity range", s.get("intensity"))
    raw = c.read(html["uri"] + "/raw")
    check("text" in raw and "<html" in raw["text"].lower(), "raw read of small text artifact")

    print("provenance:")
    prov = json.loads(c.read(sc2["provenance"])["text"])
    check(prov["kind"] == "provenance" and prov["run"]["status"] == "completed", "provenance document")
    check(any(a["name"] == "smoke-test" for a in prov["agents"]), "MCP client recorded as an agent")
    check(len(prov["activities"]) == 2, "one activity per step")
    prov_path = tmp / "runs" / sc2["runId"] / "run.provenance.json"
    print(f"  (provenance written to {prov_path})")

    print("failure reporting:")
    fail = c.call("neuroflow.gallery.tools.provenance-fold", {"status": "bogus"})
    check(fail.get("isError") is True, "enum violation rejected", fail["content"][0]["text"])

    c.close()
    print(f"\nAll smoke checks passed. Scratch: {tmp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
