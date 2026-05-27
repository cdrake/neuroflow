# BIDSvue, NeuroVue, and NeuroFlow Integration

Status: planning

## Goal

The user should experience BIDS import, volume review, correction, and final
study export as one workflow even when different apps own different parts of the
process.

- BIDSvue owns DICOM import, BIDS dataset mutation, metadata repair, and
  dataset-level validation.
- NeuroVue owns interactive visual review, local volume edits, masks, ROIs,
  drawings, and figure-oriented scene state.
- NeuroFlow owns orchestration, typed context, tool resolution, session launch,
  and provenance.

This keeps dataset mutation explicit while still letting users move naturally
between import, review, correction, and publication preparation.

## User Loop

1. BIDSvue imports DICOM into NIfTI/BIDS with bundled or resolved import tools.
2. NeuroFlow records the import inputs, resolved binaries, output files, and
   BIDS sidecars in provenance.
3. NeuroVue opens selected outputs for review through a NeuroFlow app session.
4. NeuroVue stores interactive work in an NVDocument-compatible working state:
   ROI selections, masks, drawings, clip planes, camera state, view layout, and
   candidate edit patches.
5. If the user finds a dataset problem, NeuroVue writes a small correction patch
   and NeuroFlow routes the user back to the BIDSvue-owned correction tool.
6. BIDSvue applies approved dataset changes, such as metadata edits, volume
   removal, defacing repair, or derivative regeneration.
7. NeuroFlow appends every transition and mutation to the provenance document.
8. NeuroVue can reopen the updated dataset state without losing review context.

## Connector Shape

The first connector should be file-based because it is inspectable, debuggable,
and works across separately packaged desktop apps.

Suggested session directory:

```text
neuroflow-session/
  context.json
  commands.jsonl
  events.jsonl
  provenance.jsonl
  outputs/
    neurovue.review.nvd
    neurovue.correction.patch.json
    figures/
```

`context.json` contains resolved artifact paths, selected BIDS entities, tool
versions, and launch intent. `commands.jsonl` is reserved for simple app-to-app
handoff requests. `events.jsonl` records live UI/session events. The durable
audit trail is `provenance.jsonl`.

A loopback TCP or WebSocket bridge can be added later for live status updates,
but it should mirror the same message schema and persist the same provenance.

## NVDocument Role

The NVDocument is a working document, not the final study product. It is the
right place for interactive state that must survive review sessions:

- viewer layout
- loaded volumes, meshes, overlays, and colormaps
- ROIs, drawings, masks, and edit candidates
- camera and clip-plane state
- annotations and figure staging state

The final study product is a set of BIDS/derivatives files, metrics, figures,
reports, and provenance. NeuroFlow should treat NVD files as resumable working
state that can be promoted into outputs only through explicit export steps.

## niimath Role

`niimath` should be exposed as deterministic task tools, not as a free-form
terminal in the UI. NeuroVue can present domain-oriented edit actions such as
threshold, binarize, mask, smooth, crop, arithmetic combine, and defacing repair
preview. NeuroFlow resolves and executes the underlying tool adapter, captures
the concrete argv and binary provenance, and returns the resulting NIfTI files
to NeuroVue for review.

The packaging model should follow the BIDSvue and NiiVue Desktop pattern:

- logical tool id in the NeuroFlow contract
- fixed sidecar or resolved executable at run time
- structured inputs converted to validated argv
- no shell string construction
- captured stdout, stderr, exit status, hashes, and output artifacts

NeuroVue can bundle or fetch a `niimath` sidecar for local edit previews, but
the provenance boundary remains in NeuroFlow.

## Figure and Publication Output

A publication figure should be a separate export product composed from the NVD,
timing/series data, charts, volume panels, and provenance-backed captions. The
export should be reproducible:

- source volumes and masks
- transform/edit provenance
- chart data and statistical summaries
- render settings
- generated SVG/PNG/PDF outputs

This keeps NVD useful as an editable scene while making the figure/report the
shareable final artifact.

## Immediate Implementation Notes

- Keep planning and registry policy in NeuroFlow docs and contracts.
- Keep NeuroVue implementation in the NeuroVue repo.
- Use NiiVue Desktop's `ensure-niimath` script as the model for local sidecar
  acquisition.
- Prefer file-session handoff first, then add live IPC when the message schema
  has settled.
