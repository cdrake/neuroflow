# Python tools in NeuroFlow

**Status: scope for a follow-up branch (`feat/python-adapter`, stacked on
[#5](https://github.com/cdrake/neuroflow/pull/5)).** Nothing below is
implemented yet; this document fixes what the work is and is not, so the
implementation can be reviewed against it. Sections marked *decided* are
settled; sections marked *open* name the choice still to make.

## Where Python stands today

Two gallery tools are Python: `python-volume-filter` (smooth / threshold /
z-score over a BIDS dataset) and `label-volumes` (per-structure mL from a
SynthSeg label map). Both run through the generic `script` launch kind with
`interpreter: python3`, implement the
[session contract](neuroflow-session-contract.md) by hand, and use NiBabel
and NumPy (SciPy for smoothing). NiBabel is therefore already a dependency of
the gallery. DIPY is not used anywhere.

What they lack, compared with the CLI and MATLAB adapters that arrived since:

- **No shared adapter.** `adapter_lib.mjs` gives the Node adapters session
  reading, tool-document lookup, executable search, input existence checks,
  output mapping and provenance. Each Python script reimplements those, and
  the two already disagree on how they find the output dir and what they put
  in provenance.
- **Requirements are declared but never checked.** Tool documents carry
  `requirements: ["nibabel", "numpy", "scipy"]`; the runner only resolves the
  interpreter path. Nothing verifies the packages exist before launch.
- **Missing packages degrade silently.** The volume filter catches
  `ImportError` and copies inputs through as "passthrough", and swallows every
  other exception the same way, so a run with no NiBabel reports success with
  unfiltered data. `label-volumes` crashes with a traceback and no hint about
  which environment to fix.
- **Environment selection is manual and global.** The MCP server takes
  `--interpreter python3=/path`, one Python for every tool. There is no
  per-tool environment, and no help when that Python lacks a package.

## Goal

A `python_tool.mjs` adapter, driven by `extensions["neuroflow/python"]`, that
does for Python what `cli_tool.mjs` and `matlab_tool.mjs` do for native
binaries and MATLAB: find the interpreter, **check every declared requirement
before running anything and fail with the fix**, run the entry, map outputs,
and append provenance that names the Python and package versions. A small
stdlib-only `neuroflow.py` helper gives tool code the session as an object,
the way MATLAB code gets the `nf` struct. The two existing tools move onto it,
and one DIPY tool is added as the first new consumer.

The organising rule is the one applied to MATLAB licensing in #5: anything
that needs a user to act (install a package, create an environment, point at
a different Python) is detected up front and reported in one message, never
discovered by a traceback three steps into a workflow and never papered over.

## Deliverables

1. **`gallery/scripts/python_tool.mjs`** — the adapter (Node, shares
   `adapter_lib.mjs`; launched by the runner with `interpreter: node`, which
   is already allowed).
2. **`gallery/scripts/python/neuroflow.py`** — the helper module, stdlib
   only, put on `PYTHONPATH` by the adapter.
3. **Migration** of `python-volume-filter` and `label-volumes` to the
   adapter and helper. The filter's silent passthrough on missing packages is
   removed on purpose; its passthrough on an unreadable *input* stays, since
   that is a data problem a user can see in the output.
4. **One DIPY tool**, `dti-fit`: DWI + gradient table (+ optional mask) in,
   FA and MD maps out, plus an inline summary. It is the tool that makes the
   requirements check matter, because DIPY is not in a default environment.
5. **Tests** in `python_tool.test.mjs`, tiered like the MATLAB tests: a fake
   interpreter for the adapter's own logic; the real `python3` with NiBabel
   when importable; DIPY when importable (so skipped on this machine until
   it is installed).
6. **Docs**: this file becomes the user guide, as `matlab-tools.md` did; a
   row per tool in `gallery/README.md`; the MCP README's interpreter advice
   updated.

## The `neuroflow/python` template (*decided* shape, details *open*)

```json
"neuroflow/launch": {
  "kind": "script", "interpreter": "node", "script": "../scripts/python_tool.mjs",
  "completion": "exit", "interactive": false,
  "contract": "../../docs/neuroflow-session-contract.md"
},
"neuroflow/python": {
  "interpreter": {
    "env": "NEUROFLOW_PYTHON",
    "paths": ["{{toolDir}}/.venv/bin/python", "~/.venvs/neuroflow/bin/python"],
    "minVersion": "3.10"
  },
  "requirements": [
    "nibabel",
    { "import": "dipy", "package": "dipy", "minVersion": "1.9",
      "advice": "pip install dipy, or point NEUROFLOW_PYTHON at an environment that has it" },
    { "import": "scipy.ndimage", "package": "scipy", "optional": true }
  ],
  "pythonpath": ["../scripts/python"],
  "singleThread": true,
  "entry": { "kind": "function", "module": "nf_dti_fit", "name": "run",
             "args": ["{{dwi}}", "{{gradients}}", "{{outputDir}}"], "result": "summary" },
  "outputs": { "fa": "fa.nii.gz", "md": "md.nii.gz" }
}
```

- **Interpreter.** `NEUROFLOW_PYTHON` first, then the template's `paths`
  (`~` and one `*` glob as elsewhere; `{{toolDir}}` lets a tool ship its own
  `.venv`), then the runner-configured `python3`, then `PATH`. A found
  interpreter below `minVersion` fails with its path and version. *Open:*
  whether the runner should export its `--interpreter` map to adapters (one
  small change in `crates/neuroflow-mcp`) so the third step works without
  duplicating paths; recommended, but the adapter must not depend on it.
- **Requirements.** One probe run before anything else:
  `python -c "<import each module, print versions as JSON>"`. Takes well under
  a second even with NumPy. A missing required module fails immediately:

  > python3 at /opt/homebrew/.../python3 (3.12.12) lacks dipy, required by
  > neuroflow.gallery.tools/dti-fit. To fix: pip install dipy, or point
  > NEUROFLOW_PYTHON at an environment that has it

  A module below `minVersion` fails the same way. `optional: true` records
  presence instead of failing, so the tool can adapt (as the filter does for
  SciPy). The probe's versions go into provenance:
  `Python 3.12.12 + nibabel 5.4.0 + dipy 1.10.0`. A plain string entry means
  `{ "import": s, "package": s }`.
- **Entry.** `function` imports `module` from `pythonpath` plus the tool's
  directory and calls `name(args...)`; arguments are literals or the same
  `{{input}}` / `{{outputDir}}` / `{{workDir}}` / `{{outputFile}}`
  placeholders as the other adapters (an exact `{{name}}` passes the input
  with its JSON type). `result` names a `core:result-file` output that
  receives the return value as JSON. `script` runs a file with the helper
  importable, for tools that want to own their flow. The adapter writes a
  short generated driver into the work dir for `function` entries, as the
  MATLAB adapter writes `nf_wrapper.m`, so a failing tool leaves something
  to inspect.
- **Threads.** `singleThread` (default true) sets `OMP_NUM_THREADS`,
  `OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS` and `NUMEXPR_NUM_THREADS` to 1
  for deterministic results across machines; tools that benefit from BLAS
  threads turn it off.
- **Outputs, environment, provenance.** Exactly as in the
  [CLI adapter](native-cli-tools.md): `outputs` maps names to files or
  `{ match, pick }`, `clearEnv` withholds variables, one provenance line per
  run. Also `PYTHONDONTWRITEBYTECODE=1` and `PYTHONUNBUFFERED=1` so tool
  directories stay clean and logs stream.

## `neuroflow.py` (*decided*)

```python
from neuroflow import session
s = session()                 # reads $NEUROFLOW_SESSION/context.json
img = s.inputs["image"]       # typed from JSON; paths are pathlib.Path
out = s.output_dir / "fa.nii.gz"
s.result({"mean_fa": 0.41})   # writes $NEUROFLOW_OUTPUT_FILE
s.log("fitted 1.2M voxels")   # stderr, prefixed for the adapter's transcript
```

Stdlib only, under 150 lines, no NiBabel import of its own. Provenance is the
adapter's job; a `script` entry that wants extra provenance fields calls
`s.provenance(**fields)`, which appends in the contract's format.

## The `dti-fit` tool (*decided* inputs/outputs, *open* defaults)

| | type | note |
|---|---|---|
| `dwi` | `neuro:volume` | 4-D diffusion series. *Open:* whether a `dwi` qualifier is worth proposing to the spec, or `neuro:volume` suffices for now. |
| `gradients` | `neuro:gradient-table` | already in the spec vocabulary; bval + bvec pair or a single table file, resolved by the tool |
| `mask` | `neuro:mask`, optional | restricts the fit and the summary |
| `fa`, `md` | `neuro:volume` (result-dir) | *Open:* `neuro:statmap` may fit FA better; decide with the spec authors |
| `summary` | `core:json` (result-file) | mean/median FA and MD within the mask, voxel count, fit method |

Implementation: `dipy.reconst.dti.TensorModel` with weighted least squares,
`dipy.io.gradients.read_bvals_bvecs`, NiBabel for I/O. Test data is a
synthetic single-tensor DWI generated in the test from the Stejskal–Tanner
equation over a handful of directions, so the test asserts a known FA.

## Not in scope

- Per-tool environment *creation* (uv/venv/conda bootstrapping). The adapter
  finds and checks an environment and tells the user how to fix it; building
  one is the install-resolver territory of [tool-packaging.md](tool-packaging.md).
- Nipype, nilearn or any other framework integration. They would be ordinary
  `neuroflow/python` tools.
- Jupyter or interactive Python. Tools are headless scripts, `completion: exit`.
- Changing the session contract. The helper is a reader of it, not an
  extension.
- Rewriting the Rust runner. At most the optional interpreter-export change
  above.

## Order of work

1. Adapter + helper + fake-interpreter tests (the bulk; one PR-sized unit).
2. Migrate the two existing tools; the MCP smoke test still passes.
3. `dti-fit` + its tiered test; install DIPY in the dev environment to run it.
4. Docs and README rows.

Steps 1–2 can merge without 3 if DIPY review takes longer. The branch is
stacked on `feat/matlab-adapter` for `adapter_lib.mjs`; once #5 merges it
rebases onto `main`.
