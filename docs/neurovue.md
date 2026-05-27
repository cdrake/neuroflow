# NeuroVue

Status: external app boundary

NeuroVue should live as its own application and repository. NeuroFlow should
not own the dataset viewer surface; it should launch NeuroVue as an external
workflow app session, hand it declared artifacts, and wait for declared outputs.

NeuroVue is intentionally scoped to preview and small correction work for
previous step outputs. It should not own workflow orchestration, scheduling,
registry resolution, packaging policy, or pipeline execution.

## Reference Implementation

The initial viewer is modeled on:

- `/Users/chrisdrake/Dev/mono/apps/iiif-volumetric-demo/osd-volume-desktop.html`
- `/Users/chrisdrake/Dev/mono/apps/iiif-volumetric-demo/src/osd-volume-desktop.ts`
- `/Users/chrisdrake/Dev/mono/apps/iiif-volumetric-demo/src/omezarr.ts`
- `/Users/chrisdrake/Dev/mono/packages/niivue/examples/vox.clip.html`

During development, NeuroFlow can launch the local reference app on
`http://127.0.0.1:8087` as a stand-in for the future NeuroVue repo. That demo
proxies the IIIF Volumetric Server and uses the in-tree `@niivue/niivue`
package from `~/Dev/mono`, including the current multiple clip-plane API:

- `setClipPlaneDepthAziElev(depth, azimuth, elevation, clipPlaneIndex)`
- `setClipPlanes([[depth, azimuth, elevation], ...])`

## Scope

NeuroVue, in its own repo, should support:

- NIfTI volume previews through IIIF `VolumeDesktop` manifests.
- OME-Zarr pyramid previews through the OME-Zarr reference viewer.
- Tract and mesh preview contracts so standalone NiiVue-backed viewers can be
  attached without changing workflow schema.
- Multiple clip planes using the same depth, azimuth, and elevation model as
  NiiVue.
- Lightweight correction patches for edits such as defacing mask repair,
  crop/clip adjustments, and landmarks.

NeuroVue should not:

- Plan or execute workflows.
- Launch arbitrary commands.
- Inspect arbitrary desktop app state.
- Store heavy derived data inside the workflow JSON.

## Workflow Contract

Previewable outputs are discovered from tool output metadata:

- `format: "nifti"`
- `format: "omezarr"`
- `format: "tract"`
- `format: "mesh"`
- types containing `neuro:volume`, `neuro:ome-zarr`, `neuro:tract`, or
  `neuro:mesh`

The `neuroflow.viewers/neurovue` registry entry models NeuroVue as an external
UI app session. It consumes resolved filesystem artifacts and may produce:

- `correction_patch`: a small JSON artifact from `uiSession` state or
  `session://neurovue/correction.patch.json`
- `review_state`: viewer state captured when the session closes

This keeps preview/correction work resumable while letting downstream steps
consume a declared JSON patch rather than a hidden viewer side effect. NeuroFlow
is responsible for packaging and launching the app session; NeuroVue is
responsible for the viewing/editing experience inside that session.
