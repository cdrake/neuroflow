# Workflow Stages

The **stage** model (Ingest / Explore / Publish) is defined normatively in the
NeuroFlow specification, not here. See:

- Specification §27 "Workflow Stages" — `../neuroflow-spec/spec/neuroflow-0.1.md`
- Schema: `workflowStage` in `../neuroflow-spec/schemas/0.1/common.schema.json`
  (referenced by `stepDef.stage` in `workflow.schema.json` and `block.stage` in
  `extensions/niivue-ui.schema.json`)

This document records only how **this app** implements that contract.

## Summary

Stages are an informal, opt-in grouping for tool discovery ("show me the Ingest
tools"). They are not load-bearing — nothing in the runtime branches on a stage.
The reference adapters (BIDSvue for ingest, NeuroVue for explore) are defaults,
not requirements; any tool, including custom ones, may be tagged into any stage.

| Stage | Intent | Reference adapter |
|---------|--------------------------------------------------|---------------------|
| `ingest` | Bring data in and shape it into a dataset | BIDSvue / bidsui |
| `explore` | Review, correct, and process artifacts | NeuroVue |
| `publish` | Compose figures, captions, graphs, and reports | (composer, TBD) |

## App implementation notes

- **Types** — `WorkflowStage`, `WORKFLOW_STAGES`, and the optional `stage` on
  `BlockDef` and `StepDef` live in `src/domain/neuroflow.ts`. The app's
  `BlockDef` corresponds to the spec's `extensions["niivue/ui"].block`.
- **Discovery** — `src/components/ToolPalette.tsx` filters and groups the
  registry by stage; untagged tools group under **Other**.
- **Validation** — `crates/neuroflow-core` treats an unrecognized step `stage`
  as a non-fatal **warning** (the document stays valid), consistent with the
  spec's lenient-validation allowance in §27.5.

## Reference

The explanatory slide deck is `docs/stages.slides.md`
(`npm run slides` to present).
