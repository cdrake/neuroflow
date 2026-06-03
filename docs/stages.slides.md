---
marp: true
title: NeuroFlow Stages — Ingest, Explore, Publish
description: The three-stage workflow model and the informal stage tag
paginate: true
---

# NeuroFlow Stages

### Ingest → Explore → Publish

A lightweight way to organize a neuroimaging workflow — and the tools that drive it.

<small>Status: design adopted · informal, opt-in tag</small>

---

## The three stages

| Stage | What happens | Reference adapter |
|-------|--------------|-------------------|
| **Ingest** | Bring data in, shape it into a dataset | **BIDSvue / bidsui** |
| **Explore** | Review, correct, and process artifacts | **NeuroVue** |
| **Publish** | Compose figures, captions, graphs, reports | *TBD (composer)* |

The reference adapters are **defaults, not requirements**.

---

## Reference tools are a starting point

Each stage ships with a reference implementation, but **any tool can fill any stage** — including custom ones:

- 📂 `systemOpen` — open a text file, or a browser at QA images
- 🐍 `script` — run a Python or shell script
- 🖥️ `uiApp` — launch an external app session (bidsui, neurovue)
- ⚙️ `console` / `webService` — sidecars and remote services

> Stages describe *intent*; tools describe *how*.

---

## Why a stage tag at all?

A stage is mostly a **logical grouping**. So why track it?

- ✅ **Discovery** — "show me the Ingest tools" in the palette
- ✅ **Custom tools are stage-ambiguous** — "open a file" or "run python" has no natural category; the tag is the only thing that says where it belongs

That second point is the real driver: the moment you allow custom tools, derivation-from-category breaks down.

---

## What we did *not* do

Deliberately **not** load-bearing:

- ❌ No new document type or pluggable "slots"
- ❌ No three linked workflow files
- ❌ Nothing in the runtime branches on a stage
- ❌ No forced classification — untagged tools group under **Other**

> One nullable field, not a layer. Fully reversible.

---

## The contract

```ts
export type WorkflowStage = 'ingest' | 'explore' | 'publish'

export interface BlockDef {
  // ...
  category: 'Import' | 'Processing' | 'Quality' | 'Output'
  stage?: WorkflowStage   // ← opt-in discovery tag
}

export interface StepDef {
  tool: string
  stage?: WorkflowStage   // ← a placed/custom step can carry one
  // ...
}
```

`category` = what kind of work · `stage` = where it lives in the flow.

---

## Where it shows up

The **Tool Palette** is the payoff:

- A stage filter: `All stages · Ingest · Explore · Publish`
- Tools grouped by stage, with **Other** for untagged
- Reference tools pre-tagged in the sample registry

```text
Ingest   ▸ dcm2niix · bids-classify · bids-write · heudiconv · dcm2bids · OpenNeuro
Explore  ▸ NeuroVue · brainchop · niimath
Publish  ▸ (TBD)
Other    ▸ untagged / custom tools
```

---

## Future hooks (when, not if)

The stage boundary is a natural seam — available the day we want it:

- **Session handoff** — checkpoint `context.json` / `provenance.jsonl` at end of Ingest → Explore
- **Gating** — "can't Publish until Explore produced reviewed outputs"
- **Promotion** — Publish marks where working state (NVD) becomes a shareable artifact

None of these are wired yet — the tag just leaves the door open.

---

## Next steps

1. **Publish tools** — first composer tool (Niivue tiles · labels · captions · graphs) tagged `stage: 'publish'`
2. **Custom-tool executors** — `systemOpen` + `script` kinds, usable in any stage
3. (Later) behavioral hooks on the stage boundary, if they earn their keep

---

# Summary

- **Ingest · Explore · Publish** organize the workflow
- Reference adapters are swappable defaults
- The stage tag is **informal, opt-in, zero-debt**
- It pays for itself in **tool discovery** — especially for custom tools

### Track it, but barely.
