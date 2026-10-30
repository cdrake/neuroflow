# Vendored NeuroFlow spec files

Copied from [neuroflow-spec](https://github.com/cdrake/neuroflow-spec) at
`b279931` (spec 0.1.3) for `tests/spec_conformance.rs`:

- `schemas/`: `workflow`, `common` and `events` from `schemas/0.1/`, the files a
  workflow document is validated against.
- `examples/` and `examples/invalid/`: the spec's example documents whose `kind`
  is `workflow`. The core validates workflows only.

To refresh, with neuroflow-spec checked out next to this repository:

```sh
cd crates/neuroflow-conformance/tests/spec
cp ../../../../../neuroflow-spec/schemas/0.1/{workflow,common,events}.schema.json schemas/
for dir in "" invalid/; do
  for f in ../../../../../neuroflow-spec/examples/$dir*.json; do
    [ "$(jq -r .kind "$f")" = workflow ] && cp "$f" "examples/$dir"
  done
done
```

Then update the commit above and run `cargo test` in `crates/neuroflow-conformance`.
