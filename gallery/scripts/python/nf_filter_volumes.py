"""NeuroFlow gallery tool: python-volume-filter.

Filters the NIfTI volumes of a BIDS dataset (Gaussian smoothing, intensity
threshold, z-score, or passthrough) into the step's ``filtered/`` output
directory. Run by ``python_tool.mjs`` as a function entry; the adapter has
already checked that NiBabel and NumPy import before this module is loaded, so
a missing package is reported with its fix instead of being papered over.

A volume that cannot be read as NIfTI is copied through unchanged and logged:
that is a data problem a user can see in the output, not an environment one.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import nibabel as nib
import numpy as np

from neuroflow import session

FWHM_TO_SIGMA = 1.0 / 2.354820045


def find_volumes(bids_dir: Path) -> list[Path]:
    vols: list[Path] = []
    for pat in ("*.nii", "*.nii.gz"):
        vols.extend(bids_dir.rglob(pat))
    return sorted(v for v in vols if v.is_file())


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
        data = gaussian_smooth(data, sigma)
    elif operation != "passthrough":
        raise ValueError(f"unknown operation {operation!r} (smooth | threshold | zscore | passthrough)")

    out = nib.Nifti1Image(data, img.affine, img.header)
    if operation != "passthrough":
        # Filtered values are fractional; do not round them back into the input's integer datatype.
        out.set_data_dtype(np.float32)
    nib.save(out, str(dst))
    return operation


def run(bids_dir: Path, operation: str = "smooth", amount: float = 3.0) -> dict:
    s = session()
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

    s.provenance(
        action="filter", operation=operation, amount=amount, inputCount=len(volumes),
        modes=modes, outputs={"filtered_volumes": [f"{out.name}/{n}" for n in written]},
    )
    s.log(f"wrote {len(written)} volume(s) to {out}")
    return {"operation": operation, "amount": amount, "count": len(written), "modes": modes}
