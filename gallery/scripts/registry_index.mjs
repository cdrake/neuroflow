/**
 * registry_index.mjs: write `neuroflow-registry.json` for a registry folder, so
 * the builder can load the folder by URL once it is published as static files.
 *
 *   node registry_index.mjs <dir> [--title "Neurodesk web apps"] [--description "..."] [--check]
 *
 * Lists every NeuroFlow 0.1 tool and workflow document under <dir> (recursively,
 * skipping node_modules and dot folders) by its path relative to <dir>, sorted,
 * so the file only changes when the documents do. A browser cannot list a
 * folder over HTTP; this index is what it reads instead.
 *
 * --check writes nothing and exits 1 when the index on disk is missing or stale
 * (for CI that publishes the folder).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const INDEX_FILE = 'neuroflow-registry.json';
export const INDEX_KIND = 'neuroflow/registry-index';
const SPEC = /^0\.1(\.\d+)?$/;

export function collectDocuments(root) {
  const tools = [];
  const workflows = [];
  const skipped = [];
  const ids = new Map();
  for (const file of walk(root)) {
    const path = relative(root, file).split(sep).join('/');
    if (path === INDEX_FILE) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      skipped.push(`${path}: not valid JSON`);
      continue;
    }
    if (doc?.kind !== 'tool' && doc?.kind !== 'workflow') continue;
    if (typeof doc.neuroflow !== 'string' || !SPEC.test(doc.neuroflow)) {
      skipped.push(`${path}: NeuroFlow ${doc.neuroflow} is not 0.1`);
      continue;
    }
    if (typeof doc.id !== 'string' || !doc.id) {
      skipped.push(`${path}: no id`);
      continue;
    }
    if (ids.has(doc.id)) {
      skipped.push(`${path}: duplicate id ${doc.id} (also ${ids.get(doc.id)})`);
      continue;
    }
    ids.set(doc.id, path);
    (doc.kind === 'tool' ? tools : workflows).push(path);
  }
  return { tools: tools.sort(), workflows: workflows.sort(), skipped };
}

export function buildIndex(root, { title, description } = {}) {
  const { tools, workflows, skipped } = collectDocuments(root);
  const index = { neuroflow: '0.1.1', kind: INDEX_KIND };
  if (title) index.title = title;
  if (description) index.description = description;
  index.tools = tools;
  index.workflows = workflows;
  return { index, skipped };
}

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.json')) yield full;
  }
}

function main(argv) {
  const args = { check: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--title' || arg === '--description') args[arg.slice(2)] = argv[++i];
    else if (arg === '-h' || arg === '--help') args.help = true;
    else rest.push(arg);
  }
  if (args.help || rest.length !== 1) {
    console.error('usage: registry_index.mjs <dir> [--title T] [--description D] [--check]');
    return args.help ? 0 : 2;
  }
  const root = resolve(rest[0]);
  if (!existsSync(root)) {
    console.error(`no such folder: ${root}`);
    return 2;
  }
  const out = join(root, INDEX_FILE);
  // Keep the title and description already in the index unless new ones are given.
  const previous = existsSync(out) ? safeParse(readFileSync(out, 'utf8')) : null;
  const { index, skipped } = buildIndex(root, {
    title: args.title ?? previous?.title,
    description: args.description ?? previous?.description,
  });
  for (const note of skipped) console.error(`skipped ${note}`);
  const text = `${JSON.stringify(index, null, 2)}\n`;
  if (args.check) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (current !== text) {
      console.error(`${out} is out of date; run registry_index.mjs ${rest[0]}`);
      return 1;
    }
    console.log(`${out} is current (${index.tools.length} tools, ${index.workflows.length} workflows)`);
    return 0;
  }
  writeFileSync(out, text);
  console.log(`wrote ${out} (${index.tools.length} tools, ${index.workflows.length} workflows)`);
  return 0;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
