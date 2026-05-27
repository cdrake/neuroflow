# Tool IO Schema

Status: first pass

NeuroFlow tool contracts distinguish typed workflow values from process
transport. A tool output can be a typed value, a captured stream, a filesystem
artifact, or a service response. A tool input can consume values through argv,
stdin, filesystem paths, or service request bodies.

Transport is separate from packaging. The `neuroflow/packaging` extension
describes how a tool definition is resolved for a platform build, while
`availableFrom` and `consumesAs` describe how values move between resolved
steps. See `docs/tool-packaging.md`.

## Output Availability

Tool outputs use `availableFrom` to describe where the runtime can resolve a
declared output:

```json
{
  "type": "core:array<neuro:volume>",
  "description": "Converted NIfTI volumes.",
  "availableFrom": [
    {
      "source": "filesystem",
      "format": "nifti",
      "glob": "*.nii*",
      "pipe": {
        "safe": true,
        "modes": ["argument", "file"],
        "description": "Pass resolved file paths, not shell text."
      }
    }
  ]
}
```

Supported output sources are:

- `value`
- `stdout`
- `stderr`
- `filesystem`
- `serviceResponse`
- `uiSession`

Captured `stdout` and `stderr` can satisfy text, JSON, JSONL, path, and path-list
outputs when a tool explicitly declares them as an output source.

Preview-oriented tools can declare domain formats such as `nifti`, `omezarr`,
`tract`, and `mesh`. External viewer apps such as NeuroVue use those output
specs to choose a launch route without assuming every artifact is a shell path
or opaque string.

Standalone UI apps use `uiSession` and optional filesystem watches. This lets a
workflow launch a UI, observe user-edited artifacts while the app is open, and
continue after the app closes:

```json
{
  "type": "core:array<neuro:series-mapping>",
  "description": "BIDS series mapping table.",
  "availableFrom": [
    {
      "source": "uiSession",
      "format": "uiState",
      "selector": "seriesMappings",
      "completion": {
        "continueWhen": "appClosed",
        "requiredOutputs": ["mappings"]
      }
    },
    {
      "source": "filesystem",
      "format": "json",
      "watch": {
        "path": "session://bids-classify/mappings.json",
        "required": true,
        "debounceMs": 300
      },
      "completion": {
        "continueWhen": "appClosed",
        "requiredOutputs": ["mappings"]
      }
    }
  ]
}
```

## Input Consumption

Tool inputs use `consumesAs` to declare how a runtime may deliver a value:

```json
{
  "type": "core:array<neuro:volume>",
  "description": "Input NIfTI volumes.",
  "consumesAs": [
    {
      "channel": "argument",
      "format": "nifti",
      "acceptsPipe": true,
      "description": "Accept resolved NIfTI paths from an upstream safe file pipe."
    }
  ]
}
```

Supported input channels are:

- `stdin`
- `argument`
- `filesystem`
- `serviceRequest`

## Safe Pipes

A pipe is safe only when all of these are true:

1. The source output type is compatible with the target input type.
2. The source output declares `pipe.safe: true`.
3. The target input declares `acceptsPipe: true`.
4. The pipe mode appears in both the source `pipe.modes` and the target input
   channel.
5. The runtime passes values directly to `Command`, files, or request bodies. It
   does not build shell strings.

This allows future execution code to create pipes such as:

- resolved NIfTI path list -> argv
- diagnostics text -> stdin
- JSONL stdout -> service request body

It does not allow arbitrary shell syntax such as `cmd1 | cmd2`.

## UI App Sessions

UI app executors describe the app lifecycle separately from output availability:

```json
{
  "kind": "uiApp",
  "appId": "niivue.desktop.bids-classifier",
  "label": "NiiVue BIDS classifier",
  "completion": "appClosed"
}
```

The runtime should:

1. Launch the allowlisted app adapter.
2. Create a session workspace and map declared `session://` paths into it.
3. Watch each required output from `availableFrom.watch`.
4. Track app lifecycle.
5. When the app closes, resolve declared outputs from `uiSession` state or
   watched artifacts.
6. Continue the workflow only if required outputs are present and type-compatible.

This keeps UI-driven steps resumable without giving the workflow permission to
inspect arbitrary app state or execute shell syntax.

NeuroVue follows this model as a separate app session: it can resolve NIfTI,
OME-Zarr, tract, and mesh artifacts from declared output specs, then return a
small `correction_patch` JSON artifact from `uiSession` state or a watched
`session://neurovue/correction.patch.json` file.
