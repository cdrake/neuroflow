"""NeuroFlow session helper for Python tools.

Standard library only. The ``python_tool.mjs`` adapter puts this module on
PYTHONPATH; tool code reads the session contract
(docs/neuroflow-session-contract.md) as one object instead of parsing
context.json and the NEUROFLOW_* variables by hand::

    from neuroflow import session
    s = session()                       # $NEUROFLOW_SESSION/context.json
    img = s.inputs["image"]             # typed from JSON; paths are pathlib.Path
    out = s.output_dir / "fa.nii.gz"    # created on first use
    s.result(summary={"mean_fa": 0.41}) # writes $NEUROFLOW_OUTPUT_FILE
    s.log("fitted 1.2M voxels")         # stderr, prefixed with the tool name

Provenance is the adapter's job; a tool that wants to record extra fields
calls ``s.provenance(action="fit", method="WLS")``, which appends one line in
the contract's format.
"""
from __future__ import annotations

import datetime
import json
import os
import sys
from pathlib import Path
from typing import Any

__all__ = ["Session", "session", "SCALAR_TYPES"]

#: Input types whose values are literals rather than paths.
SCALAR_TYPES = {"core:string", "core:integer", "core:number", "core:boolean", "core:object"}


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _env(name: str) -> str | None:
    return os.environ.get(name) or None


class Session:
    """One tool step's view of a NeuroFlow session."""

    def __init__(self, session_dir: str | os.PathLike[str] | None = None) -> None:
        root = session_dir or _env("NEUROFLOW_SESSION")
        if not root:
            raise RuntimeError("NEUROFLOW_SESSION is not set; run this through a NeuroFlow runtime")
        self.session_dir = Path(root)
        self.context: dict[str, Any] = json.loads((self.session_dir / "context.json").read_text())
        self.run_id: str = _env("NEUROFLOW_RUN_ID") or self.context.get("runId") or ""
        self.step: str = _env("NEUROFLOW_STEP") or self.context.get("step") or "step"
        self.tool: str = self.context.get("tool") or ""
        self.output_dir = Path(_env("NEUROFLOW_OUTPUT_DIR") or self.context["outputDir"])
        self.work_dir = Path(_env("NEUROFLOW_WORK_DIR") or self.context.get("workDir") or self.session_dir)
        self.output_file = Path(_env("NEUROFLOW_OUTPUT_FILE") or self.output_dir / "result.json")
        self.tool_doc: dict[str, Any] | None = self._load_tool_doc()
        self.inputs: dict[str, Any] = self._typed(self.context.get("inputs") or {})
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)

    # -- construction helpers -------------------------------------------------------
    @staticmethod
    def _load_tool_doc() -> dict[str, Any] | None:
        path = _env("NEUROFLOW_TOOL_DOC")
        if not path or not Path(path).is_file():
            return None
        try:
            return json.loads(Path(path).read_text())
        except (OSError, ValueError):
            return None

    def _typed(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Turn path-typed inputs into pathlib.Path; everything else stays JSON-typed."""
        decls = (self.tool_doc or {}).get("inputs") or {}
        typed: dict[str, Any] = {}
        for name, value in raw.items():
            kind = decls.get(name, {}).get("type")
            if not isinstance(kind, str):
                typed[name] = value
                continue
            element = kind[len("core:array<"):-1] if kind.startswith("core:array<") and kind.endswith(">") else kind
            if element in SCALAR_TYPES or value is None:
                typed[name] = value
            elif isinstance(value, list):
                typed[name] = [Path(v) if isinstance(v, str) and v else v for v in value]
            else:
                typed[name] = Path(value) if isinstance(value, str) and value else value
        return typed

    # -- outputs -------------------------------------------------------------------
    def output_path(self, name: str) -> Path:
        """Where the declared output ``name`` belongs: output_dir / its delivery path."""
        decl = ((self.tool_doc or {}).get("outputs") or {}).get(name) or {}
        rel = (decl.get("delivery") or {}).get("path") or name
        path = self.output_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def result(self, mapping: dict[str, Any] | None = None, /, **outputs: Any) -> Path:
        """Write the inline result ({output name: value}) to $NEUROFLOW_OUTPUT_FILE."""
        record = dict(mapping or {})
        record.update(outputs)
        self.output_file.parent.mkdir(parents=True, exist_ok=True)
        self.output_file.write_text(json.dumps(record, indent=2, default=_jsonable) + "\n")
        return self.output_file

    # -- diagnostics ---------------------------------------------------------------
    @property
    def name(self) -> str:
        """Short tool name for log prefixes (the id's last path segment)."""
        return self.tool.rsplit("/", 1)[-1] or "neuroflow"

    def log(self, *parts: Any) -> None:
        print(f"{self.name}: {' '.join(str(p) for p in parts)}", file=sys.stderr, flush=True)

    def provenance(self, **fields: Any) -> None:
        """Append one line to <session>/provenance.jsonl in the contract's format."""
        line = {"ts": _now(), "step": self.step, "tool": self.tool, **fields}
        with (self.session_dir / "provenance.jsonl").open("a") as fh:
            fh.write(json.dumps(line, default=_jsonable) + "\n")


def _jsonable(value: Any) -> Any:
    """json.dumps default: paths as strings, NumPy scalars/arrays via their own tolist()."""
    if isinstance(value, os.PathLike):
        return os.fspath(value)
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "item"):
        return value.item()
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


def session(session_dir: str | os.PathLike[str] | None = None) -> Session:
    """Read the current session (``$NEUROFLOW_SESSION`` unless a directory is given)."""
    return Session(session_dir)
