"""NeuroFlow gallery tool: dipy-tracking.

Whole-brain deterministic tractography with DIPY. Fiber orientations come from
single-shell constrained spherical deconvolution (CSD) on the b0 volumes and
one diffusion shell (the highest by default, for the best angular contrast;
the response is estimated with auto_response_ssst). Tracking is seeded in
voxels above seed_fa, stops where FA falls below stop_fa, and keeps
streamlines at least min_length mm long. Writes the tractogram as .trk in the
DWI's world space (RAS mm), the FA map used for seeding and stopping, and an
inline summary.

Gradient table formats are those of dti-fit (FSL .bval/.bvec pair, or an
MRtrix-style table).
"""
from __future__ import annotations

import os
from pathlib import Path

import nibabel as nib
import numpy as np
from dipy.core.gradients import gradient_table
from dipy.data import default_sphere
from dipy.direction import peaks_from_model
from dipy.io.stateful_tractogram import Space, StatefulTractogram
from dipy.io.streamline import save_tractogram
from dipy.reconst.csdeconv import ConstrainedSphericalDeconvModel, auto_response_ssst
from dipy.reconst.dti import TensorModel
from dipy.tracking import utils
from dipy.tracking.local_tracking import LocalTracking
from dipy.tracking.stopping_criterion import ThresholdStoppingCriterion
from dipy.tracking.streamline import Streamlines, length

from neuroflow import session
from nf_dti_fit import load_gradients


def _shell(bvals: np.ndarray, b0_threshold: float, shell: float | None) -> float:
    dw = np.round(bvals[bvals > b0_threshold] / 100.0) * 100.0
    if dw.size == 0:
        raise ValueError("no diffusion-weighted volumes above b0_threshold")
    shells = np.unique(dw)
    if shell is None:
        return float(shells.max())
    near = shells[np.argmin(np.abs(shells - float(shell)))]
    if abs(near - float(shell)) > 100:
        raise ValueError(f"no shell near b={shell:g}; the data has {', '.join(f'{s:g}' for s in shells)}")
    return float(near)


def run(dwi: Path, gradients: Path, mask: Path | None = None, shell: float | None = None,
        sh_order: int = 8, seed_fa: float = 0.3, stop_fa: float = 0.15, seeds_per_voxel: int = 2,
        step_mm: float = 0.5, min_length: float = 20.0, b0_threshold: float = 50.0) -> dict:
    s = session()
    sh_order = 8 if sh_order is None else int(sh_order)
    seed_fa = 0.3 if seed_fa is None else float(seed_fa)
    stop_fa = 0.15 if stop_fa is None else float(stop_fa)
    seeds_per_voxel = 2 if seeds_per_voxel is None else int(seeds_per_voxel)
    step_mm = 0.5 if step_mm is None else float(step_mm)
    min_length = 20.0 if min_length is None else float(min_length)
    b0_threshold = 50.0 if b0_threshold is None else float(b0_threshold)
    if not 0 < stop_fa < seed_fa < 1:
        raise ValueError("need 0 < stop_fa < seed_fa < 1")

    img = nib.load(str(dwi))
    data = np.asarray(img.dataobj, dtype=np.float32)
    if data.ndim != 4:
        raise ValueError(f"dwi must be a 4-D series, got {img.shape}")
    bvals, bvecs = load_gradients(Path(gradients))
    if len(bvals) != data.shape[3]:
        raise ValueError(f"gradient table has {len(bvals)} entries but dwi has {data.shape[3]} volumes")
    b0 = bvals <= b0_threshold
    if not b0.any():
        raise ValueError("no b0 volume")
    if mask:
        m = nib.load(str(mask))
        if m.shape[:3] != img.shape[:3]:
            raise ValueError(f"mask shape {m.shape[:3]} does not match dwi {img.shape[:3]}")
        mask_arr = np.asarray(m.dataobj) > 0
    else:
        mask_arr = data[..., b0].mean(axis=3) > 0

    # FA from a tensor fit on the b0s and the shell nearest b=1000 (tensor's sweet spot).
    tshell = _shell(bvals, b0_threshold, 1000)
    tsel = b0 | (np.abs(bvals - tshell) <= 100)
    gt = gradient_table(bvals[tsel], bvecs=bvecs[tsel], b0_threshold=b0_threshold)
    s.log(f"tensor fit on b0 + b={tshell:g} for FA ({int(mask_arr.sum())} voxels)")
    fa = TensorModel(gt).fit(data[..., tsel], mask=mask_arr).fa
    fa = np.nan_to_num(fa).astype(np.float32)
    fa[~mask_arr] = 0

    # CSD on b0 + the chosen shell.
    cshell = _shell(bvals, b0_threshold, shell)
    csel = b0 | (np.abs(bvals - cshell) <= 100)
    gc = gradient_table(bvals[csel], bvecs=bvecs[csel], b0_threshold=b0_threshold)
    dc = data[..., csel]
    response, ratio = auto_response_ssst(gc, dc, roi_radii=10, fa_thr=0.7)
    s.log(f"CSD on b0 + b={cshell:g} ({int((~b0[csel]).sum())} directions), sh_order {sh_order}, "
          f"response eigenvalues {np.round(response[0], 6).tolist()}, ratio {ratio:.3f}")
    model = ConstrainedSphericalDeconvModel(gc, response, sh_order_max=sh_order)
    nproc = max(1, (os.cpu_count() or 2) - 1)
    peaks = peaks_from_model(model, dc, default_sphere, relative_peak_threshold=0.5,
                             min_separation_angle=25, mask=mask_arr & (fa > stop_fa),
                             return_sh=False, parallel=nproc > 1, num_processes=nproc)

    seeds = utils.seeds_from_mask(mask_arr & (fa > seed_fa), affine=img.affine,
                                  density=seeds_per_voxel)
    s.log(f"tracking from {len(seeds)} seeds (FA > {seed_fa:g}), stop at FA < {stop_fa:g}, step {step_mm:g} mm")
    stopping = ThresholdStoppingCriterion(fa, stop_fa)
    gen = LocalTracking(peaks, stopping, seeds, img.affine, step_size=step_mm)
    streamlines = Streamlines(gen)
    lengths = np.asarray(list(length(streamlines)), dtype=float)
    keep = lengths >= min_length
    streamlines = Streamlines([sl for sl, k in zip(streamlines, keep) if k])
    lengths = lengths[keep]
    if len(streamlines) == 0:
        raise RuntimeError("no streamlines survived; check the mask, FA thresholds and gradients")

    sft = StatefulTractogram(streamlines, img, Space.RASMM)
    save_tractogram(sft, str(s.output_dir / "tractogram.trk"), bbox_valid_check=False)
    nib.save(nib.Nifti1Image(fa, img.affine), str(s.output_dir / "fa.nii.gz"))
    return {
        "streamlines": int(len(streamlines)),
        "seeds": int(len(seeds)),
        "length_mm": {"mean": round(float(lengths.mean()), 1), "median": round(float(np.median(lengths)), 1),
                      "max": round(float(lengths.max()), 1)},
        "csd_shell": cshell,
        "tensor_shell_for_fa": tshell,
        "sh_order": sh_order,
        "response_ratio": round(float(ratio), 3),
        "seed_fa": seed_fa,
        "stop_fa": stop_fa,
        "step_mm": step_mm,
        "min_length_mm": min_length,
    }
