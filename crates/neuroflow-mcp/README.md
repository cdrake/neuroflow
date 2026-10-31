# neuroflow-mcp

A Model Context Protocol server for NeuroFlow. It exposes a registry of
NeuroFlow tool and workflow documents to AI agents, runs them under the
file-based session contract, and returns results as `neuroflow://` artifact
URIs with a provenance record for every run.

It implements the first slice of
[RFC 0009](../../../neuroflow-spec/rfcs/0009-mcp-binding.md). The server
speaks MCP over stdio and is built on `neuroflow-core`, with no async runtime
and no MCP SDK.

## Install

Each release from v0.2.1 on carries a prebuilt binary for linux x86-64
(static musl), macOS arm64 and Windows x86-64, with a `SHA256SUMS` file.
For example, on Linux:

```bash
tag=v0.6.1 target=x86_64-unknown-linux-musl
gh release download "$tag" -R cdrake/neuroflow -p "neuroflow-mcp-$tag-$target.tar.gz" -p SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf "neuroflow-mcp-$tag-$target.tar.gz"
"neuroflow-mcp-$tag-$target/neuroflow-mcp" --help
```

The macOS archive is `aarch64-apple-darwin.tar.gz` (check it with
`shasum -a 256 --check --ignore-missing SHA256SUMS`); the Windows one is
`x86_64-pc-windows-msvc.zip`.

## Build

```bash
cargo build --release -p neuroflow-mcp
./target/release/neuroflow-mcp --help
```

## Try it

```bash
./target/release/neuroflow-mcp \
  --registry gallery \
  --data-root ~/Data \
  --spec ../neuroflow-spec \
  --check
```

`--check` lists every document and says whether it is exposed as an MCP tool,
and if not, why.

End-to-end smoke test (needs python3 with nibabel, numpy, and scipy, plus node):

```bash
cargo build -p neuroflow-mcp
python3 crates/neuroflow-mcp/tests/smoke.py
```

## Connect a client

### Claude Code

```bash
claude mcp add neuroflow -- /path/to/neuroflow/target/release/neuroflow-mcp \
  --registry /path/to/neuroflow/gallery \
  --data-root /path/to/data \
  --spec /path/to/neuroflow-spec
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "neuroflow": {
      "command": "/path/to/neuroflow/target/release/neuroflow-mcp",
      "args": [
        "--registry", "/path/to/neuroflow/gallery",
        "--data-root", "/path/to/data",
        "--spec", "/path/to/neuroflow-spec",
        "--interpreter", "python3=/path/to/python3",
        "--interpreter", "node=/opt/homebrew/bin/node"
      ]
    }
  }
}
```

GUI apps on macOS start with a minimal `PATH`, so pass `--interpreter` for any
interpreter a script tool launches with; every gallery adapter (native CLI,
MATLAB, Python) launches with `node`. Adjust the paths above to match `which
node` on your machine.

Every configured interpreter is exported to each step as
`NEUROFLOW_INTERPRETER_<NAME>` (`NEUROFLOW_INTERPRETER_PYTHON3`,
`NEUROFLOW_INTERPRETER_NODE`, ...), together with the interpreter the step itself
launched with, so an adapter that starts a second interpreter finds it without
searching `PATH`. The Python tools (`python-volume-filter`, `label-volumes`,
`dti-fit`) pick their Python in this order: `NEUROFLOW_PYTHON` in the server's
environment (set it under `"env"` in the client's config), a per-tool `.venv`,
`~/.venvs/neuroflow/bin/python`, the `--interpreter python3=...` setting, then
`python3` on `PATH`. Point `--interpreter python3` at the environment that has
the tools' packages (nibabel, numpy; scipy for smoothing; dipy for `dti-fit`);
before launch the adapter checks them and otherwise fails the step with the
`pip install` to run, so a wrong environment is one clear error rather than a
traceback. See `docs/python-tools.md`.

## Options

| Flag | Meaning |
| --- | --- |
| `--registry <DIR>` | Directory of tool and workflow JSON, scanned recursively. Repeatable. |
| `--data-root <DIR>` | Directory file inputs may come from. Repeatable. Paths outside every data root are rejected. |
| `--sessions <DIR>` | Where run sessions live. Default `~/.neuroflow/runs`. |
| `--spec <DIR>` | A neuroflow-spec checkout; its schemas become `neuroflow://schemas/...` resources. |
| `--interpreter NAME=PATH` | Interpreter location. Allowed names: python3, python, node, Rscript. Exported to every step as `NEUROFLOW_INTERPRETER_<NAME>`. |
| `--step-timeout <SECS>` | Kill a step that runs longer than this. |
| `--summary-max-mb <MB>` | Largest voxel block scanned for intensity and label statistics. Default 512. |

## What the agent sees

**Tools**

| Tool | Purpose |
| --- | --- |
| `neuroflow_list` | Catalog with typed inputs and outputs. Filters: `kind`, `stage`, `acceptsType`, `producesType`, `runnableOnly`. |
| `neuroflow_describe` | Full document for an id or tool name. |
| `neuroflow_inspect` | Summarize any file or folder inside the data roots (or a `neuroflow://` artifact) without running a tool: NIfTI geometry, orientation, intensity and nonzero volume, label volumes when `type` is `neuro:label-map` or `neuro:mask`, BIDS layout. Lets an agent check inputs instead of guessing from names. |
| `neuroflow_validate` | Validate a document. Diagnostics carry a JSON Pointer and, where possible, a repair hint. |
| `neuroflow_plan` | Execution order and runnability for a workflow. |
| `neuroflow_run` | Run an inline workflow the agent composed, or a registry workflow by id. A repeat of the same workflow and inputs in the same session returns the earlier completed run; `rerun: true` forces a new one. |
| `neuroflow_export` | Package a completed run as a BIDS-Derivatives folder in its session: `dataset_description.json` with `GeneratedBy`, the outputs, `code/workflow.json`, and `<runId>_prov.json`. Every copy is checked against its recorded checksum. |
| One tool per runnable document | For example `neuroflow.gallery.tools.python-volume-filter` and `neuroflow.gallery.filter-qa`, with an `inputSchema` generated from the document's typed inputs. |

**Resources**

| URI | Content |
| --- | --- |
| `neuroflow://runs/{run}/artifacts/{step}/{output}[/{i}]` | Artifact summary. NIfTI: dimensions, voxel size, orientation, intensity range, and per-label volumes for label maps and masks. Directories: layout, file types, and BIDS subjects and datatypes. |
| `.../raw` | Bytes of small artifacts (text up to 4 MiB, binary up to 1 MiB). |
| `neuroflow://runs/{run}/provenance` | Provenance document (validates against `provenance.schema.json`). |
| `neuroflow://runs/{run}/logs/{step}/stdout` and `.../stderr` | Step logs, for diagnosing failures. |
| `neuroflow://catalog/{tools,workflows}/{id}` | Registry documents. |
| `neuroflow://schemas/...` | NeuroFlow JSON Schemas (with `--spec`). |

**Prompt:** `neuroflow_author_workflow` summarizes the workflow model and the
registry so an agent can compose a pipeline.

## How a run works

1. Inputs are checked against their declarations. Artifact references
   (absolute paths or `neuroflow://` URIs) are resolved and confined to the
   data roots and the sessions directory.
2. Steps run in dependency order, using authorial order as the tie-breaker.
   Each step gets a session directory, `context.json`, and the
   `NEUROFLOW_*` environment variables from
   `docs/neuroflow-session-contract.md`, including `NEUROFLOW_INTERPRETER_<NAME>`
   for every configured interpreter. Scripts start through the declared
   interpreter with no shell.
3. Outputs are harvested per RFC 0008 delivery modes: `result-dir`,
   `result-file` (a path, or keys in `result.json`), `stdout-json`,
   `exit-code`, and `fixed-path`. A workflow output whose step output was not
   produced is omitted when it is marked `optional`; otherwise the run fails
   with `failedStep` set to `outputs.<name>` (spec 0.1 §13).
4. `run.json` and `run.provenance.json` are written to the session. The MCP
   client is recorded as an agent. File entities, directory entities (a
   tree checksum over their files) and the executed `workflow.json` carry
   SHA-256 checksums, and the tools' `provenance.jsonl`
   lines are folded in under `extensions["neuroflow/session-trail"]`
   (`docs/neuroflow-session-contract.md`).
5. The run's work fingerprint (the workflow document, the documents of the
   tools it references, and the resolved inputs with the size and
   modification time of every input file or folder entry) is stored in
   `run.json`. While the server process lives, a later call with the same
   fingerprint is answered with that completed run: the text starts with
   `Reused run <id>`, `structuredContent.reused` is `true`, and nothing is
   executed or written again. Agents do repeat a call now and then (one
   Codex session called `neuroflow_run` twice with a byte-identical
   document), and this keeps that from producing two copies of every
   output. Pass `rerun: true` to force a fresh run; failed runs are never
   replayed, and a changed input file or a deleted session invalidates the
   entry. The run tools carry `idempotentHint: true` for this reason.

### Cancelling a run

A client stops a run with the standard MCP `notifications/cancelled`, naming
the `tools/call` request that started it. Stdin is read on its own thread, so
the notification arrives while the run is executing. The server then:

- terminates the running step's whole process tree (SIGTERM to its process
  group, SIGKILL after two seconds; on Windows only the direct child is
  stopped) and starts no further steps;
- writes `run.json` and `run.provenance.json` with status `cancelled`;
- sends no response to the cancelled request, as MCP specifies;
- keeps serving later requests in the same process.

A request cancelled before it started is dropped without running. A
cancelled run is never replayed by a later identical call. The capability
`features` list includes `cancellation`.

## Qualifier enforcement (RFC 0010)

The MCP executor validates 0.1.1 declarations and checks constrained inputs
before starting their consuming process. This includes direct tool calls,
workflow inputs, context defaults and mappings, constants, and every array element. An unknown fact is a failed
check, even when a caller repeats the requested annotation on its input.
Inspection itself is best effort: bytes a reader rejects, or a `neuroflow://`
artifact whose producer run did not complete, leave the evidence empty with a
`reason`, and only a consumer that constrains an axis is refused. A `null`
context default is a placeholder for an output mapping and is not inspected.

Validation outcomes follow RFC 0010: an `incompatible` binding, including a
type mismatch the previous executor reported as a warning, is now an error and
`neuroflow_run` refuses the document. This also applies to 0.1.0 workflows without
qualifiers. To repair a mismatch, bind a compatible output or add a conversion
tool. Correct a type declaration only when it misdescribes the actual data.
A binding that `requires-runtime-check`
is a warning carrying `outcome: "requires-runtime-check"` on the diagnostic;
`neuroflow_validate` and `neuroflow_plan` report it as `conditional: true`,
`runnable: true` when the workflow uses supported execution features. Execution
resolves the requirement from artifact evidence before each launch. Invalid
workflows and unsupported execution features report `runnable: false`.

A diagnostic may also carry a `code` naming the check that raised it, such as
`optional-output` when an optional step output feeds a required input or a
workflow output not marked `optional` (spec 0.1.3), `input-undeclared` when a
binding references an undeclared workflow input, `output-ref-not-step` when a
workflow output references something other than a step output,
`local-id-invalid` when an input, context field, step or output name does not
match the spec's local identifier pattern, or `constant-invalid` when a
constant does not match the input's type, `enum`, `min` or `max`. Codes are stable across releases; match on `code`, not on the
message wording.

The initialize/discover capability
`experimental["com.niivue/neuroflow"].qualifierInspectors` states the supported
readers and provenance checks:

| Axis | Evidence this executor accepts |
| --- | --- |
| `formats` | NIfTI-1/2 single-file magic and gzip bytes (`nii`, `nii-gz`), or a successful JSON parse (`json`). Filename suffixes do not establish an encoding. CIFTI needs a separate reader. |
| `resolution` | Positive NIfTI voxel spacing with explicit metre, millimetre or micrometre units, converted to millimetres. Unknown units stay unknown. |
| `space` | An unambiguous NIfTI scanner-anatomical transform (code 1) establishes an artifact-local `individual` frame. Code 2 alone, matching affines and code 4 do not establish subject or named-template identity. Registered producer contracts and resolved `inputs.*` inheritance can supply semantic identity. |
| `labelSystem`, `density` | Registered producer provenance or resolved input inheritance. A voxel histogram does not identify an integer table. |

Each file's evidence includes its SHA-256. On Unix, the executor reuses a hash
within a run while the path, size, modification time, device, inode, and change
time match the cached file. Replacing a file or restoring its modification time
invalidates that cache. On other platforms, or when modification time is
unavailable, each inspection rehashes the file. Evidence from an earlier run is
always rehashed. A new file gets a content-scoped
frame identity; separate acquisitions are not equated because their geometry
matches. An inherited output retains the inspected input's frame identity,
including when no portable space label is known. Registered tools are the trust
boundary for semantic output claims: their declared template, table revision or
density is recorded after successful execution. Input declarations and MCP
arguments cannot supply those claims. Encodings and spacing are read from the
artifact and a measured contradiction of an output promise fails the run.
The MCP executor normalizes delivered outputs: an array artifact output may
arrive as one path, an integer as a whole-valued number, and
artifact paths are canonicalized and confined to the data roots or the session.
Each `qualifierChecks` entry records one binding with its per-axis `checks`
and the evidence once.

Evidence survives workflow references and `neuroflow://` references from earlier
completed runs. The executor checks the content hash again before using recorded
provenance, returning summaries or replaying cached outputs. Checks and evidence
are available in `run.json`, artifact summaries, and the
`extensions["neuroflow/qualifiers"]` section of `run.provenance.json`.

Other encodings always require another byte reader; a producer's format
annotation cannot replace one. Embedded label tables and template revision
equivalence also lack readers. Semantic space, label-system and density
requirements can use exact registered producer provenance; unresolved revision
comparisons fail before launch. The executor does not silently convert, resample
or relabel. The separate UI/Tauri adapter has no artifact
inspector and refuses qualified inputs or workflow boundaries.

Run the subprocess boundary tests with:

```bash
cargo test -p neuroflow-mcp qualifier_tests
```

They verify that rejected inputs never create a launch marker, valid inspected
inputs execute, literal and array bindings are checked, output promises are
checked per element, and provenance survives both workflow and URI chaining.

## Not implemented yet

Not yet implemented, relative to RFC 0009:

- **Runs are synchronous.** A call returns when the run finishes, with
  progress notifications in the meantime, and can be stopped with
  `notifications/cancelled`. There are no tasks yet, and no
  `neuroflow_status` or `neuroflow_cancel`.
- **Fix proposals and `core:await-approval`.** Workflows that use
  `awaitApproval: "required"` or `fixLoop` are listed but not runnable.
- **Interactive `uiApp` tools as MCP Apps.** BIDSvue and NeuroVue are listed
  but not runnable.
- **Other launch kinds and delivery modes.** `niivue/runtime` console tools,
  the `core:event-stream` delivery mode, and runtime events are not supported.
- **Rendered images.** No `.../rendition` PNGs yet.
- **MCP versions.** The server negotiates 2025-03-26, 2025-06-18, and
  2025-11-25. The stateless 2026-07-28 revision is not implemented.
