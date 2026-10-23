"""NeuroFlow gallery tool: bids-tidy-names.

Renames the series that HeuDiConv could not tell apart. When several series
map to one BIDS name, HeuDiConv keeps the last one under that name and writes
the others as ``<name>__dup-NN`` (``<name>__echo-N_dup-NN`` for multi-echo),
which is not BIDS. On Siemens sessions the usual causes are magnitude and
phase reconstructions of one acquisition, single-band references that share
the BOLD protocol name, and protocols run more than once. This module reads
each sidecar and settles every such group with, in order:

0. entities: an ``anat`` name keeps only the entities BIDS allows there; any
   other (ReproIn passes ``dir-REV`` through from the protocol name) is folded
   into ``acq``, so ``acq-X_dir-REV`` becomes ``acq-XDirREV``;
1. suffix: a ``bold`` series whose SeriesDescription marks it ``_SBRef`` (or a
   single volume beside 4D siblings) is an ``sbref``;
2. ``part``: a group mixing ImageType MAGNITUDE / PHASE / REAL / IMAGINARY gets
   ``part-mag`` / ``part-phase`` / ``part-real`` / ``part-imag``;
3. ``run``: series still sharing a name are numbered in SeriesNumber order,
   unless the name already has a run, when they keep HeuDiConv's names and
   the step reports them.

The input dataset is not changed: the tidy copy is written to the output
directory with unchanged files hard-linked (copied across filesystems), the
renamed series under their new names, and scans.tsv and IntendedFor rewritten.
Standard library only.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import shutil
import struct
from pathlib import Path

from neuroflow import session

#: BIDS entity order (specification appendix "Entity table").
ENTITY_ORDER = [
    "sub", "ses", "sample", "task", "tracksys", "acq", "nuc", "voi", "ce", "trc", "stain",
    "rec", "dir", "run", "mod", "echo", "flip", "inv", "mt", "part", "proc", "hemi",
    "space", "split", "recording", "chunk", "seg", "res", "den", "label", "desc",
]
DATA_EXTS = (".nii.gz", ".nii")
#: Files that travel with a series and are renamed with it.
SIDECAR_EXTS = (".json", ".bval", ".bvec", ".tsv", ".tsv.gz")
DUP = re.compile(r"^(?P<base>.+?)__(?P<extra>(?:[a-z]+-[A-Za-z0-9]+_)*)dup-(?P<n>\d+)$")
PARTS = {"PHASE": "phase", "P": "phase", "MAGNITUDE": "mag", "M": "mag",
         "REAL": "real", "R": "real", "IMAGINARY": "imag", "I": "imag"}
#: Entities BIDS allows for anatomical (non-parametric and parametric) images.
ANAT_ENTITIES = {"sub", "ses", "task", "acq", "ce", "rec", "run", "echo", "flip", "inv", "mt", "part", "chunk"}
SKIP_DIRS = {".heudiconv", ".git", ".datalad"}


def split_ext(name: str) -> tuple[str, str]:
    for ext in DATA_EXTS + SIDECAR_EXTS + (".dicom.tgz",):
        if name.endswith(ext):
            return name[: -len(ext)], ext
    return Path(name).stem, Path(name).suffix


def parse(stem: str) -> tuple[dict[str, str], str]:
    """BIDS entities and suffix of a file stem (no extension, no HeuDiConv marker)."""
    *pairs, suffix = stem.split("_")
    entities: dict[str, str] = {}
    for pair in pairs:
        key, _, value = pair.partition("-")
        entities[key] = value
    return entities, suffix


def compose(entities: dict[str, str], suffix: str) -> str:
    known = [k for k in ENTITY_ORDER if k in entities]
    other = [k for k in entities if k not in ENTITY_ORDER]
    return "_".join([f"{k}-{entities[k]}" for k in known + other] + [suffix])


def nifti_volumes(path: Path) -> int:
    """Volumes in a NIfTI-1/2 file (product of dims 4..7), from its header alone."""
    opener = gzip.open if path.name.endswith(".gz") else open
    try:
        with opener(path, "rb") as f:
            head = f.read(540)
    except OSError:
        return 1
    for endian in "<>":
        if struct.unpack(endian + "i", head[:4])[0] == 348:
            dims = struct.unpack(endian + "8h", head[40:56])
            break
        if struct.unpack(endian + "i", head[:4])[0] == 540:
            dims = struct.unpack(endian + "8q", head[16:80])
            break
    else:
        return 1
    count = 1
    for d in dims[4 : 1 + max(dims[0], 3)]:
        count *= max(int(d), 1)
    return count


class Series:
    """One converted series: a data file plus its sidecars, in one BIDS folder."""

    def __init__(self, folder: Path, stem: str, ext: str) -> None:
        self.folder, self.old_stem, self.ext = folder, stem, ext
        m = DUP.match(stem)
        self.dup = m is not None
        base = m.group("base") if m else stem
        self.entities, self.suffix = parse(base)
        if m:
            for pair in filter(None, m.group("extra").split("_")):
                key, _, value = pair.partition("-")
                self.entities.setdefault(key, value)
        sidecar = folder / f"{stem}.json"
        self.meta = json.loads(sidecar.read_text()) if sidecar.is_file() else {}
        self.volumes = nifti_volumes(folder / f"{stem}{ext}")
        self.why: list[str] = []
        self.kept = False

    @property
    def number(self) -> tuple[float, str]:
        n = self.meta.get("SeriesNumber")
        return (float(n) if isinstance(n, (int, float)) else float("inf"), self.old_stem)

    @property
    def part(self) -> str | None:
        for tag in reversed(self.meta.get("ImageType") or []):
            if str(tag).upper() in PARTS:
                return PARTS[str(tag).upper()]
        return None

    @property
    def stem(self) -> str:
        return self.old_stem if self.kept else compose(self.entities, self.suffix)

    def key(self) -> tuple[Path, str]:
        return self.folder, self.stem


def tidy_names(series: list[Series]) -> list[str]:
    """Settle names in place; returns the groups left unresolved."""
    def groups() -> list[list[Series]]:
        out: dict[tuple[Path, str], list[Series]] = {}
        for s in series:
            out.setdefault(s.key(), []).append(s)
        return [g for g in out.values() if len(g) > 1]

    # 0. entities anat does not allow, folded into acq.
    for s in series:
        if s.folder.name != "anat":
            continue
        extra = [k for k in s.entities if k not in ANAT_ENTITIES]
        if extra:
            folded = "".join(f"{k.capitalize()}{s.entities.pop(k)}" for k in extra)
            s.entities["acq"] = s.entities.get("acq", "") + folded
            s.why.append(f"acq-{s.entities['acq']}: {', '.join(extra)} is not an anat entity")
    # 1. suffix: single-band references filed as bold.
    for group in [g for g in groups() if any(s.dup for s in g)]:
        multi = any(s.volumes > 1 for s in group)
        for s in group:
            desc = str(s.meta.get("SeriesDescription") or "")
            if s.suffix == "bold" and (re.search(r"_SBRef(_|$)", desc, re.I) or (multi and s.volumes == 1)):
                s.suffix = "sbref"
                s.why.append("sbref: SeriesDescription marks a single-band reference"
                             if "sbref" in desc.lower() else "sbref: one volume beside 4D BOLD")
    # 2. part: magnitude / phase (/ real / imaginary) of one acquisition.
    for group in groups():
        parts = {s.part for s in group}
        if len(parts) > 1 and None not in parts:
            for s in group:
                if "part" not in s.entities:
                    s.entities["part"] = s.part
                    s.why.append(f"part-{s.part}: ImageType")
    # 3. run: repeats of one protocol, numbered in acquisition order.
    unresolved: list[str] = []
    for group in groups():
        if "run" in group[0].entities:
            unresolved.append(f"{group[0].folder.name}/{group[0].stem}: {len(group)} series share a run")
            continue
        for i, s in enumerate(sorted(group, key=lambda s: s.number), start=1):
            s.entities["run"] = f"{i:02d}"
            s.why.append(f"run-{i:02d}: SeriesNumber {s.meta.get('SeriesNumber', '?')}")
    # Groups that still collide keep HeuDiConv's names.
    for group in groups():
        for s in group:
            s.kept, s.why = True, []
    return unresolved


def link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def rewrite_paths(value, mapping: dict[str, str]):
    if isinstance(value, str):
        for old, new in mapping.items():
            if value == old or value.endswith("/" + old):
                return value[: -len(old)] + new
        return value
    if isinstance(value, list):
        return [rewrite_paths(v, mapping) for v in value]
    return value


def run(bids_dir: Path) -> dict:
    sess = session()
    src = Path(bids_dir)
    out = sess.output_path("bids_dir")
    if out.exists():
        shutil.rmtree(out)

    series: list[Series] = []
    for data in sorted(src.rglob("*")):
        rel = data.relative_to(src)
        if any(p in SKIP_DIRS for p in rel.parts) or rel.parts[0] in ("sourcedata", "derivatives"):
            continue
        if data.is_file() and data.name.endswith(DATA_EXTS) and rel.parts[0].startswith("sub-"):
            stem, ext = split_ext(data.name)
            series.append(Series(data.parent, stem, ext))
    unresolved = tidy_names(series)

    # Old -> new path pieces: "<folder>/<stem>" relative to the dataset root.
    renamed = {s: s.stem for s in series if s.stem != s.old_stem}
    stems = {f"{s.folder.relative_to(src).as_posix()}/{s.old_stem}": f"{s.folder.relative_to(src).as_posix()}/{new}"
             for s, new in renamed.items()}
    data_paths = {f"{s.folder.name}/{s.old_stem}{s.ext}": f"{s.folder.name}/{new}{s.ext}"
                  for s, new in renamed.items()}

    def target(rel: Path) -> Path:
        stem, ext = split_ext(rel.name)
        parent = rel.parent.as_posix()
        key = f"{parent}/{stem}"
        if parent.startswith("sourcedata/"):
            key = f"{parent[len('sourcedata/'):]}/{stem}"
            if key in stems:
                return Path("sourcedata") / f"{stems[key]}{ext}"
        elif key in stems:
            return Path(f"{stems[key]}{ext}")
        return rel

    copied = 0
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if any(p in SKIP_DIRS for p in rel.parts) or not path.is_file():
            continue
        dst = out / target(rel)
        if path.name.endswith("_scans.tsv"):
            lines = path.read_text().splitlines()
            fixed = [lines[0]] + ["\t".join([data_paths.get(c[0], c[0]), *c[1:]])
                                  for c in (line.split("\t") for line in lines[1:])]
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text("\n".join(fixed) + "\n")
        elif path.suffix == ".json" and rel.parts[0].startswith("sub-") and data_paths:
            meta = json.loads(path.read_text())
            if "IntendedFor" in meta:
                meta["IntendedFor"] = rewrite_paths(meta["IntendedFor"], data_paths)
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_text(json.dumps(meta, indent=2) + "\n")
            else:
                link_or_copy(path, dst)
        else:
            link_or_copy(path, dst)
        copied += 1

    renames = [{"from": f"{s.folder.relative_to(src).as_posix()}/{s.old_stem}{s.ext}",
                "to": f"{s.folder.relative_to(src).as_posix()}/{new}{s.ext}", "why": s.why}
               for s, new in sorted(renamed.items(), key=lambda kv: kv[0].number)]
    for r in renames:
        sess.log(f"{r['from']} -> {Path(r['to']).name} ({'; '.join(r['why'])})")
    for u in unresolved:
        sess.log(f"left as HeuDiConv named it: {u}")
    left = sorted(f"{x.folder.name}/{x.old_stem}" for x in series if DUP.match(x.stem))
    sess.provenance(action="tidy-names", renamed=len(renames), unresolved=unresolved,
                 outputs={"bids_dir": out.name})
    sess.log(f"renamed {len(renames)} series; {len(left)} still carry a __dup marker; wrote {copied} file(s) to {out}")
    return {"renamed": renames, "unresolved": unresolved, "remainingDup": left}
