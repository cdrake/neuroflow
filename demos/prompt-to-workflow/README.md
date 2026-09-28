# Prompt to workflow

A user describes an analysis in plain language. A headless Claude Code agent,
given nothing but the `neuroflow` MCP server, discovers the registered tools,
composes a NeuroFlow workflow from them, validates it, runs it on the user's
data, and reports numbers read back from the run's artifacts.

The tools are the [lightNIIng](https://lightniing.org) set wrapped as NeuroFlow
tool documents (see `docs/native-cli-tools.md`): dcm2niix, mindgrab (brainchop
CLI), niimath `-allineate`, plus Neurodesk SynthSeg and the gallery's
`label-volumes`. The agent is never told which tools exist or how to chain
them; `prompt.md` names only the data and the five things to do.

## Files

| File | What it is |
| --- | --- |
| `prompt.md` | The user's request. |
| `system.md` | Four sentences appended to the system prompt: discover, chain by type, validate, report from results. |
| `mcp.json` | The MCP config: `neuroflow-mcp` with the gallery registry and `~/Data` as the data root. |
| `run.sh` | Runs `claude -p` with the prompt and only the `mcp__neuroflow__*` tools, then collects the results into `out/`. |
| `out/answer.md` | The agent's final answer from the recorded run. |
| `out/agent-workflow.json` | The workflow the agent composed and ran (copied from the run directory). |
| `out/tool-calls.jsonl` | Every tool call the agent made, in order. |
| `out/provenance.jsonl`, `out/run.provenance.json` | The run's provenance trail and folded PROV record. |
| `out/transcript.jsonl` | The full stream-json transcript. |

`gallery/workflows/dicom-t1-mni-volumes.neuroflow.json` is the hand-written
reference for the same pipeline. The agent's workflow matches it step for step.

## Running it

```bash
cargo build --release -p neuroflow-mcp
demos/prompt-to-workflow/run.sh            # writes out/
```

Requirements: the Claude Code CLI and `jq`; dcm2niix; niimath v1.0.20260924 or
newer (the conda build on `PATH` is too old, so `run.sh` relies on the tool
document's search of `~/bin` and `/usr/local/bin`, or `NIIMATH`); the brainchop
CLI in the Python the server uses; native `synthseg` or the Neurodesk Webapps
suite. The prompt points at a T1 DICOM series under `~/Data/DICOMs` and a
skull-stripped MNI152 template under `~/Data/templates`; edit `prompt.md` and
`mcp.json` for other data. New gallery tools are only visible to a freshly
started server, which `run.sh` provides.

## The recorded run

Agent: Claude Fable 5.1 through `claude -p`, 19 turns, 123 s wall clock (the
pipeline itself took 14 s), about $1.35.

What the agent did, from `out/tool-calls.jsonl`:

1. `neuroflow_list` for runnable documents, then `neuroflow_inspect` on the
   DICOM folder (192 files, one series) and on the template (182×218×182, 1 mm).
2. `neuroflow_describe` on each candidate tool, and on the gallery's
   `brain-volumes` workflow to learn the document syntax.
3. `neuroflow_validate` three times. The first two failed on literal step
   inputs (`"anonymize": true`, then `{"value": true}`); the diagnostics named
   the pointer and the rule ("Binding must contain exactly one of ref or
   constant"), and the third attempt used `{ "constant": true }`.
4. `neuroflow_run` with the inline workflow, the DICOM folder and template as
   inputs, `cost` = `fast`, `mode` = `default`.
5. `neuroflow_inspect` on the registered brain and the transform artifact
   before answering, so the reported grid and cost function come from the run.

The workflow it composed:

```
convert (dcm2niix) ─┬─> strip (mindgrab) ─┬─> register (niimath -allineate, MNI152 brain)
                    │                     └─> volumes (label-volumes, mask) <─┐
                    └─> segment (SynthSeg, full-head T1, native space) ───────┘
```

Results reported (all from `out/answer.md`, matching `outputs/volumes/volumes.tsv`):

| Quantity | Value |
| --- | --- |
| Left hippocampus | 4.747 mL |
| Right hippocampus | 4.845 mL |
| Brain mask (mindgrab) | 1592.3 mL |
| Registration cost | `hel+cr` (`fast`), 12 DOF |
| Brain in MNI space | `neuroflow://runs/run-20260928T154101Z-152f/artifacts/register/registered`, 182×218×182 at 1 mm |

The agent also noted, unprompted, that SynthSeg must see the unstripped T1 (the
tool description says so) and therefore measured volumes in native space rather
than on the MNI-resampled brain.

## What the demo shows

- **Discovery by type.** The agent chained `neuro:dicom-folder` → `neuro:volume`
  → `neuro:mask` / `neuro:label-map` → `core:tabular` from the tool contracts
  alone.
- **Validation as the feedback loop.** The spec's binding rules are strict, and
  the validator's pointer-level diagnostics were enough to repair the document
  without a human.
- **Native tools next to web apps.** Three CLIs and one Neurodesk app ran under
  the same session contract; provenance records each executable, its version
  where the tool exposes one, and the full argument vector.
- **Answers from artifacts.** Every number in the answer is traceable to a file
  under `~/.neuroflow/runs/<runId>/outputs/`.
