I built a five-step workflow from the registered tools, fixed the two validation errors, and ran it on your data. Run `run-20261022T140312Z-e07c` completed.

**Results (from the tool outputs):**

| Measure | Value |
|---|---|
| Left hippocampus (label 17) | **4.747 mL** (4,747 voxels) |
| Right hippocampus (label 53) | **4.845 mL** (4,845 voxels) |
| Total brain-mask volume (mindgrab) | **1592.272 mL** |
| Registration cost function | **`fast`**, which niimath reports as **`hel+cr`** (Hellinger plus correlation ratio), 12-dof affine |
| Brain in MNI space | **`neuroflow://runs/run-20261022T140312Z-e07c/artifacts/register/registered`** |

The MNI-space brain is on the template grid (182×218×182 at 1 mm, LAS), and its world matrix matches the template's (sform code 4). The 4×4 matrix is saved in the `transform` artifact; you can replay it on other images with `niimath -applymat`.

**How it's put together:**
- **Segmentation input:** SynthSeg runs on the full-head NIfTI from dcm2niix, not on the stripped brain, because the tool document says it expects a full-head image. The stripped brain goes only to registration, which matches your brain-only template.
- **Skull-stripping tool:** I used mindgrab, which runs locally through the brainchop command-line tool. Neurodesk's brain-extraction tool was the other option.
- **What the mask covers:** the brain-mask volume includes CSF inside the mask. Brain tissue alone totals 1240.882 mL, and SynthSeg's CSF label is 332.086 mL. All SynthSeg labels together total 1600.359 mL. Every structure's volume is in the `volumes` output (`volumes.tsv`).
- **Two fixes before validation passed:** fixed values must be written as `{"constant": ...}` bindings. My first two tries used a bare string and then `{"value": ...}`, and validation rejected both.

**Workflow document as run:**

```json
{
  "neuroflow": "0.1.0",
  "kind": "workflow",
  "id": "user.analysis/dicom-t1-strip-mni-synthseg-volumes",
  "version": "0.1.0",
  "description": "DICOM T1 series to NIfTI (dcm2niix), skull-strip (mindgrab), affine-register the brain to a skull-stripped MNI152 template (niimath -allineate), segment the full-head T1 with SynthSeg, and measure every structure's volume in mL plus the brain-mask volume.",
  "inputs": {
    "dicom_dir": { "type": "neuro:dicom-folder", "description": "Folder holding one T1-weighted DICOM series." },
    "template": { "type": "neuro:volume", "description": "Skull-stripped MNI152 T1 template." },
    "cost": {
      "type": "core:string",
      "description": "Registration cost function.",
      "optional": true,
      "default": "fast",
      "enum": ["fast", "fastx", "fasthel", "fastcr", "hel", "nmi", "lpc", "lpa", "ls"]
    }
  },
  "steps": {
    "convert": {
      "tool": "neuroflow.gallery.tools/dcm2niix",
      "stage": "ingest",
      "inputs": { "dicom_dir": { "ref": "inputs.dicom_dir" } }
    },
    "strip": {
      "tool": "neuroflow.gallery.tools/mindgrab",
      "stage": "explore",
      "inputs": { "t1": { "ref": "steps.convert.outputs.volume" } }
    },
    "register": {
      "tool": "neuroflow.gallery.tools/niimath-allineate",
      "stage": "explore",
      "inputs": {
        "moving": { "ref": "steps.strip.outputs.brain" },
        "template": { "ref": "inputs.template" },
        "cost": { "ref": "inputs.cost" },
        "interpolation": { "constant": "cubic" }
      }
    },
    "segment": {
      "tool": "neurodesk.webapps/synthseg",
      "stage": "explore",
      "inputs": {
        "t1": { "ref": "steps.convert.outputs.volume" },
        "mode": { "constant": "default" }
      }
    },
    "volumes": {
      "tool": "neuroflow.gallery.tools/label-volumes",
      "stage": "publish",
      "inputs": {
        "labels": { "ref": "steps.segment.outputs.labels" },
        "mask": { "ref": "steps.strip.outputs.brain_mask" }
      }
    }
  },
  "outputs": {
    "t1": { "type": "neuro:volume", "ref": "steps.convert.outputs.volume" },
    "brain": { "type": "neuro:volume", "ref": "steps.strip.outputs.brain" },
    "brain_mask": { "type": "neuro:mask", "ref": "steps.strip.outputs.brain_mask" },
    "brain_mni": { "type": "neuro:volume", "ref": "steps.register.outputs.registered" },
    "transform": { "type": "neuro:transform", "ref": "steps.register.outputs.transform" },
    "labels": { "type": "neuro:label-map", "ref": "steps.segment.outputs.labels" },
    "volumes": { "type": "core:tabular", "ref": "steps.volumes.outputs.volumes" },
    "table": { "type": "core:json", "ref": "steps.volumes.outputs.table" }
  }
}
```

Run inputs: `dicom_dir` = `~/Data/DICOMs/5_anat-T1w`, `template` = `~/Data/templates/MNI152_T1_1mm_brain.nii.gz`, `cost` = `"fast"`. The provenance record is at `neuroflow://runs/run-20261022T140312Z-e07c/provenance`.
