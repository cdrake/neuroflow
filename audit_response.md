# Audit response — 2026-10-13

Response to the external review of `origin/main...nf/3-bidsvue-ingest`, plus
what the internal audit (security and bugs, refactor, docs) found. The fixes are
on branch `nf/3-bidsvue-ingest` (NeuroFlow #14) and niivue/BIDSvue#18.

## External review

### P1: app-cli preflight can report ready without dcm2niix (fixed)

Done the way the review suggested: the app supplies the probe and NeuroFlow does not copy
its importer lookup.

- BIDSvue#18 adds `neuroflow-ingest --check`, which resolves dcm2niix in the same
  order as an ingest (flag, `DCM2NIIX`, the staged sidecar, PATH), runs
  `dcm2niix -v`, and prints one JSON line
  `{ ready, dcm2niix, dcm2niixVersion, problems[] }`. It exits 0 when ready and
  1 when not.
- `neuroflow/app-cli` gains an optional `probe` (`{ args, match, version,
  advice }`). `resolveAppCli` in `gallery/scripts/adapter_lib.mjs` checks the
  checkout, the entry file and the runner, then runs the probe in the checkout.
  When the probe fails it reports the app's own `problems`. Both
  `check_tool.mjs` (the Environment panel) and `app_cli.mjs` (before a run)
  call it, so they agree by construction. `runProbe` is now shared with
  `cli_tool.mjs`.
- `bidsvue-ingest.tool.json` declares the probe. Verified against a BIDSvue
  checkout: the tool is ready with `v1.0.20260724`. With
  `DCM2NIIX=/nonexistent` it reports needsSetup, gives BIDSvue's message, and
  advises "run `bun install` ... stage its dcm2niix sidecar, or set DCM2NIIX".
  `--check` does not test npm packages, and it doesn't need to: the CLI loads
  the whole import pipeline statically, and with `node_modules` moved aside
  `--check` still passed. The only npm import on that path is a dynamic
  `@tauri-apps/plugin-fs` in `backup.ts`, which only the window uses. So
  `bun install` is listed as setup advice, not something the probe proves.

### P1: the declared branch is not runnable (fixed)

`bidsvue-ingest` now declares `branch: neuroflow/window-ingest`, which has the
CLI, `--check` and the window mode. The requirements text says to switch it to
`main` once BIDSvue#18 merges. The checkout lookup also explains the local case
the review hit: a same-named sibling without the entry file is listed as
`.../bidsui (no scripts/neuroflow-ingest.ts)`, not left out silently.

### P2: gallery test gate red (fixed; the environment caused it)

The three MATLAB online-session tests also fail on `main`. They depend on
`runningMatlabRoots()` reading `ps -A`, which a sandbox can forbid; when it
does, the session check can't see sessions. The tests now skip with the reason
"ps -A is not available here" when `ps` fails, and still run on a normal
machine. `npm run test:gallery` result: 68 pass, 0 fail, 1 skipped.

## Internal audit

Fixed in this round:

- **JS/Rust checkout lookup parity.**
  - An invalid `NEUROFLOW_UI_APP_<APP>` override now falls through to the
    sibling, as `registry.rs` does.
  - The walk starts at the registry root and covers it plus two ancestors, as
    in `default_checkout`. It used to start one level lower and also tried
    `gallery/<repo>`.
  - A sibling must contain `entry`, so the `$TMPDIR/bidsui` WebKit cache can't
    be mistaken for the checkout.
- `app_cli.mjs` now checks that the inputs exist (`checkInputsExist`), as the
  other adapters do. It no longer passes the redundant `env: process.env`, and
  it logs the probe version.
- **Descriptions.** `launch.description`, the `app_cli.mjs` header and the docs
  now say `bun run scripts/neuroflow-ingest.ts`, which matches the args. The
  old wording was `bun run neuroflow-ingest -- ...`.
- **New tests.**
  - The sibling lookup without an override, including skipping a same-named
    directory that has no entry file.
  - An invalid override falling through.
  - A missing runner.
  - The probe gating a run and surfacing the app's problems.
  - check_tool's probe ready / needsSetup.
- **Docs.** README.md (test commands, the App CLI in the Environment panel),
  AGENTS.md (status, repo shape, tests, app-cli norms, merge order, deferred
  items) and gallery/README.md.

Checked clean: no shell injection (spawn takes argv arrays, and the template
only fills `{{session}}`, `{{outputDir}}` and `{{workDir}}`). Exit codes,
signals and env handling are fine, and there are no races in output checking.

Deferred (recorded in AGENTS.md):

- A table-driven adapter dispatch in `check_tool.mjs` and
  `src/data/registry.ts` (with `providerLabel`).
- Classifying script tools by `launch.script` instead of by which extension is
  present.
- Checking that a `core:result-dir` output is a directory, not just any path.
- Bounding the checkout walk at the NeuroFlow root.
- Tests for signal forwarding and spawn errors in `app_cli.mjs`.

Declined: reusing `mapOutputs` in `app_cli.mjs`. It moves files, but the app
already writes into the output directory, so an existence check is all that is
needed.

## Next steps

1. niivue/BIDSvue#16 (CI fix) merges first. Then rebase #17 and #18 onto it,
   since both fail the Windows check until then.
2. Merge BIDSvue#18 (headless CLI + `--check`), then NeuroFlow #12, #13 and #14.
3. After #18 merges, set `bidsvue-ingest`'s `branch` and requirements to `main`.
4. `neuroflow/window-ingest` (BIDSvue window mode) stays without a PR for now;
   the `bidsvue` window tool depends on it.
