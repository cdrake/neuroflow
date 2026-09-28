# Prompt to workflow

A user describes an analysis in plain language. A headless coding agent
(Claude Code by default, or OpenAI Codex), given nothing but the `neuroflow`
MCP server, discovers the registered tools,
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
| `prompt.md` | The user's request; `run.sh` fills its two data-path placeholders. |
| `system.md` | Four sentences appended to the system prompt: discover, chain by type, validate, report from results. |
| `mcp.json` | Portable MCP-config skeleton; `run.sh` fills in this checkout's binary and gallery paths. |
| `run.sh` | Runs `claude -p` (or `codex exec` with `NEUROFLOW_DEMO_AGENT=codex`) with the prompt and the neuroflow MCP server, then collects the results into `out/` (Claude) or `out-codex/` (Codex). |
| `out/answer.md` | The agent's final answer from the recorded run. |
| `out/agent-workflow.json` | The workflow the agent composed and ran (copied from the run directory). |
| `out/tool-calls.jsonl` | Every tool call the agent made, in order. |
| `out/provenance.jsonl`, `out/run.provenance.json` | The run's provenance trail and folded PROV record. |
| `out/transcript.jsonl` | Not retained: `run.sh` processes the raw provider transcript in a temporary file and removes it after a successful run. A failed run, or `NEUROFLOW_DEMO_KEEP_TRANSCRIPT=1`, leaves it in place and prints where. |

`gallery/workflows/dicom-t1-mni-volumes.neuroflow.json` is the hand-written
reference for the same pipeline. The agent's workflow matches it step for step.
The committed records replace absolute local paths with `<local-path>`; the raw
run artifacts remain only in the local NeuroFlow session directory.

## Running it

```bash
cargo build --release -p neuroflow-mcp
demos/prompt-to-workflow/run.sh            # writes out/
```

Requirements: the Claude Code CLI and `jq`; dcm2niix; niimath v1.0.20260924 or
newer (the conda build on `PATH` is too old, so `run.sh` relies on the tool
document's search of `~/bin` and `/usr/local/bin`, or `NIIMATH`); the brainchop
CLI in the Python the server uses; native `synthseg` or the Neurodesk Webapps
suite. By default, the demo uses `~/Data/DICOMs/5_anat-T1w` and
`~/Data/templates/MNI152_T1_1mm_brain.nii.gz`. Set
`NEUROFLOW_DEMO_DATA_ROOT`, `NEUROFLOW_DEMO_DICOM_DIR`,
`NEUROFLOW_DEMO_TEMPLATE`, `NEUROFLOW_DEMO_SPEC_DIR`,
`NEUROFLOW_DEMO_PYTHON`, or `NEUROFLOW_DEMO_NODE` to override them.
`NEUROFLOW_DEMO_AGENT=codex` runs the same prompt through the Codex CLI
instead: the server is passed as `-c mcp_servers.neuroflow.*` overrides derived
from the same `mcp.json`, `system.md` leads the prompt (Codex has no
system-prompt flag), the shell sandbox stays read-only, and `--ephemeral`
keeps the session out of Codex's history. Any MCP client can drive the server
the same way; it is plain stdio JSON-RPC with no Claude-specific parts.
New gallery tools are only visible to a freshly started server, which `run.sh`
provides.

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

## The same prompt under Codex

`NEUROFLOW_DEMO_AGENT=codex demos/prompt-to-workflow/run.sh` ran the identical
prompt through `codex exec` (codex-cli 0.155.1), with results in `out-codex/`.
Nothing in the server, the tool documents or the prompt changed; only the
client did.

- 10 tool calls: `neuroflow_list`, five `neuroflow_describe` (one per tool),
  `neuroflow_validate` twice, `neuroflow_run` once, and `neuroflow_inspect`
  on the transform artifact.
- The first validation failed on one rule: the agent had exposed the
  registration cost as a workflow output referencing a workflow input, and
  outputs may only reference step outputs. It dropped that output and read
  the cost from the transform artifact after the run instead.
- The composed workflow has the same five steps as the Claude run, with
  different step names (`skull_strip`, `register_affine`, `measure`); the
  cost is a workflow input with an enum, `anonymize`, `border`,
  `interpolation` and `mode` are constants.
- It reported left/right hippocampus 4.747/4.845 mL, brain mask 1592.272 mL,
  cost `hel+cr`, and the MNI-space brain URI, all matching the run's
  `volumes.tsv` and `transform.json`. Token usage: 292 k input (261 k
  cached), 5.1 k output.

An earlier Codex run of the same prompt (not the one recorded here) called
`neuroflow_run` twice with a byte-identical document and inputs: the second
call came 26 s after the server had returned the first run's completed
result, and the answer reported only the second run. Its transcript was not
kept, so what prompted the repeat on the client side is unknown; the server
handles every request sequentially and had answered the first call. The
server now answers such a repeat with the earlier run instead of executing
again (see "How a run works" in `crates/neuroflow-mcp/README.md`), so a
duplicate call no longer writes a second copy of every output.

## What the demo shows

- **Discovery by type.** The agent chained `neuro:dicom-folder` → `neuro:volume`
  → `neuro:mask` / `neuro:label-map` → `core:tabular` from the tool contracts
  alone.
- **Validation as the feedback loop.** The spec's binding rules are strict, and
  the validator's pointer-level diagnostics were enough to repair the document
  without a human.
- **Client-agnostic.** The server is plain stdio MCP; Claude Code and Codex
  drove it from the same `mcp.json`-derived definition with no client-specific
  code, and any MCP client can do the same.
- **Native tools next to web apps.** Three CLIs and one Neurodesk app ran under
  the same session contract; provenance records each executable, its version
  where the tool exposes one, and the full argument vector.
- **Answers from artifacts.** Every number in the answer is traceable to a file
  under `~/.neuroflow/runs/<runId>/outputs/`.
