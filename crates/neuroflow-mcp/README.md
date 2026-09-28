# neuroflow-mcp

A Model Context Protocol server for NeuroFlow. It exposes a registry of
NeuroFlow tool and workflow documents to AI agents, runs them under the
file-based session contract, and returns results as `neuroflow://` artifact
URIs with a provenance record for every run.

It implements the first slice of
[RFC 0009](../../../neuroflow-spec/rfcs/0009-mcp-binding.md). The server
speaks MCP over stdio and is built on `neuroflow-core`, with no async runtime
and no MCP SDK.

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
interpreter a script tool uses, pointing at the Python environment that has
the tool's requirements (for the gallery filter: nibabel, numpy, scipy).
Adjust the paths above to match `which python3` and `which node` on your
machine.

## Options

| Flag | Meaning |
| --- | --- |
| `--registry <DIR>` | Directory of tool and workflow JSON, scanned recursively. Repeatable. |
| `--data-root <DIR>` | Directory file inputs may come from. Repeatable. Paths outside every data root are rejected. |
| `--sessions <DIR>` | Where run sessions live. Default `~/.neuroflow/runs`. |
| `--spec <DIR>` | A neuroflow-spec checkout; its schemas become `neuroflow://schemas/...` resources. |
| `--interpreter NAME=PATH` | Interpreter location. Allowed names: python3, python, node, Rscript. |
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
   `docs/neuroflow-session-contract.md`. Scripts start through the declared
   interpreter with no shell.
3. Outputs are harvested per RFC 0008 delivery modes: `result-dir`,
   `result-file` (a path, or keys in `result.json`), `stdout-json`,
   `exit-code`, and `fixed-path`.
4. `run.json` and `run.provenance.json` are written to the session. The MCP
   client is recorded as an agent.
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

## Not implemented yet

Not yet implemented, relative to RFC 0009:

- **Runs are synchronous.** A call returns when the run finishes, with
  progress notifications in the meantime. There are no tasks yet, and no
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
