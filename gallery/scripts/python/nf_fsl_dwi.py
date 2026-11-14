"""NeuroFlow gallery tools: fsl-topup and fsl-eddy.

Susceptibility and eddy-current correction of a diffusion series with FSL.

``topup`` takes the b0 volumes of the main DWI series and of a short series
acquired with the opposite phase encoding, writes ``acqparams.txt`` from the
dcm2niix sidecars (PhaseEncodingDirection, TotalReadoutTime), runs FSL topup,
and writes the field coefficients, the corrected b0s, their mean and a brain
mask (FSL bet) on the DWI grid.

``eddy`` corrects the whole series for eddy currents and head motion with FSL
eddy, using the topup field when it is given, and writes the corrected series
with its rotated gradient table so it can go straight to dti-fit.

FSL is found from FSLDIR, else ~/fsl, /usr/local/fsl or /opt/fsl. ``eddy`` is
FSL's own dispatcher, which prefers eddy_metal on Apple silicon, then CUDA,
then eddy_cpu.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import nibabel as nib
import numpy as np

from neuroflow import session

PE_AXES = {"i": (1, 0, 0), "j": (0, 1, 0), "k": (0, 0, 1)}
ENGINES = ("auto", "metal", "cpu")


# -- FSL --------------------------------------------------------------------------

def fsl_dir() -> Path:
    candidates = [os.environ.get("FSLDIR"), "~/fsl", "/usr/local/fsl", "/opt/fsl"]
    for c in candidates:
        if c and (Path(c).expanduser() / "bin" / "topup").exists():
            return Path(c).expanduser()
    raise FileNotFoundError(
        "FSL was not found (looked at FSLDIR, ~/fsl, /usr/local/fsl, /opt/fsl); "
        "install FSL 6.0.6 or newer or set FSLDIR")


def fsl_env(fsldir: Path) -> dict:
    env = dict(os.environ)
    env["FSLDIR"] = str(fsldir)
    env["FSLOUTPUTTYPE"] = "NIFTI_GZ"
    extra = [str(fsldir / "share" / "fsl" / "bin"), str(fsldir / "bin")]
    env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
    # Python adapters pin these to 1; FSL's own binaries should use the machine.
    for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env.pop(v, None)
    return env


def run_fsl(s, fsldir: Path, args: list[str], cwd: Path) -> None:
    exe = args[0] if os.path.isabs(args[0]) else str(fsldir / "bin" / args[0])
    s.log("running", " ".join([Path(exe).name] + [str(a) for a in args[1:]]))
    r = subprocess.run([exe] + [str(a) for a in args[1:]], cwd=cwd, env=fsl_env(fsldir))
    if r.returncode != 0:
        raise RuntimeError(f"{Path(exe).name} exited with status {r.returncode}")


# -- inputs -----------------------------------------------------------------------

def stem(path: Path) -> Path:
    name = path.name
    for ext in (".nii.gz", ".nii"):
        if name.endswith(ext):
            return path.with_name(name[: -len(ext)])
    return path.with_suffix("")


def sibling(path: Path, suffix: str) -> Path | None:
    p = stem(path).with_name(stem(path).name + suffix)
    return p if p.is_file() else None


def read_bvals(gradients: Path | None, volume: Path, n: int) -> np.ndarray:
    """b-values from a .bval/.bvec path (or the volume's own .bval sibling)."""
    bval = None
    if gradients:
        g = Path(gradients)
        bval = g if g.suffix in (".bval", ".bvals") else stem(g).with_suffix(".bval")
        if not bval.is_file():
            bval = Path(str(g)[: -len(g.suffix)] + ".bval")
    else:
        bval = sibling(volume, ".bval")
    if bval is None or not bval.is_file():
        return np.zeros(n)  # no table: every volume is a b0
    b = np.loadtxt(bval, ndmin=1).astype(float).ravel()
    if len(b) != n:
        raise ValueError(f"{bval.name} has {len(b)} b-values but {volume.name} has {n} volumes")
    return b


def bvec_path(gradients: Path) -> Path:
    g = Path(gradients)
    for cand in (g.with_suffix(".bvec"), g.with_suffix(".bvecs"), g):
        if cand.is_file() and cand.suffix in (".bvec", ".bvecs"):
            return cand
    raise FileNotFoundError(f"no .bvec beside {g.name}")


def acq_row(volume: Path, readout_time: float | None) -> list[float]:
    side = sibling(volume, ".json")
    if side is None:
        raise FileNotFoundError(f"{volume.name} has no JSON sidecar to read PhaseEncodingDirection from")
    meta = json.loads(side.read_text())
    pe = meta.get("PhaseEncodingDirection")
    if not pe or pe[0] not in PE_AXES:
        raise ValueError(f"{side.name} has no usable PhaseEncodingDirection ({pe!r})")
    trt = readout_time if readout_time else meta.get("TotalReadoutTime")
    if not trt:
        raise ValueError(f"{side.name} has no TotalReadoutTime; pass readout_time")
    sign = -1 if pe.endswith("-") else 1
    return [sign * c for c in PE_AXES[pe[0]]] + [float(trt)]


def pick(indices: np.ndarray, k: int) -> np.ndarray:
    if k <= 0 or len(indices) <= k:
        return indices
    return indices[np.round(np.linspace(0, len(indices) - 1, k)).astype(int)]


def fmt_row(r: list[float]) -> str:
    return " ".join(f"{v:g}" for v in r)


# -- topup ------------------------------------------------------------------------

def topup(dwi: Path, gradients: Path, reverse: Path, reverse_gradients: Path | None = None,
          b0_threshold: float = 50.0, max_b0: int = 3, readout_time: float | None = None) -> dict:
    s = session()
    fsldir = fsl_dir()
    b0_threshold = 50.0 if b0_threshold is None else float(b0_threshold)
    max_b0 = 3 if max_b0 is None else int(max_b0)

    main = nib.load(str(dwi))
    rev = nib.load(str(reverse))
    if main.shape[:3] != rev.shape[:3]:
        raise ValueError(f"dwi grid {main.shape[:3]} and reverse grid {rev.shape[:3]} differ")
    nmain = main.shape[3] if main.ndim == 4 else 1
    nrev = rev.shape[3] if rev.ndim == 4 else 1
    main_b0 = np.flatnonzero(read_bvals(gradients, Path(dwi), nmain) <= b0_threshold)
    rev_b0 = np.flatnonzero(read_bvals(reverse_gradients, Path(reverse), nrev) <= b0_threshold)
    if not len(main_b0) or not len(rev_b0):
        raise ValueError("both series need at least one b0 volume")
    main_b0, rev_b0 = pick(main_b0, max_b0), pick(rev_b0, max_b0)

    row_main = acq_row(Path(dwi), readout_time)
    row_rev = acq_row(Path(reverse), readout_time)
    if row_main[:3] != [-v for v in row_rev[:3]]:
        raise ValueError(f"the two series are not opposite phase encodings: {row_main[:3]} vs {row_rev[:3]}")

    def frames(img, idx):
        data = np.asarray(img.dataobj, dtype=np.float32)
        return data[..., idx] if data.ndim == 4 else data[..., None]

    b0s = np.concatenate([frames(main, main_b0), frames(rev, rev_b0)], axis=3)
    w = s.work_dir
    nib.save(nib.Nifti1Image(b0s, main.affine, main.header), str(w / "b0_pair.nii.gz"))
    acqp = s.output_path("acqparams")
    acqp.write_text("\n".join([fmt_row(row_main)] * len(main_b0) + [fmt_row(row_rev)] * len(rev_b0)) + "\n")

    # b02b0.cnf subsamples by 2; an odd dimension needs the unsubsampled config.
    odd = any(d % 2 for d in main.shape[:3])
    cnf = "b02b0_1.cnf" if odd else "b02b0.cnf"
    s.log(f"{len(main_b0)} b0 from dwi ({fmt_row(row_main)}), {len(rev_b0)} from reverse "
          f"({fmt_row(row_rev)}), config {cnf}")

    out = s.output_dir
    run_fsl(s, fsldir, ["topup", f"--imain={w / 'b0_pair.nii.gz'}", f"--datain={acqp}",
                        f"--config={cnf}", f"--out={out / 'topup'}",
                        f"--iout={out / 'b0_corrected'}", f"--fout={out / 'field_hz'}"], w)
    run_fsl(s, fsldir, ["fslmaths", out / "b0_corrected", "-Tmean", out / "b0_corrected_mean"], w)
    run_fsl(s, fsldir, ["bet", out / "b0_corrected_mean", w / "b0_brain", "-m", "-n", "-f", "0.2"], w)
    shutil.move(str(w / "b0_brain_mask.nii.gz"), str(s.output_path("brain_mask")))

    field = np.asarray(nib.load(str(out / "field_hz.nii.gz")).dataobj, dtype=np.float32)
    mask = np.asarray(nib.load(str(s.output_path("brain_mask"))).dataobj) > 0
    movpar = np.loadtxt(out / "topup_movpar.txt", ndmin=2)
    return {
        "b0_dwi": int(len(main_b0)),
        "b0_reverse": int(len(rev_b0)),
        "phase_encoding": {"dwi": row_main[:3], "reverse": row_rev[:3]},
        "readout_time_s": row_main[3],
        "config": cnf,
        "field_hz_in_mask": {
            "p01": float(np.percentile(field[mask], 1)),
            "median": float(np.median(field[mask])),
            "p99": float(np.percentile(field[mask], 99)),
        },
        "brain_mask_ml": float(mask.sum() * np.prod(main.header.get_zooms()[:3]) / 1000),
        "max_translation_mm": float(np.abs(movpar[:, :3]).max()),
    }


# -- eddy -------------------------------------------------------------------------

def eddy(dwi: Path, gradients: Path, mask: Path, topup_fieldcoef: Path | None = None,
         acqparams: Path | None = None, engine: str = "auto", repol: bool = True,
         readout_time: float | None = None) -> dict:
    s = session()
    fsldir = fsl_dir()
    engine = str(engine or "auto").lower()
    if engine not in ENGINES:
        raise ValueError(f"unknown engine {engine!r} (one of {', '.join(ENGINES)})")
    repol = True if repol is None else bool(repol)

    img = nib.load(str(dwi))
    if img.ndim != 4:
        raise ValueError(f"dwi must be 4-D, got {img.shape}")
    n = img.shape[3]
    bvals = read_bvals(gradients, Path(dwi), n)
    bvec = bvec_path(gradients)
    if nib.load(str(mask)).shape[:3] != img.shape[:3]:
        raise ValueError("mask is not on the dwi grid")

    w = s.work_dir
    row = acq_row(Path(dwi), readout_time)
    if topup_fieldcoef:
        if not acqparams:
            raise ValueError("topup_fieldcoef needs the acqparams file from the same topup run")
        fc = Path(topup_fieldcoef)
        if not fc.name.endswith("_fieldcoef.nii.gz"):
            raise ValueError(f"{fc.name} is not a topup *_fieldcoef.nii.gz")
        base = fc.with_name(fc.name[: -len("_fieldcoef.nii.gz")])
        if not Path(str(base) + "_movpar.txt").is_file():
            raise FileNotFoundError(f"{base.name}_movpar.txt is missing beside {fc.name}")
        rows = [r.split() for r in Path(acqparams).read_text().splitlines() if r.strip()]
        try:
            index = next(i for i, r in enumerate(rows, 1) if [float(v) for v in r[:3]] == row[:3])
        except StopIteration:
            raise ValueError(f"no row of {Path(acqparams).name} matches the dwi phase encoding {row[:3]}")
        acqp = Path(acqparams)
    else:
        base, index = None, 1
        acqp = w / "acqparams.txt"
        acqp.write_text(fmt_row(row) + "\n")
    (w / "index.txt").write_text(" ".join([str(index)] * n) + "\n")

    shells = sorted({int(round(b / 100.0) * 100) for b in bvals if b > 50})
    exe = {"auto": "eddy", "metal": "eddy_metal", "cpu": "eddy_cpu"}[engine]
    out = w / "eddy"
    args = [exe, f"--imain={dwi}", f"--mask={mask}", f"--acqp={acqp}", f"--index={w / 'index.txt'}",
            f"--bvecs={bvec}", f"--bvals={w / 'bvals.txt'}", f"--out={out}", "--verbose"]
    np.savetxt(w / "bvals.txt", bvals[None, :], fmt="%g")
    if base is not None:
        args.append(f"--topup={base}")
    if repol:
        args.append("--repol")
    if len(shells) > 1:
        args.append("--data_is_shelled")
    s.log(f"{n} volumes, shells {shells}, acqp row {index}, engine {engine}, topup {'yes' if base else 'no'}")
    run_fsl(s, fsldir, args, w)

    shutil.move(str(w / "eddy.nii.gz"), str(s.output_path("dwi")))
    shutil.copy(str(w / "eddy.eddy_rotated_bvecs"), str(s.output_path("bvec")))
    np.savetxt(s.output_path("gradients"), bvals[None, :], fmt="%g")
    for extra in ("eddy.eddy_movement_rms", "eddy.eddy_outlier_map", "eddy.eddy_parameters"):
        if (w / extra).is_file():
            shutil.copy(str(w / extra), str(s.output_dir / extra))

    summary = {"volumes": n, "shells": shells, "topup": base is not None, "engine": engine, "repol": repol}
    rms = w / "eddy.eddy_movement_rms"
    if rms.is_file():
        m = np.loadtxt(rms, ndmin=2)
        summary["movement_rms_mm"] = {"abs_mean": float(m[:, 0].mean()), "rel_mean": float(m[:, 1].mean()),
                                      "abs_max": float(m[:, 0].max())}
    om = w / "eddy.eddy_outlier_map"
    if om.is_file():
        o = np.loadtxt(om, skiprows=1, ndmin=2)
        summary["outlier_slices"] = int(o.sum())
    return summary
