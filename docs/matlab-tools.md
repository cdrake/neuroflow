# MATLAB, Octave and SPM tools in NeuroFlow

Status: first pass; verified against MATLAB R2025a and GNU Octave 9.4 (both
produce identical `header.json` for the reference tool) and a stubbed SPM.
The MATLAB Runtime path is generated the same way but has only been exercised
with a fake engine (see "Testing").

A large share of neuroimaging analysis still lives in MATLAB: SPM and its
toolboxes (CAT12, CONN, MarsBaR), Chris Rorden's `spmScripts`, `nii_preprocess`
and `Clinical`, lab-specific `.m` files. NeuroFlow runs such code as a typed
tool without a bespoke launcher: the tool document says which MATLAB function,
script or SPM batch to run, and one shared adapter,
`gallery/scripts/matlab_tool.mjs`, runs it headlessly under the
[session contract](neuroflow-session-contract.md), in MATLAB, in GNU Octave,
or in a compiled SPM standalone on the MATLAB Runtime.

The reference tool is `gallery/tools/nifti-header-matlab.tool.json`, which
runs `gallery/scripts/matlab/nf_nifti_header.m`: a toolbox-free NIfTI-1/2
header reader that writes `header.json` (dimensions, voxel size, datatype,
units, qform and sform affines, whether they agree, the voxel-axis
orientation code) and returns the same record inline. Its output matches
nibabel's affines and axis codes on real data.

## How a run works

1. The runtime launches `node matlab_tool.mjs` with `NEUROFLOW_SESSION` and
   `context.json` (absolute inputs, output dir, work dir).
2. The adapter picks an engine, resolves toolboxes, and writes
   `<workDir>/nf_wrapper.m`. The wrapper builds an `nf` struct as MATLAB
   literals (no `jsondecode`, so hyphenated names and string arrays are not
   mangled), adds the tool's directories and toolboxes to the path unless the
   engine is deployed, records `version()` and `spm('Ver')` in `nf_info.json`,
   changes to the work dir and calls the entry inside `try/catch`. Any error
   prints its message and stack to stderr and the process exits 1; success
   exits 0.
3. The engine runs the wrapper headlessly:
   - MATLAB: `matlab -batch "run('<wrapper>')" -singleCompThread`
   - Octave: `octave-cli --no-gui -q --eval "run('<wrapper>')"`
   - Standalone SPM: `$SPMMCRCMD $MCR_ROOT script <wrapper>`
4. The adapter maps the files written to the output dir onto the tool's
   declared outputs (renaming to each output's `delivery.path`), checks the
   inline result file when the entry returns a value, and appends one
   provenance line with the engine, its version, the SPM version, the entry,
   the toolboxes used and the argument vector.

Inside the entry, `nf` holds `runId`, `step`, `tool`, `session`, `outputDir`,
`workDir`, `outputFile` and `inputs.<name>` with the JSON types of the
inputs (char arrays, doubles, logicals, numeric vectors, cell arrays of
strings, structs).

## The `neuroflow/matlab` template

```json
"neuroflow/launch": {
  "kind": "script", "interpreter": "node", "script": "../scripts/matlab_tool.mjs",
  "completion": "exit", "interactive": false,
  "contract": "../../docs/neuroflow-session-contract.md"
},
"neuroflow/matlab": {
  "engine": "auto",
  "singleThread": true,
  "addpath": ["../scripts/matlab"],
  "toolboxes": [
    { "name": "spm", "env": "SPM_HOME", "paths": ["~/spm12", "~/spm", "/opt/spm12"],
      "advice": "Install SPM12 or SPM25 and set SPM_HOME." }
  ],
  "entry": { "kind": "function", "name": "nf_nifti_header",
             "args": ["{{image}}", "{{outputDir}}"], "result": "summary" },
  "outputs": { "header": "header.json" }
}
```

- **Engine.** `auto` (the default) takes MATLAB when it is installed, then
  Octave, then a standalone SPM when `SPMMCRCMD` is set. `NEUROFLOW_MATLAB_ENGINE`
  overrides the document, so one machine can force Octave for an SPM-free
  tool. MATLAB is found through `MATLAB`, then `/Applications/MATLAB_R*.app`
  and `/usr/local/MATLAB/R*` (newest release first), then `PATH`; Octave
  through `OCTAVE`, the Homebrew and Octave.app locations, then `PATH`. A
  tool may override `matlab.paths`, `octave.paths` and add engine arguments
  such as `-nojvm`. `singleThread` (default true) passes `-singleCompThread`
  and sets `OMP_NUM_THREADS=1`, which keeps results deterministic across
  machines; turn it off for tools that are known to need the pool.
- **Toolboxes.** Each entry is located like an executable: its override
  variable, then candidate paths (with `~` and one `*` glob, newest first).
  A missing required toolbox fails the step naming the variable to set;
  `required: false` skips it silently. A toolbox named `spm` is also reported
  as `SPM12 (7771)`-style version text in provenance, from `spm('Ver')`.
  With a standalone SPM, toolboxes are compiled in and the list is ignored.
- **Entry.** `function` calls `name(args...)`; each argument is a literal, an
  exact `{{input}}` placeholder (passed with the input's JSON type),
  `{{outputDir}}`, `{{workDir}}`, `{{outputFile}}`, or text containing
  placeholders (passed as a char array). `result` names a
  `core:result-file` output that receives the function's return value as
  JSON, the same shape the Python tools write. `script` runs an `.m` file
  with `nf` in the workspace. `batch` is the SPM pattern: `file` is a `.mat`
  holding `matlabbatch` or an `.m` script that defines it (and may read
  `nf`), `inputs` fill the batch's open inputs in order, and the wrapper runs
  `spm('Defaults', ...)`, `spm_jobman('initcfg')`,
  `spm_get_defaults('cmdline', true)` and `spm_jobman('run', matlabbatch, inputs{:})`,
  the same sequence Nipype uses.
- **Inputs.** Input ids must be MATLAB identifiers (they become fields of
  `nf.inputs`); the adapter refuses hyphenated ids before writing anything.
  Every non-scalar input is a path and must exist.
- **Outputs, environment, provenance.** As in the
  [CLI adapter](native-cli-tools.md): `outputs` maps names to files or
  `{ match, pick }` regexes over the output dir, `clearEnv` withholds ambient
  variables, and one provenance line per run records agent
  (`MATLAB 25.1.0 (R2025a) + SPM12 (7771)`, `GNU Octave 9.4.0`), engine,
  executable, arguments, entry, toolboxes, duration and produced outputs.

## Writing the MATLAB side

- Write a function that takes paths and the output directory and writes its
  files there; read nothing from `pwd`, which is the session work dir.
- Raise errors with `error(id, msg)`; the wrapper reports them and fails the
  step. Do not call `exit` yourself.
- For MATLAB/Octave portability: no chained indexing (`x(2:4)(:)`), no
  `"string"` literals, `jsonencode`/`jsondecode` exist in both
  (MATLAB R2016b+, Octave 7+), `gunzip` needs the JVM in MATLAB (do not pass
  `-nojvm` to tools that read `.nii.gz`).
- SPM: only `spm_jobman` batches or documented `spm_*` functions; SPM does
  not support Octave, and a standalone SPM cannot load extra toolboxes.

## Testing

`gallery/scripts/matlab_tool.test.mjs` runs three tiers (`npm run test:gallery`):

- a fake engine (a node script posing as `matlab`) checks wrapper generation,
  headless flags, engine selection and override variables, toolbox
  resolution, the batch sequence, output mapping and provenance;
- GNU Octave, when `octave-cli` is on `PATH`, runs the header reader on
  generated NIfTI files (RAS and LAS, gzipped and plain), a failing entry, a
  script entry with typed inputs, and a batch entry against a stub SPM that
  records the `Ver`/`Defaults`/`initcfg`/`cmdline`/`run` calls;
- MATLAB, when `NEUROFLOW_TEST_MATLAB=1` and a licensed install exists, runs
  the same cases (about 3 s per start with R2025a). It is off by default
  because each MATLAB start takes seconds and needs a license.

To run the reference tool by hand: write a `context.json` with an absolute
`inputs.image`, set `NEUROFLOW_SESSION` (and `NEUROFLOW_MATLAB_ENGINE=octave`
if you have no MATLAB), run `node gallery/scripts/matlab_tool.mjs`, and read
`outputs/header.json` and `provenance.jsonl`.

## Not covered yet

- Real SPM runs (no SPM install on the development machine). The batch path
  is exercised only against the stub.
- MATLAB Online cannot be an engine: the adapter needs a local `matlab`
  binary.
- The MATLAB Engine API for Python is not used; a Python tool that needs
  MATLAB should call this adapter's pattern, not embed the engine.
- The spec has no execution-environment field, so the engine choice and
  toolbox locations live in the gallery extension and machine variables; see
  the execution-integration survey in neuroflow-spec for the proposed RFC.
