# Registry bundles: one builder on the web and on the desktop

Status: first pass

A registry bundle is a folder of NeuroFlow tool and workflow documents, plus
whatever scripts they launch. The NeuroFlow builder loads bundles at run time,
so a project that generates its own tools does not need to fork or rebuild the
builder. It can publish the bundle and give its users two ways in. Both use the
same page:

| | Hosted builder (browser) | Desktop app (Tauri) |
|---|---|---|
| Gets the bundle from | `?registry=<url>`, **Registries → URL**, or **Folder** | its **Registry directories** (Environment settings) |
| Browse, compose, validate | yes | yes |
| Export / import workflow JSON | yes | yes |
| Run | simulated only | yes, on the `neuroflow-mcp` runtime |

This is the pattern the Neurodesk web apps already follow: they are a web
site, and their desktop suite runs the same code without a browser. With a
bundle you author workflows on the website, export them, and run them on the
desktop. The workflow file is the same in both places.

## Neurodesk web apps, step by step

### 1. Generate the bundle

In a `neurodesk/webapps` checkout:

```bash
node scripts/generate-neuroflow.mjs --out dist/neuroflow
```

This writes one tool per app operation (`tools/<app>/<operation>.tool.json`,
ids like `neurodesk.webapps/brain-extraction/extract`) and the launcher
`scripts/neurodesk.mjs`. The launcher drives the desktop suite through its MCP
interface, so running the tools needs the suite installed.

### 2. Index it

A browser cannot list a folder over HTTP. It reads `neuroflow-registry.json`
instead:

```bash
node <neuroflow>/gallery/scripts/registry_index.mjs dist/neuroflow --title "Neurodesk web apps"
```

```json
{
  "neuroflow": "0.1.1",
  "kind": "neuroflow/registry-index",
  "title": "Neurodesk web apps",
  "tools": ["tools/ants/register.tool.json", "tools/brain-extraction/extract.tool.json", "…"],
  "workflows": []
}
```

The index behaves like this:

- Paths are relative to the index and sorted, so the file changes only when the
  documents do.
- It finds tools and workflows in any subfolder.
- Re-running it keeps the title.
- `--check` exits 1 when the index is stale. Use it in CI.

The generator refuses an output folder that is not empty or an identical
bundle. Run the indexer after the generator, and regenerate into a clean
folder. If you can, have the generator write the index itself: it is a small,
fixed format, as shown above.

To ship ready-made workflows, put `*.workflow.json` files in the folder, for
example `workflows/`, before indexing. They appear in the builder's library.

### 3. Publish it

Any static host works. The documents are fetched from the builder's page, so
the host must allow cross-origin reads (`Access-Control-Allow-Origin: *`).
GitHub Pages and most CDNs send that header for static files. If you serve the
bundle and the builder from the same site, no CORS setup is needed.

```text
https://<org>.github.io/webapps/neuroflow/neuroflow-registry.json
https://<org>.github.io/webapps/neuroflow/tools/brain-extraction/extract.tool.json
…
```

Only the JSON documents are fetched. The `scripts/` folder is published so the
bundle can be downloaded as a whole, but the browser never runs it.

### 4. Link to the builder

Open the builder with the bundle preloaded:

```text
https://<builder-host>/?registry=https://<org>.github.io/webapps/neuroflow/
```

Some rules for the URL:

- A URL ending in `/` gets `neuroflow-registry.json` appended.
- `registry` can repeat, to load several bundles.
- A deployment can preload bundles for every visitor by setting
  `VITE_NEUROFLOW_REGISTRIES` (comma separated) at build time.
- Bundles a user adds with **Registries → URL** are remembered in that browser.

The builder is a static site (`npm run build` → `dist/`). It uses relative
asset paths, so it can be served from a subpath of the same site.

In the browser, users can do the following:

- Find the bundle's tools in the palette, labelled with their
  `neuroflow/mcp` title (for example "Brain extraction: Extract brain").
- Wire them into workflows next to the gallery's own tools.
- Validate the result.
- Save it with **Export JSON**.
- Open a workflow file with **Import JSON**.

**Registries → Folder** loads an unpublished bundle from disk for the current
session. This is useful while developing the generator.

### 5. Run on the desktop

1. Install the NeuroFlow desktop app (or run `npm run tauri:dev`).
2. Add the bundle folder, the one downloaded or generated in step 1, to
   **Environment → Settings → Registry directories**.
3. Point the launcher at the suite, if it is not on `PATH` as
   `neurodesk-webapps`:

   ```bash
   export NEURODESK_WEBAPPS=/Applications/Neurodesk\ Webapps.app/Contents/MacOS/neurodesk-webapps
   ```

The desktop palette then lists what those folders contain, which is what it can
run. The environment check marks anything that still needs setup. Use **Import
JSON** to open a workflow exported from the website, then **Run**.

The same folder works with `neuroflow-mcp --registry <folder>`, which runs
the workflows for agents.

## How the builder combines sources

Sources load in this order:

1. The bundled gallery.
2. The desktop's registry folders.
3. URL and folder bundles, in the order added.

When two sources define the same id, the first one keeps it. A later copy that
is identical is dropped silently, which covers the desktop's gallery folder
repeating the bundled gallery. A different copy is listed in the Registries
panel as a conflict. Documents that are not NeuroFlow 0.1 tools or workflows,
or are unreadable, are skipped and listed per source.

Workflows from a bundle join the workspace once. After that they are the user's
copies, kept in the browser's local storage like any other edited workflow.

Code:

- `src/data/registrySources.ts`: loading and merging.
- `src/components/RegistrySources.tsx`: the panel.
- `registry_documents` in `src-tauri/src/host.rs`: the desktop's folders.
- `gallery/scripts/registry_index.mjs`: the index.
