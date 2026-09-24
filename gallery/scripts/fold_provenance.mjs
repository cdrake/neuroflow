#!/usr/bin/env node
/**
 * NeuroFlow runtime helper: fold a session's append-only provenance.jsonl trail
 * into a single conformant `kind: "provenance"` document
 * (neuroflow-spec/schemas/0.1/provenance.schema.json).
 *
 * Each jsonl line written by a tool during the run
 *   {"ts","step","tool","agent","action","outputs":{name: path|paths}, ...}
 * is mapped to PROV:
 *   - line.agent              -> an Agent (software)
 *   - line                    -> an Activity (one step execution)
 *   - each output path        -> an Entity (role: step-output), linked via generated
 *
 * Lineage from the lightweight log is shallow by design; the durable per-tool
 * provenance carries richer derivedFrom links. See
 * docs/neuroflow-session-contract.md.
 *
 * Env:
 *   NEUROFLOW_SESSION             session dir holding provenance.jsonl + context.json
 *   NEUROFLOW_OUTPUT_DIR          where to write run.provenance.json (default: session root)
 *   NEUROFLOW_RUN_ID              run identifier (default: session dir name)
 *   NEUROFLOW_RUN_STATUS          run status (default: completed)
 *   NEUROFLOW_WORKFLOW_ID         executed workflow id (default: from context.json or a placeholder)
 *   NEUROFLOW_WORKFLOW_VERSION    executed workflow version (default: 0.1.0)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

const session = process.env.NEUROFLOW_SESSION
if (!session) { console.error('fold_provenance: NEUROFLOW_SESSION is not set'); process.exit(1) }

function readJsonl(p) {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function readContext() {
  const p = join(session, 'context.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}

/** Map an output path to a NeuroFlow qualified type by extension. */
function typeForPath(p) {
  const s = String(p).toLowerCase().replace(/\/$/, '')
  if (s.endsWith('.nii') || s.endsWith('.nii.gz')) return 'neuro:volume'
  if (s.endsWith('.tsv') || s.endsWith('.csv')) return 'core:tabular'
  if (s.endsWith('.html') || s.endsWith('.htm') || s.endsWith('.pdf')) return 'neuro:report'
  if (s.endsWith('.patch.json')) return 'neurovue:correction-patch'
  if (s.endsWith('.json')) return 'core:json'
  if (s.endsWith('.zarr')) return 'neuro:ome-zarr'
  if (extname(s) === '') return 'core:directory'
  return 'core:file'
}

/** localId: ^[a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$ */
function toLocalId(x) {
  let s = String(x || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) s = 'step'
  if (!/^[a-z]/.test(s)) s = 's-' + s
  return s
}

/** documentId segment: [A-Za-z0-9][A-Za-z0-9._-]* */
function toIdSegment(x) {
  let s = String(x || 'run').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+/, '')
  return s || 'run'
}

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])

function main() {
  const lines = readJsonl(join(session, 'provenance.jsonl'))
  const ctx = readContext()

  const runId = toIdSegment(process.env.NEUROFLOW_RUN_ID || basename(session) || 'run')
  const wfId = process.env.NEUROFLOW_WORKFLOW_ID || ctx.workflow?.id || 'neuroflow.gallery/unknown-workflow'
  const wfVersion = process.env.NEUROFLOW_WORKFLOW_VERSION || ctx.workflow?.version || '0.1.0'
  const status = process.env.NEUROFLOW_RUN_STATUS || 'completed'

  const agents = new Map()      // agentName -> agent id
  const entities = new Map()    // path -> entity id
  const activities = []
  const outputs = {}            // "<step>.<name>[.<i>]" -> entity id
  let nAgent = 0, nEnt = 0, nAct = 0

  const agentId = (name) => {
    const key = name || 'unknown'
    if (!agents.has(key)) {
      const id = `agent-${++nAgent}`
      agents.set(key, id)
      agentList.push({ id, type: 'software', name: key })
    }
    return agents.get(key)
  }
  const agentList = []

  const entityId = (path, type) => {
    if (entities.has(path)) return entities.get(path)
    const id = `ent-${++nEnt}`
    entities.set(path, id)
    entityList.push({ id, type, role: 'step-output', path: String(path) })
    return id
  }
  const entityList = []

  const times = []
  for (const line of lines) {
    const stepId = toLocalId(line.step)
    const generated = []
    for (const [name, val] of Object.entries(line.outputs ?? {})) {
      const paths = toArray(val)
      paths.forEach((p, i) => {
        const eid = entityId(String(p), typeForPath(p))
        generated.push(eid)
        const key = paths.length > 1 ? `${stepId}.${name}.${i}` : `${stepId}.${name}`
        outputs[key] = eid
      })
    }
    const act = {
      id: `act-${++nAct}`,
      stepId,
      toolId: line.tool || `${wfId.split('/')[0] || 'neuroflow'}/unknown-tool`,
      agent: agentId(line.agent),
      startedAt: line.ts,
      status: 'completed',
    }
    if (generated.length) act.generated = generated
    activities.push(act)
    if (line.ts) times.push(line.ts)
  }

  times.sort()
  const doc = {
    $schema: '../../../neuroflow-spec/schemas/0.1/provenance.schema.json',
    neuroflow: '0.1.0',
    kind: 'provenance',
    id: `neuroflow.runs/${runId}`,
    version: '1.0.0',
    description: `Provenance for run ${runId}, folded from provenance.jsonl.`,
    run: {
      runId,
      startedAt: times[0] ?? new Date().toISOString(),
      endedAt: times[times.length - 1] ?? new Date().toISOString(),
      status,
    },
    workflow: { id: wfId, version: wfVersion },
    agents: agentList,
    activities,
    entities: entityList,
    outputs,
  }

  const outDir = process.env.NEUROFLOW_OUTPUT_DIR || session
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'run.provenance.json')
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')
  console.log(`fold_provenance: wrote ${outPath} (${activities.length} activities, ${entityList.length} entities, ${agentList.length} agents)`)
}

main()
