The workflow ran to completion and every requested number comes from the run outputs.

**Results** (run `run-20260928T154101Z-152f`)

| Quantity | Value |
|---|---|
| Left hippocampus | 4.747 mL (4747 voxels) |
| Right hippocampus | 4.845 mL (4845 voxels) |
| Brain-mask volume (mindgrab mask) | 1592.272 mL |
| Registration cost function | `hel+cr` (the `fast` preset, engine `coreg_fast`, 12 DOF) |
| Brain in MNI space | `neuroflow://runs/run-20260928T154101Z-152f/artifacts/register/transform` is the transform; the image is `neuroflow://runs/run-20260928T154101Z-152f/artifacts/register/registered` |

The registered brain sits on the template grid: 182 x 218 x 182 voxels at 1 mm, LAS orientation, matching the MNI152 template. The SynthSeg label map covered 32 structures with a labeled total of 1600.359 mL. The DICOM sidecar confirms the input is a Siemens MAGNETOM Vida 3T MPRAGE T1w series.

**How the workflow is composed**

- `convert` runs dcm2niix on the DICOM folder to produce the full-head NIfTI and sidecar.
- `strip` runs mindgrab on that volume to get the skull-stripped brain and binary mask.
- `register` feeds the stripped brain and your skull-stripped MNI template to niimath -allineate with cubic resampling.
- `segment` runs SynthSeg on the native full-head T1, because that tool's contract expects an unstripped image. Volumes are therefore measured in native space, not scaled by the affine.
- `volumes` runs label-volumes on the SynthSeg labels with the mindgrab mask so the brain-mask volume is reported alongside the structures.

Two validation passes failed before the third succeeded. Literal step inputs must be bindings with a single `constant` key, not bare values or `value` objects. Pre-built gallery workflows were not run. I only read one to learn the document syntax.

**Workflow document as run**

```json
{
  "neuroflow": "0.1.0",
  "kind": "workflow",
  "id": "chrisdrake.local/t1-dicom-mni-structure-volumes",
  "version": "0.1.0",
  "description": "DICOM T1 series to NIfTI (dcm2niix), skull-strip (mindgrab), affine registration of the stripped brain to a skull-stripped MNI152 template (niimath -allineate), SynthSeg whole-brain segmentation of the native full-head T1, and per-structure volumes in mL plus the brain-mask volume.",
  "inputs": {
    "dicom_dir": { "type": "neuro:dicom-folder", "description": "Folder holding one T1-weighted DICOM series." },
    "template": { "type": "neuro:volume", "description": "Skull-stripped MNI152 T1 template (fixed image for the affine registration)." },
    "cost": { "type": "core:string", "description": "niimath -allineate cost function.", "optional": true, "default": "fast",
              "enum": ["fast", "fastx", "fasthel", "fastcr", "hel", "nmi", "lpc", "lpa", "ls"] },
    "mode": { "type": "core:string", "description": "SynthSeg mode.", "optional": true, "default": "default", "enum": ["default", "fast"] }
  },
  "steps": {
    "convert": {
      "tool": "neuroflow.gallery.tools/dcm2niix", "stage": "ingest",
      "inputs": { "dicom_dir": { "ref": "inputs.dicom_dir" }, "anonymize": { "constant": true } }
    },
    "strip": {
      "tool": "neuroflow.gallery.tools/mindgrab", "stage": "explore",
      "inputs": { "t1": { "ref": "steps.convert.outputs.volume" }, "border": { "constant": 0 } }
    },
    "register": {
      "tool": "neuroflow.gallery.tools/niimath-allineate", "stage": "explore",
      "inputs": {
        "moving": { "ref": "steps.strip.outputs.brain" },
        "template": { "ref": "inputs.template" },
        "cost": { "ref": "inputs.cost" },
        "interpolation": { "constant": "cubic" }
      }
    },
    "segment": {
      "tool": "neurodesk.webapps/synthseg", "stage": "explore",
      "inputs": { "t1": { "ref": "steps.convert.outputs.volume" }, "mode": { "ref": "inputs.mode" } }
    },
    "volumes": {
      "tool": "neuroflow.gallery.tools/label-volumes", "stage": "publish",
      "inputs": { "labels": { "ref": "steps.segment.outputs.labels" }, "mask": { "ref": "steps.strip.outputs.brain_mask" } }
    }
  },
  "outputs": {
    "t1":         { "type": "neuro:volume",    "ref": "steps.convert.outputs.volume" },
    "sidecar":    { "type": "core:json",       "ref": "steps.convert.outputs.sidecar" },
    "brain":      { "type": "neuro:volume",    "ref": "steps.strip.outputs.brain" },
    "brain_mask": { "type": "neuro:mask",      "ref": "steps.strip.outputs.brain_mask" },
    "brain_mni":  { "type": "neuro:volume",    "ref": "steps.register.outputs.registered" },
    "to_mni":     { "type": "neuro:transform", "ref": "steps.register.outputs.transform" },
    "labels":     { "type": "neuro:label-map", "ref": "steps.segment.outputs.labels" },
    "volumes":    { "type": "core:tabular",    "ref": "steps.volumes.outputs.volumes" },
    "table":      { "type": "core:json",       "ref": "steps.volumes.outputs.table" }
  }
}
```

Run inputs were your DICOM folder, your MNI template, `cost` = `fast`, and `mode` = `default`. Full per-structure volumes are in the TSV at `neuroflow://runs/run-20260928T154101Z-152f/artifacts/volumes/volumes`, and the provenance record is at `neuroflow://runs/run-20260928T154101Z-152f/provenance`.
