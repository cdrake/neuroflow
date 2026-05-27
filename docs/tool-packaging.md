# Tool Packaging

Status: first pass

NeuroFlow workflows should stay universal. A workflow step references a logical
tool contract, while an install build resolves that contract to a concrete
platform target, executable, service endpoint, or external app session.

Tool definitions use the `neuroflow/packaging` extension to describe that
resolution layer. The tool `version` qualifies the contract. A bundle lock then
records the exact tool definition version, platform target, install source, probe
result, and binary or service provenance used for a run.

## Platform Targets

Install builds target a specific platform such as:

```json
{
  "os": "macos",
  "arch": "arm64",
  "accelerator": "metal",
  "label": "macOS Apple Silicon"
}
```

Supported target fields are intentionally small for now:

- `os`: `macos`, `linux`, `windows`, `web`, or `service`
- `arch`: `arm64`, `x64`, `wasm32`, or `universal`
- `libc`: optional Linux qualifier such as `glibc` or `musl`
- `accelerator`: optional runtime qualifier such as `cpu`, `cuda`, `metal`, or
  `webgpu`

## Version Qualifiers

Every bundled tool definition is keyed by `id` and `version`. Steps can continue
to use unversioned ids while editing, but bundle creation should lock the
resolved definition as `tool-id@version`.

Example:

```json
{
  "packageId": "dcm2niix",
  "version": "1.0.0",
  "versionQualifier": {
    "exact": "1.0.0"
  },
  "reproducibility": "versioned"
}
```

Use:

- `locked` when the package is part of the NeuroFlow app or has immutable hashes.
- `versioned` when the requested version is explicit but the local install must
  still be probed.
- `bestEffort` for remote services or site-managed tools where run provenance is
  the reproducibility boundary.

## Detection Chain

The install resolver should try these steps in order:

1. Detect the platform target for the current build.
2. Load bundled tool definitions and choose a compatible `id@version`.
3. Run declared probes, such as command, env var, path, app bundle, container, or
   service checks.
4. Capture the discovered executable path, service URL, version output, and
   parsed version.
5. If the tool is missing or the version is unacceptable, offer platform-matched
   install sources.
6. If automated install is not appropriate, show the declared user prompt for a
   file, directory, app bundle, or URL.
7. Validate the selected location with the prompt validator.
8. Write the resolved package into the bundle lock and run provenance.

This chain lets NeuroFlow use existing software when present without silently
changing workflow semantics.

## Install Sources

Bundling may include instructions, package manager commands, sidecar binaries,
containers, remote services, or user-provided locations.

```json
{
  "kind": "packageManager",
  "label": "Install dcm2niix with Homebrew",
  "platform": {
    "os": "macos",
    "arch": "arm64"
  },
  "packageManager": "brew",
  "packageName": "dcm2niix",
  "installCommand": "brew install dcm2niix"
}
```

Actual binary bundling should require immutable hashes:

```json
{
  "kind": "bundledBinary",
  "label": "NeuroFlow sidecar dcm2niix",
  "platform": {
    "os": "macos",
    "arch": "arm64"
  },
  "version": "1.0.0",
  "executablePath": "bin/macos-arm64/dcm2niix",
  "sha256": "..."
}
```

## Bundle Lock

A reproducible install build should emit a lock record alongside the workflow
JSON:

```json
{
  "workflow": "niivue.desktop/dicom-to-bids@2.0.0",
  "platform": "macos-arm64",
  "tools": [
    {
      "id": "niivue.desktop.tools/dcm2niix",
      "version": "1.0.0",
      "packageId": "dcm2niix",
      "resolvedBy": "command",
      "executable": "/opt/homebrew/bin/dcm2niix",
      "reportedVersion": "1.0.0",
      "reproducibility": "versioned"
    }
  ]
}
```

The workflow stays portable, but the lock explains exactly how a given platform
build or run was resolved.
