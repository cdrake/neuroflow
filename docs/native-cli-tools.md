# Native command-line tools in NeuroFlow

Status: first pass

Most of the standard neuroimaging tool set is a command-line program that reads
files and writes files: dcm2niix, niimath, the brainchop CLI, FSL, AFNI, ANTs,
FreeSurfer. NeuroFlow wraps such a program as a typed tool without a bespoke
launcher: the tool document describes the command line, and one shared adapter,
`gallery/scripts/cli_tool.mjs`, runs it under the
[session contract](neuroflow-session-contract.md).

The first three are the [lightNIIng](https://lightniing.org) tools that cover
conversion, brain extraction and registration:

| Document | Command | Inputs | Outputs |
| --- | --- | --- | --- |
| `gallery/tools/dcm2niix.tool.json` | `dcm2niix` | `dicom_dir`, `anonymize` | `volume` (`neuro:volume`), `sidecar` (`core:json`) |
| `gallery/tools/mindgrab.tool.json` | `brainchop --skull-strip` | `t1`, `border` | `brain`, `brain_mask` |
| `gallery/tools/niimath-allineate.tool.json` | `niimath -allineate` | `moving`, `template`, `cost`, `interpolation`, optional `weight` | `registered`, `transform` (`neuro:transform`) |

Together with the Neurodesk SynthSeg tool and `label-volumes`, they make up
`gallery/workflows/dicom-t1-mni-volumes.neuroflow.json`: DICOM series → NIfTI →
brain → brain in MNI space, and SynthSeg structure volumes in native space. The
whole pipeline runs in well under a minute on an Apple-silicon laptop apart from
SynthSeg itself.

## The `neuroflow/cli` template

```json
"neuroflow/launch": {
  "kind": "script", "interpreter": "node", "script": "../scripts/cli_tool.mjs",
  "completion": "exit", "interactive": false,
  "contract": "../../docs/neuroflow-session-contract.md"
},
"neuroflow/cli": {
  "command": "niimath",
  "paths": ["~/bin/niimath", "/usr/local/bin/niimath"],
  "env": "NIIMATH",
  "probe": { "args": [], "match": "-allineate", "version": "v[0-9]+\\.[0-9]+\\.[0-9]+",
             "advice": "Install niimath v1.0.20260924 or newer; older builds have no -allineate." },
  "args": ["{{moving}}", "-allineate", "{{template}}", "-cost", "{{cost}}",
           { "args": ["-weight", "{{weight}}"], "whenSet": "weight" },
           "-savemat", "{{outputDir}}/transform.json", "{{outputDir}}/registered.nii.gz"],
  "outputs": { "registered": "registered.nii.gz", "transform": "transform.json" }
}
```

- **Locating the executable.** The override variable named by `env` wins, then
  each of `paths` (with `~` expanded), then `PATH`. A missing executable fails
  the step with the variable to set. This is the same rule as the `native`
  block of the Neurodesk adapter.
- **Probe.** Before the job, the adapter runs the executable with `probe.args`
  and fails with `advice` unless the output matches `probe.match`. A matching
  banner passes even when the probe exits non-zero (`dcm2niix -v` returns 3);
  without a match, a non-zero exit is reported as such. It catches an
  installed release that lacks the operation the tool needs (the niimath on
  `PATH` from conda is v1.0.20250804 and has no `-allineate`). `probe.version`
  is a regex whose match goes into provenance as the agent name, for example
  `niimath v1.0.20260924`.
- **Inputs.** Every non-scalar input (anything but `core:string`, `core:number`,
  `core:integer`, `core:boolean`, `core:object`) is a path, and the adapter
  checks it exists before running the command, so a broken reference is
  reported by input name rather than as the tool's own error.
- **Arguments.** Strings may contain `{{input}}`, `{{outputDir}}` and
  `{{workDir}}`. A missing value for a placeholder fails the step, so optional
  inputs go in conditional groups: `{ "arg": "--fast", "when": { "mode": "fast" } }`
  is kept when every listed input equals its value (booleans compare as
  booleans), and `{ "args": [...], "whenSet": "weight" }` when that input has a
  value. Array inputs join with commas.
- **Environment.** `clearEnv` optionally lists ambient variables withheld from
  both the probe and command. Use it only for a known conflict in a trusted
  tool, such as brainchop/tinygrad's numeric `DEBUG` setting.
- **Outputs.** Each declared output maps to a file name the command writes in the
  output directory, or to `{ "match": regex, "pick": "first" | "largest" }` when
  the name is not known ahead (dcm2niix appends echo and series suffixes). The
  file is renamed to the output's `delivery.path`, so the runtime's harvest and
  the tool document agree. A missing required output fails the step and lists
  what the command wrote.
- **Provenance.** One line per run: tool, agent (`command version`), executable,
  the full argument vector, duration and the produced outputs.

`gallery/scripts/cli_tool.test.mjs` exercises all of this against a fake command
(`npm run test:gallery`). MATLAB, Octave and SPM programs use the sibling
adapter described in [matlab-tools.md](matlab-tools.md), and Python programs
the one in [python-tools.md](python-tools.md).

## Installing the lightNIIng tools on macOS

- `dcm2niix`: `brew install dcm2niix`, or the copy FSL ships in `~/fsl/bin`.
- `niimath` with `-allineate`: the v1.0.20260924 release from
  https://github.com/rordenlab/niimath/releases into `~/bin` or `/usr/local/bin`
  (clear the quarantine bit with `xattr -d com.apple.quarantine`). Set `NIIMATH`
  if it lives elsewhere.
- mindgrab: `pip install brainchop` into the Python the MCP server uses
  (`--interpreter python3=...`); the first run downloads the model. Set
  `BRAINCHOP` if the CLI is not on `PATH`.
- SynthSeg: the native `synthseg` CLI from neurodesk/webapps `exes/`, or the
  Neurodesk Webapps desktop suite (see [neurodesk-webapps.md](neurodesk-webapps.md)).

## Adding another command-line tool

1. Write the tool document with typed inputs and outputs and `neuroflow/launch`
   pointing at `../scripts/cli_tool.mjs`.
2. Fill `neuroflow/cli`: command, install paths, override variable, a probe
   that distinguishes a usable release, the argument template, and the output
   mapping.
3. Run it once by hand through the session contract (write a `context.json`
   with absolute inputs, set `NEUROFLOW_SESSION`, run
   `node gallery/scripts/cli_tool.mjs`) and check the outputs and the
   provenance line.
4. `node gallery/validate.mjs`, `npm run test:gallery`, then
   `neuroflow-mcp --registry gallery --check`. Restart any running MCP server;
   it loads the registry at startup.
