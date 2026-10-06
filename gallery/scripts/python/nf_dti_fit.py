"""NeuroFlow gallery tool: dti-fit.

Fits a diffusion tensor to a 4-D DWI series with DIPY and writes fractional
anisotropy (FA) and mean diffusivity (MD) maps, plus an inline summary of both
within the mask. The first DIPY consumer of the Python adapter: DIPY is not in
a default environment, so ``python_tool.mjs`` reports the missing package with
its fix before this module is ever imported.

Gradient table (``neuro:gradient-table``) formats accepted, resolved by file:
  * an FSL ``.bval`` file (its ``.bvec`` sibling with the same stem is read too),
  * an FSL ``.bvec`` file (its ``.bval`` sibling likewise),
  * a single text table with one row per volume: ``x y z b`` (MRtrix ``.b``) or
    ``b x y z`` when the first column is clearly the b-value.
"""
from __future__ import annotations

from pathlib import Path

import nibabel as nib
import numpy as np
from dipy.core.gradients import gradient_table
from dipy.io.gradients import read_bvals_bvecs
from dipy.reconst.dti import TensorModel

from neuroflow import session

FIT_METHODS = ("WLS", "OLS", "NLLS", "RESTORE")


def load_gradients(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (bvals[N], bvecs[N, 3]) from one of the accepted table layouts."""
    suffix = path.suffix.lower()
    if suffix in (".bval", ".bvals", ".bvec", ".bvecs"):
        stem = path.with_suffix("")
        bval = next((p for p in (stem.with_suffix(".bval"), stem.with_suffix(".bvals")) if p.is_file()), None)
        bvec = next((p for p in (stem.with_suffix(".bvec"), stem.with_suffix(".bvecs")) if p.is_file()), None)
        if bval is None or bvec is None:
            raise FileNotFoundError(f"gradient table {path.name} needs both {stem.name}.bval and {stem.name}.bvec next to each other")
        bvals, bvecs = read_bvals_bvecs(str(bval), str(bvec))
        return np.asarray(bvals, dtype=float), np.asarray(bvecs, dtype=float)
    table = np.loadtxt(path, comments=("#", "%"), ndmin=2)
    if table.shape[1] != 4 and table.shape[0] == 4:
        table = table.T
    if table.shape[1] != 4:
        raise ValueError(f"gradient table {path.name} must have 4 columns (x y z b), got shape {table.shape}")
    # MRtrix puts b last; a b-first layout shows up as a first column far outside [-1, 1].
    if np.abs(table[:, 0]).max() > 1.5 and np.abs(table[:, 3]).max() <= 1.5:
        table = table[:, [1, 2, 3, 0]]
    return table[:, 3].astype(float), table[:, :3].astype(float)


def run(dwi: Path, gradients: Path, mask: Path | None = None, fit_method: str = "WLS",
        b0_threshold: float = 50.0) -> dict:
    s = session()
    fit_method = str(fit_method or "WLS").upper()
    b0_threshold = 50.0 if b0_threshold is None else float(b0_threshold)
    if fit_method not in FIT_METHODS:
        raise ValueError(f"unknown fit_method {fit_method!r} (one of {', '.join(FIT_METHODS)})")

    img = nib.load(str(dwi))
    data = np.asarray(img.dataobj, dtype=np.float32)
    if data.ndim != 4:
        raise ValueError(f"dwi must be a 4-D series, got {data.ndim}-D {img.shape}")
    bvals, bvecs = load_gradients(Path(gradients))
    if len(bvals) != data.shape[3]:
        raise ValueError(f"gradient table has {len(bvals)} entries but dwi has {data.shape[3]} volumes")
    if not (bvals <= b0_threshold).any():
        raise ValueError(f"no b0 volume: every b-value is above b0_threshold={b0_threshold:g}")
    gtab = gradient_table(bvals, bvecs=bvecs, b0_threshold=b0_threshold)

    if mask:
        mimg = nib.load(str(mask))
        if mimg.shape[:3] != img.shape[:3]:
            raise ValueError(f"mask shape {mimg.shape[:3]} does not match dwi {img.shape[:3]}")
        mask_arr = np.asarray(mimg.dataobj) > 0
    else:
        mask_arr = data[..., gtab.b0s_mask].mean(axis=3) > 0

    s.log(f"fitting {fit_method} tensor in {int(mask_arr.sum())} voxels, "
          f"{int((~gtab.b0s_mask).sum())} directions, {int(gtab.b0s_mask.sum())} b0")
    fit = TensorModel(gtab, fit_method=fit_method).fit(data, mask=mask_arr)
    fa = np.nan_to_num(fit.fa, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)
    md = np.nan_to_num(fit.md, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)
    fa[~mask_arr] = 0
    md[~mask_arr] = 0

    header = img.header.copy()
    header.set_data_dtype(np.float32)
    for name, arr in (("fa", fa), ("md", md)):
        out = nib.Nifti1Image(arr, img.affine, header)
        out.header.set_intent("estimate", name=name.upper())
        nib.save(out, str(s.output_path(name)))

    inside = mask_arr & np.isfinite(fit.fa)
    shells = sorted({int(round(b / 50.0) * 50) for b in bvals[~gtab.b0s_mask]})
    summary = {
        "fit_method": fit_method,
        "voxels": int(inside.sum()),
        "directions": int((~gtab.b0s_mask).sum()),
        "b0_volumes": int(gtab.b0s_mask.sum()),
        "shells": shells,
        "fa": {"mean": float(fa[inside].mean()), "median": float(np.median(fa[inside]))} if inside.any() else None,
        "md": {"mean": float(md[inside].mean()), "median": float(np.median(md[inside]))} if inside.any() else None,
        "md_units": "mm^2/s (as the b-values' units imply)",
    }
    s.log(f"FA mean {summary['fa']['mean']:.3f}, MD mean {summary['md']['mean']:.3e}" if inside.any() else "no voxels fitted")
    return summary
