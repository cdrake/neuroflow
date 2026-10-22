"""NeuroFlow gallery tool: python-volume-filter.

Filters the NIfTI volumes of a BIDS dataset (Gaussian smoothing, intensity
threshold, z-score, or passthrough) into the step's ``filtered/`` output
directory. Run by ``python_tool.mjs`` as a function entry; the adapter has
already checked that NiBabel and NumPy import before this module is loaded, so
a missing package is reported with its fix instead of being papered over.

A volume that cannot be read as NIfTI is copied through unchanged and logged:
that is a data problem a user can see in the output, not an environment one.

An optional NeuroVue correction patch is recorded with the run (provenance and
the returned summary) so the filtered volumes trace back to the review that
preceded them. It does not change the filter: NeuroVue's patch holds clip
planes for one reviewed asset, not filter settings.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import nibabel as nib
import numpy as np

from neuroflow import session

FWHM_TO_SIGMA = 1.0 / 2.354820045


def find_volumes(bids_dir: Path) -> list[Path]:
    """The anatomical volumes: NIfTI files in ``anat/`` folders of the raw dataset.

    ``func``/``fmap`` series (often 4D), ``sourcedata``, ``derivatives`` and
    hidden converter state such as HeuDiConv's ``.heudiconv`` are left out.
    """
    vols: list[Path] = []
    for pat in ("*.nii", "*.nii.gz"):
        vols.extend(bids_dir.rglob(pat))
    def anatomical(v: Path) -> bool:
        parts = v.relative_to(bids_dir).parts[:-1]
        return (bool(parts) and parts[-1] == "anat"
                and not any(p.startswith(".") or p in ("sourcedata", "derivatives") for p in parts))
    return sorted(v for v in vols if v.is_file() and anatomical(v))


def gaussian_smooth(data: np.ndarray, sigma: list[float]) -> np.ndarray:
    """Separable Gaussian blur: SciPy when present, otherwise NumPy convolution per axis."""
    try:
        from scipy.ndimage import gaussian_filter

        return gaussian_filter(data, sigma=sigma)
    except ImportError:
        pass
    out = data.astype(np.float32, copy=True)
    for axis, s in enumerate(sigma[: out.ndim]):
        if s <= 0:
            continue
        radius = int(np.ceil(4 * s))
        x = np.arange(-radius, radius + 1, dtype=np.float32)
        kernel = np.exp(-0.5 * (x / s) ** 2)
        kernel /= kernel.sum()
        padded = np.pad(out, [(radius, radius) if a == axis else (0, 0) for a in range(out.ndim)], mode="reflect")
        out = np.apply_along_axis(lambda v: np.convolve(v, kernel, mode="valid"), axis, padded)
    return out


def apply_filter(src: Path, dst: Path, operation: str, amount: float) -> str:
    """Filter one volume into ``dst``; returns the mode actually applied."""
    try:
        img = nib.load(str(src))
        data = img.get_fdata().astype(np.float32)
    except Exception as exc:  # noqa: BLE001 - one unreadable input must not fail the dataset
        shutil.copy2(src, dst)
        return f"passthrough (unreadable: {type(exc).__name__})"

    if operation == "threshold":
        data[data < amount] = 0
    elif operation == "zscore":
        std = float(data.std()) or 1.0
        data = (data - data.mean()) / std
    elif operation == "smooth":
        zooms = img.header.get_zooms()[:3] or (1.0, 1.0, 1.0)
        sigma = [max(amount, 0) * FWHM_TO_SIGMA / (float(z) or 1.0) for z in zooms]
        # Space only: a 4D anatomical series is not smoothed across volumes.
        sigma += [0.0] * (data.ndim - len(sigma))
        data = gaussian_smooth(data, sigma)
    elif operation != "passthrough":
        raise ValueError(f"unknown operation {operation!r} (smooth | threshold | zscore | passthrough)")

    out = nib.Nifti1Image(data, img.affine, img.header)
    if operation != "passthrough":
        # Filtered values are fractional; do not round them back into the input's integer datatype.
        out.set_data_dtype(np.float32)
    nib.save(out, str(dst))
    return operation


def summarize_patch(patch) -> dict | None:
    """What the run records about a NeuroVue correction patch: a path or inline JSON."""
    if patch is None or patch == "":
        return None
    source = None
    if isinstance(patch, (str, Path)):
        source = str(patch)
        patch = json.loads(Path(patch).read_text(encoding="utf-8"))
    if not isinstance(patch, dict):
        raise ValueError("correction_patch must be a JSON object or a path to one")
    asset = patch.get("asset") if isinstance(patch.get("asset"), dict) else {}
    summary = {
        "asset": asset.get("id"),
        "clipPlanes": len(patch.get("clipPlanes") or []),
        "savedAt": patch.get("savedAt"),
    }
    if source:
        summary["path"] = source
    return summary


def run(
    bids_dir: Path, operation: str = "smooth", amount: float = 3.0, correction_patch=None
) -> dict:
    s = session()
    patch = summarize_patch(correction_patch)
    if patch:
        s.log(
            f"correction patch for {patch['asset']} ({patch['clipPlanes']} clip plane(s)) "
            "recorded with the run; it does not change the filter"
        )
    out = s.output_path("filtered_volumes")  # core:result-dir at "filtered"
    out.mkdir(parents=True, exist_ok=True)
    operation = str(operation or "smooth")
    amount = float(amount if amount is not None else 3.0)

    volumes = find_volumes(Path(bids_dir))
    written: list[str] = []
    modes: dict[str, str] = {}
    for src in volumes:
        dst = out / src.name
        mode = apply_filter(src, dst, operation, amount)
        written.append(dst.name)
        modes[src.name] = mode
        s.log(f"{src.name} -> {dst} [{mode}]")

    extra = {"correctionPatch": patch} if patch else {}
    s.provenance(
        action="filter", operation=operation, amount=amount, inputCount=len(volumes),
        modes=modes, outputs={"filtered_volumes": [f"{out.name}/{n}" for n in written]}, **extra,
    )
    s.log(f"wrote {len(written)} volume(s) to {out}")
    return {
        "operation": operation, "amount": amount, "count": len(written), "modes": modes, **extra,
    }
