# Python tools in NeuroFlow

Status: implemented on `feat/python-adapter`; verified with CPython 3.12
(nibabel 5.4, numpy 2.1, scipy 1.15, dipy 1.12) and a fake interpreter for
the adapter's own logic. The scope this was built against is the version of
this file merged in [#6](https://github.com/cdrake/neuroflow/pull/6).

Most neuroimaging analysis code is Python: NiBabel for I/O, DIPY for
diffusion, nilearn, SciPy, lab scripts. NeuroFlow runs such code as a typed
tool without a bespoke launcher. The tool document says which Python function
or script to run and which packages it needs; one shared adapter,
`gallery/scripts/python_tool.mjs`, finds an interpreter, **checks every
declared requirement before running anything and fails with the fix**, runs
the entry under the [session contract](neuroflow-session-contract.md), maps
outputs and appends provenance naming the Python and package versions. A
stdlib-only helper, `gallery/scripts/python/neuroflow.py`, gives tool code the
session as one object, the way MATLAB code gets the `nf` struct.

The organising rule, carried over from MATLAB licensing: anything that needs a
user to act (install a package, create an environment, point at a different
Python) is detected up front and reported in one message, never discovered as
a traceback three steps into a workflow and never papered over.

Three gallery tools run on it:

| Tool | Module | Needs |
| --- | --- | --- |
| `python-volume-filter` (smooth, threshold, z-score or passthrough over a BIDS dataset) | `python/nf_filter_volumes.py` | nibabel, numpy; scipy optional (NumPy convolution otherwise) |
| `label-volumes` (per-structure mL from a SynthSeg label map, plus inline totals) | `python/nf_label_volumes.py` | nibabel, numpy |
| `dti-fit` (FA and MD maps from a DWI series and gradient table) | `python/nf_dti_fit.py` | nibabel, numpy, dipy 1.9+ |

## How a run works

1. The runtime launches `node python_tool.mjs` with `NEUROFLOW_SESSION` and
   `context.json` (absolute inputs, output dir, work dir). The launch
   interpreter is `node`, which the MCP runner already allows; Python is the
   adapter's business.
2. The adapter picks an interpreter (next section), then runs one probe,
   `python -c "<import each declared module, print versions as JSON>"`. It
   takes well under a second even with NumPy. A missing or too-old required
   module stops the step here, before any tool code is imported.
3. For a `function` entry it writes `<workDir>/nf_driver.py`, a few lines that
   import the module and call the function with the resolved arguments, so a
   failing run leaves something to inspect; for a `script` entry it runs the
   file. Python runs with the work dir as cwd, the helper importable, and
   `PYTHONDONTWRITEBYTECODE=1` and `PYTHONUNBUFFERED=1` so tool directories
   stay clean and logs stream.
4. An uncaught exception prints its traceback to stderr and the step fails
   with `python exited with status 1`; a tool reports data problems by raising
   (`ValueError("gradient table has 5 entries but dwi has 21 volumes")`), not
   by exiting.
5. The adapter maps the files written to the output dir onto the tool's
   declared outputs, checks that the `result` output landed in
   `$NEUROFLOW_OUTPUT_FILE`, and appends one provenance line.

What a user sees when the environment is wrong, from the real adapter:

```
python_tool: /usr/bin/python3 is Python 3.9.6, but neuroflow.gallery.tools/dti-fit needs 3.10 or newer. To fix: set NEUROFLOW_PYTHON to a newer interpreter
```

```
python_tool: /opt/homebrew/bin/python3 (Python 3.14.2) lacks nibabel, required by neuroflow.gallery.tools/dti-fit (ModuleNotFoundError: No module named 'nibabel'). To fix: pip install nibabel into that environment, or point NEUROFLOW_PYTHON at an environment that has it; lacks dipy, required by neuroflow.gallery.tools/dti-fit (ModuleNotFoundError: No module named 'dipy'). To fix: pip install dipy into that environment, or point NEUROFLOW_PYTHON at one that has it (e.g. python3 -m venv ~/.venvs/neuroflow && ~/.venvs/neuroflow/bin/pip install dipy nibabel)
```

Every problem is in that one message, so one round of fixes is enough.

## Choosing the Python

In order, the first that exists wins:

1. `NEUROFLOW_PYTHON` (or the variable the template names in
   `interpreter.env`). A path that does not exist is an error, not a fallback.
2. The template's `interpreter.paths`: `{{toolDir}}` and `~` expand, one `*`
   glob per path (newest match first). The gallery tools list
   `{{toolDir}}/.venv/bin/python` so a tool can ship its own environment, then
   `~/.venvs/neuroflow/bin/python` as a shared one.
3. `NEUROFLOW_INTERPRETER_PYTHON3`: the MCP server exports its
   `--interpreter python3=...` setting to every step under this name (and
   `NEUROFLOW_INTERPRETER_NODE` and so on for the others), so a Python chosen
   for the server reaches the adapter even when the client trimmed `PATH`.
4. `python3`, then `python`, on `PATH`.

An interpreter below `interpreter.minVersion` fails with its path and version.
The quickest working setup on a machine with none of the packages:

```sh
python3 -m venv ~/.venvs/neuroflow
~/.venvs/neuroflow/bin/pip install nibabel numpy scipy dipy
```

Nothing else to configure: the gallery tools find `~/.venvs/neuroflow` by
themselves. A conda or miniforge Python works the same way through
`NEUROFLOW_PYTHON`, which is how the development machine runs the tests.

## The `neuroflow/python` template

From `gallery/tools/dti-fit.tool.json`:

```json
"neuroflow/launch": {
  "kind": "script", "interpreter": "node", "script": "../scripts/python_tool.mjs",
  "completion": "exit", "interactive": false,
  "contract": "../../docs/neuroflow-session-contract.md",
  "requirements": ["Python 3.10+ with dipy 1.9+, nibabel and numpy; set NEUROFLOW_PYTHON to the environment"]
},
"neuroflow/python": {
  "interpreter": {
    "env": "NEUROFLOW_PYTHON",
    "paths": ["{{toolDir}}/.venv/bin/python", "~/.venvs/neuroflow/bin/python"],
    "minVersion": "3.10"
  },
  "requirements": [
    "nibabel",
    "numpy",
    { "import": "dipy", "package": "dipy", "minVersion": "1.9",
      "advice": "pip install dipy into that environment, or point NEUROFLOW_PYTHON at one that has it (e.g. python3 -m venv ~/.venvs/neuroflow && ~/.venvs/neuroflow/bin/pip install dipy nibabel)" }
  ],
  "singleThread": true,
  "entry": {
    "kind": "function", "module": "nf_dti_fit", "name": "run",
    "args": ["{{dwi}}", "{{gradients}}", "{{mask}}", "{{fit_method}}", "{{b0_threshold}}"],
    "result": "summary"
  },
  "outputs": { "fa": "fa.nii.gz", "md": "md.nii.gz" }
}
```

The `neuroflow/launch` `requirements` are human text for a reader of the
document; the runner does not check them. The checked list is
`neuroflow/python.requirements`.

- **`interpreter`** `{ env, paths, minVersion }`: as above. All three are
  optional; the default `env` is `NEUROFLOW_PYTHON`.
- **`requirements`**: `"nibabel"` means `{ "import": "nibabel", "package":
  "nibabel" }`. The object form adds `minVersion` (compared against the
  module's `__version__`, or `importlib.metadata` when a module has none),
  `advice` (appended after "To fix:"; the default says to pip install the
  package into that environment or point the override variable elsewhere),
  and `optional: true`, which records the package as present or `null` in
  provenance instead of failing, so the tool can adapt. `import` may be dotted
  (`scipy.ndimage`); `package` is the pip name shown to the user.
- **`pythonpath`**: directories added to `PYTHONPATH`, relative to the tool
  document (`~` expands). They come first, then the tool's own directory and
  `gallery/scripts/python` (the helper), which are always included, then the
  caller's `PYTHONPATH`.
- **`singleThread`** (default `true`): sets `OMP_NUM_THREADS`,
  `OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS` and `NUMEXPR_NUM_THREADS` to 1 for
  results that do not depend on the core count. Set `false` for a tool that
  benefits from BLAS threads.
- **`entry`**, one of:
  - `{ "kind": "function", "module", "name", "args", "result" }` imports
    `module` and calls `name(*args)` from the generated driver. Each argument
    is a JSON literal or a placeholder. An exact `{{input}}` passes the input
    with its JSON type, paths as `pathlib.Path`. An input with no value passes
    its declared `default` as a literal, or `None` when it is optional with no
    default; a required input without a value fails before launch.
    `{{outputDir}}`, `{{workDir}}` and `{{outputFile}}` pass those paths.
    A placeholder inside other text (`"--fwhm={{amount}}"`) yields a `str`.
    `result` names a `core:result-file` output that receives the return value
    as JSON; omit it when the function writes its own result.
  - `{ "kind": "script", "file" }` runs the file (relative to the tool
    document) with the helper importable, for a tool that owns its flow.
- **`outputs`**: output name to the file the entry writes in the output dir,
  or `{ "match": "<regex>", "pick": "first" | "largest" }` when the name is
  not known in advance, renamed to the declared `delivery.path` exactly as the
  [CLI adapter](native-cli-tools.md) does. Outputs the entry writes through `s.output_path(name)` already have the
  declared name and need no mapping entry; `python-volume-filter` has one
  (`"filtered_volumes": "filtered"`) only to document the directory.
- **`clearEnv`**: environment-variable names withheld from Python.

Python also sees `NEUROFLOW_TOOL_DOC` (the tool document, so the helper can
type the inputs) and the session contract's `NEUROFLOW_*` variables.

**Provenance.** One line per run:

```json
{"ts": "...", "step": "dti", "tool": "neuroflow.gallery.tools/dti-fit", "action": "python",
 "agent": "Python 3.12.12 + nibabel 5.4.0 + numpy 2.1.3 + dipy 1.12.1",
 "python": "3.12.12", "packages": {"nibabel": "5.4.0", "numpy": "2.1.3", "dipy": "1.12.1"},
 "executable": "/opt/homebrew/Caskroom/miniforge/base/bin/python3",
 "entry": {"kind": "function", "module": "nf_dti_fit", "name": "run"},
 "args": ["<workDir>/nf_driver.py"], "durationMs": 554,
 "outputs": {"fa": "fa.nii.gz", "md": "md.nii.gz"}}
```

An optional package that was absent appears as `null` in `packages`, so a run
that fell back (the filter without SciPy) is distinguishable afterwards.

## Writing the Python side

```python
from neuroflow import session

def run(dwi, gradients, mask=None, fit_method="WLS", b0_threshold=50.0):
    s = session()                          # $NEUROFLOW_SESSION/context.json
    img = nib.load(str(dwi))               # inputs arrive typed; paths are pathlib.Path
    ...
    nib.save(fa_img, str(s.output_path("fa")))   # output_dir / declared delivery.path
    s.log(f"fitted {n} voxels")            # stderr, prefixed "dti-fit:"
    return {"fit_method": fit_method, "voxels": n}   # stored as the `result` output
```

`Session` exposes `session_dir`, `context`, `run_id`, `step`, `tool`,
`output_dir`, `work_dir`, `output_file`, `tool_doc` and `inputs` (typed:
anything whose declared type is not a `core:` scalar becomes a `Path`,
including the elements of a `core:array<...>`). `output_path(name)` returns
`output_dir / <delivery.path>` for a declared output and creates the output
dir. `result(mapping)` or `result(**outputs)` writes `$NEUROFLOW_OUTPUT_FILE`
as `{name: value}` for a `script` entry or a function that wants more than one
inline output; values may be `Path`, NumPy arrays or scalars. `provenance(**
fields)` appends an extra line in the contract's format for a tool that wants
to record more than the adapter does (the filter records its per-file modes).
`name` is the short tool name used as the log prefix.

Conventions the gallery tools follow:

- Take paths and literals as arguments; read nothing from `pwd`, which is the
  session work dir, and write only under `s.output_dir` and `s.work_dir`.
- Raise for data problems with a message that names the inputs
  (`"mask shape (6, 6, 6) does not match dwi (8, 8, 8)"`). Do not catch
  `ImportError`: the adapter has already checked the packages, so an import
  that fails inside tool code is a bug, and a missing *optional* package is
  handled by trying the import where it is used, as `gaussian_smooth` does.
- A tool may pass an unreadable *input* through and say so (the filter copies
  it and records `passthrough (unreadable: ...)`): a data problem the user can
  see in the output, unlike a missing package.
- Return a compact summary (counts, means, method) rather than arrays; the
  runner stores it inline for an agent to read without opening files.
- The `dti-fit` gradient table (`neuro:gradient-table`) is resolved by file: an
  FSL `.bval` or `.bvec` reads its sibling of the same stem, and any other
  file is a text table with one row per volume, `x y z b` (MRtrix `.b`) or
  `b x y z` when the first column is clearly the b-value. The spec names the
  type but no format, so this is the gallery's convention until one is agreed.

## Testing

Two files, three tiers (`npm run test:gallery`):

- `python_tool.test.mjs` runs a fake interpreter (a node script posing as
  `python`) through interpreter selection and the override variables, the
  probe (missing, too-old and optional packages, a probe that itself fails),
  driver generation (typed placeholders, defaults and `None` for unset inputs,
  text placeholders), the thread variables and `PYTHONPATH`, output mapping,
  the result-file check and provenance. With a real `python3` that imports
  nibabel it then runs the helper itself (typed inputs, `output_path`, `result`,
  `provenance`) and both migrated tools on generated NIfTI files: the filter's
  threshold and smoothing, its unreadable-input passthrough, its NumPy fallback
  when SciPy is shadowed, and an unknown operation; the label tool's TSV and
  inline table with and without a mask.
- `dti_fit.test.mjs` runs `dti-fit` through its real tool document when
  `python3` imports dipy, otherwise skips with `pip install dipy to run this
  tier`. It synthesises a 6×6×6×21 DWI from a single tensor with eigenvalues
  (1.7, 0.3, 0.3)×10⁻³ mm²/s rotated 30° about z (FA 0.799, MD 0.767×10⁻³),
  one b0 and twenty directions at b = 1000, and checks that WLS and OLS recover
  FA and MD from an FSL pair and from an MRtrix `.b` table, with and without a
  mask, and that bad data (gradient count mismatch, 3-D input, unknown fit
  method, no b0, a `.bval` with no `.bvec`) raises before any map is written.

To run a tool by hand: write a `context.json` with absolute `inputs`, set
`NEUROFLOW_SESSION`, `NEUROFLOW_OUTPUT_DIR`, `NEUROFLOW_OUTPUT_FILE`,
`NEUROFLOW_STEP` and `NEUROFLOW_TOOL_DOC` (the adapter looks the document up
by the `tool` id in `context.json` when the variable is unset), optionally
`NEUROFLOW_PYTHON`, and run `node gallery/scripts/python_tool.mjs`. The MCP
server does all of this: `cargo build -q -p neuroflow-mcp && python3
crates/neuroflow-mcp/tests/smoke.py` runs `python-volume-filter` and the
`filter-qa` workflow end to end.

## Not covered yet

- A per-tool `.venv` or `~/.venvs/neuroflow` wins over the server's
  `--interpreter python3` setting, on the grounds that an environment placed
  for the tools is more specific than one chosen for the server. Set
  `NEUROFLOW_PYTHON` to override both.
- Environment *creation* (venv, uv, conda bootstrapping): the adapter finds and
  checks an environment and tells the user how to fix it; building one is the
  install-resolver territory of [tool-packaging.md](tool-packaging.md).
- Spec questions raised by `dti-fit`, to settle with the spec authors: whether
  a 4-D DWI deserves a qualifier on `neuro:volume`; whether FA and MD are
  `neuro:statmap` rather than `neuro:volume`; and a defined file format for
  `neuro:gradient-table`.
- Nipype, nilearn, Jupyter: a framework-based tool is an ordinary
  `neuroflow/python` tool; interactive Python is out of scope (`completion:
  exit`).
