The inline workflow validated with **zero diagnostics** and completed as run `run-20261022T140531Z-ac00`.

| Result | Value |
|---|---:|
| Left hippocampus | 4.747 mL |
| Right hippocampus | 4.845 mL |
| Brain mask | 1,592.272 mL |

The registration used the `fast` setting; its saved transform reports the cost function as **`hel+cr`**. The brain in MNI space is at `neuroflow://runs/run-20261022T140531Z-ac00/artifacts/register/registered`.

The workflow segments the converted full-head T1, as required by SynthSeg’s input contract, while registering the skull-stripped brain. It measured every structure in the resulting label map; the full table is at `neuroflow://runs/run-20261022T140531Z-ac00/artifacts/measure/volumes`.

```json
{
  "neuroflow": "0.1.0",
  "kind": "workflow",
  "id": "analyst/dicom-t1-affine-segmentation-volumes",
  "version": "0.1.0",
  "description": "Convert a T1 DICOM series, extract the brain, align it affinely to MNI152, segment the native T1, and measure structure and brain-mask volumes.",
  "inputs": {
    "dicom_dir": { "type": "neuro:dicom-folder" },
    "template": { "type": "neuro:volume" }
  },
  "steps": {
    "convert": {
      "tool": "neuroflow.gallery.tools/dcm2niix",
      "stage": "ingest",
      "inputs": {
        "dicom_dir": { "ref": "inputs.dicom_dir" },
        "anonymize": { "constant": true }
      }
    },
    "strip": {
      "tool": "neuroflow.gallery.tools/mindgrab",
      "stage": "explore",
      "inputs": {
        "t1": { "ref": "steps.convert.outputs.volume" },
        "border": { "constant": 0 }
      }
    },
    "register": {
      "tool": "neuroflow.gallery.tools/niimath-allineate",
      "stage": "explore",
      "inputs": {
        "moving": { "ref": "steps.strip.outputs.brain" },
        "template": { "ref": "inputs.template" },
        "cost": { "constant": "fast" },
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
    "measure": {
      "tool": "neuroflow.gallery.tools/label-volumes",
      "stage": "publish",
      "inputs": {
        "labels": { "ref": "steps.segment.outputs.labels" },
        "mask": { "ref": "steps.strip.outputs.brain_mask" }
      }
    }
  },
  "outputs": {
    "brain_mni": {
      "type": "neuro:volume",
      "ref": "steps.register.outputs.registered"
    },
    "transform": {
      "type": "neuro:transform",
      "ref": "steps.register.outputs.transform"
    },
    "labels": {
      "type": "neuro:label-map",
      "ref": "steps.segment.outputs.labels"
    },
    "volumes": {
      "type": "core:tabular",
      "ref": "steps.measure.outputs.volumes"
    },
    "table": {
      "type": "core:json",
      "ref": "steps.measure.outputs.table"
    }
  }
}
```

Run inputs were `~/Data/DICOMs/5_anat-T1w` and `~/Data/templates/MNI152_T1_1mm_brain.nii.gz`. Provenance: `neuroflow://runs/run-20261022T140531Z-ac00/provenance`.

