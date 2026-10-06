import { useMemo, useState } from 'react'
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  FlaskConical,
  Plus,
  Search,
  Server,
  Sigma,
  Terminal,
  Wrench
} from 'lucide-react'
import type { ToolRegistryEntry, ToolProviderKind } from '../domain/registry'
import { categoryColor } from '../domain/registry'
import type { BlockCategory, ToolDefinition, WorkflowDocument, WorkflowStage } from '../domain/neuroflow'
import { BLOCK_CATEGORIES, shortType, WORKFLOW_STAGES } from '../domain/neuroflow'
import { isTypeCompatible } from '../domain/typeCompatibility'
import type { ToolStatus } from '../domain/host'
import { resolveToolDefinition } from '../domain/registry'

const PROVIDER_ICONS: Record<ToolProviderKind, typeof Wrench> = {
  console: Code2,
  webForm: Code2,
  webService: Server,
  uiApp: AppWindow,
  neuroflow: Wrench,
  script: Terminal,
  cli: Cpu,
  python: FlaskConical,
  matlab: Sigma,
  neurodesk: Server
}

const STAGE_FILTERS: Array<{ id: WorkflowStage | 'all'; label: string }> = [
  { id: 'all', label: 'All stages' },
  ...WORKFLOW_STAGES.map((stage) => ({ id: stage.id, label: stage.label }))
]

export type FitBadge = 'fit' | 'ready' | 'setup' | 'interactive' | 'unsupported'

interface ToolPaletteProps {
  registry: ToolRegistryEntry[]
  workflow: WorkflowDocument
  toolMap: Map<string, ToolDefinition>
  selectedStep: string | null
  toolStatuses: Map<string, ToolStatus>
  environmentChecked: boolean
  onAddTool: (toolId: string, blockId?: string) => void
}

export function ToolPalette({
  registry,
  workflow,
  toolMap,
  selectedStep,
  toolStatuses,
  environmentChecked,
  onAddTool
}: ToolPaletteProps): JSX.Element {
  const [search, setSearch] = useState('')
  const [stage, setStage] = useState<WorkflowStage | 'all'>('all')
  const [collapsed, setCollapsed] = useState<Set<BlockCategory>>(() => new Set())

  // Output types the next step could consume: the selected step's outputs, else the
  // last step's, else the workflow inputs. Drives the "fit" badge.
  const upstreamTypes = useMemo(() => upstreamOutputTypes(workflow, toolMap, selectedStep), [selectedStep, toolMap, workflow])

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return registry.filter((entry) => {
      if (stage !== 'all' && entry.stage !== stage) return false
      if (!q) return true
      return [entry.label, entry.description, entry.tool.name, entry.tool.id, entry.provider.label, entry.category]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [registry, search, stage])

  const groups = useMemo(() => {
    const byCategory = new Map<BlockCategory, ToolRegistryEntry[]>()
    for (const entry of filteredEntries) {
      byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry])
    }
    return BLOCK_CATEGORIES.filter((category) => byCategory.has(category)).map(
      (category) => [category, byCategory.get(category) as ToolRegistryEntry[]] as const
    )
  }, [filteredEntries])

  function toggle(category: BlockCategory): void {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  return (
    <section className="nf-panel nf-palette">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Gallery</p>
          <h2>Tools</h2>
        </div>
        <span className="nf-panel-count">{registry.length}</span>
      </header>

      <label className="nf-search-field">
        <Search size={13} />
        <input
          aria-label="Search tools"
          placeholder="Search tools"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      <div className="nf-segmented" aria-label="Stage filter">
        {STAGE_FILTERS.map((item) => (
          <button
            className={stage === item.id ? 'is-active' : ''}
            key={item.id}
            onClick={() => setStage(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="nf-block-list">
        {groups.map(([category, entries]) => {
          const isCollapsed = collapsed.has(category)
          return (
            <div className="nf-registry-group" key={category}>
              <button
                aria-expanded={!isCollapsed}
                className="nf-registry-group-header nf-registry-group-toggle"
                onClick={() => toggle(category)}
                type="button"
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <i className="nf-category-dot" style={{ background: categoryColor(category) }} />
                <strong>{category}</strong>
                <span>{entries.length}</span>
              </button>
              {!isCollapsed &&
                entries.map((entry) => (
                  <PaletteBlock
                    badge={badgeFor(entry, upstreamTypes, toolStatuses, environmentChecked)}
                    entry={entry}
                    key={entry.id}
                    status={toolStatuses.get(entry.tool.id)}
                    onAddTool={onAddTool}
                  />
                ))}
            </div>
          )
        })}
        {filteredEntries.length === 0 && <p className="nf-empty-panel">No matching tools.</p>}
      </div>
    </section>
  )
}

function PaletteBlock({
  entry,
  badge,
  status,
  onAddTool
}: {
  entry: ToolRegistryEntry
  badge: FitBadge | null
  status: ToolStatus | undefined
  onAddTool: (toolId: string, blockId?: string) => void
}): JSX.Element {
  const ProviderIcon = PROVIDER_ICONS[entry.provider.kind] ?? Wrench
  const color = categoryColor(entry.category)
  const title = status?.status === 'needsSetup' && status.fix
    ? `${status.detail}\nFix: ${status.fix}`
    : status?.detail ?? 'Drag to the canvas or click to add'

  return (
    <button
      className="nf-block nf-registry-card"
      draggable
      onClick={() => onAddTool(entry.tool.id, entry.block?.id)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData(
          'application/neuroflow-tool',
          JSON.stringify({ toolId: entry.tool.id, blockId: entry.block?.id })
        )
      }}
      style={{ borderLeftColor: color }}
      title={title}
      type="button"
    >
      <span className="nf-block-icon" style={{ color }}>
        <ProviderIcon size={16} />
      </span>
      <span>
        <strong>{entry.label}</strong>
        <small>{entry.description}</small>
      </span>
      <em className={badge ? `nf-badge nf-badge-${badge}` : 'nf-badge nf-badge-add'}>
        {badge ? BADGE_LABEL[badge] : <Plus size={12} />}
      </em>
      <div className="nf-registry-meta">
        <span title={entry.provider.source}>{entry.provider.label}</span>
        <span>v{entry.tool.version}</span>
        {entry.stage && <span>{entry.stage}</span>}
        {status?.version && <span title={status.executable ?? undefined}>{status.version}</span>}
      </div>
      {entry.fields.length > 0 && (
        <div className="nf-registry-fields">
          {entry.fields.slice(0, 4).map((field) => (
            <code key={field.key} title={field.description}>
              {field.key}:{shortType(field.type)}
            </code>
          ))}
        </div>
      )}
    </button>
  )
}

const BADGE_LABEL: Record<FitBadge, string> = {
  fit: 'fit',
  ready: 'ready',
  setup: 'setup',
  interactive: 'interactive',
  unsupported: 'no runner'
}

/**
 * Badge priority: an environment problem wins (setup / interactive / no runner),
 * then "fit" when the tool's required inputs can all be fed from upstream, then
 * "ready" when the host checked the tool, else nothing.
 */
function badgeFor(
  entry: ToolRegistryEntry,
  upstreamTypes: string[],
  statuses: Map<string, ToolStatus>,
  environmentChecked: boolean
): FitBadge | null {
  const status = statuses.get(entry.tool.id)
  if (status?.status === 'needsSetup') return 'setup'
  if (status?.status === 'interactive') return 'interactive'
  if (status?.status === 'unsupported') return 'unsupported'
  const fileInputs = entry.requiredInputs
    .map((name) => entry.tool.inputs[name])
    .filter((def) => def && !def.type.startsWith('core:'))
  if (fileInputs.length > 0 && fileInputs.every((def) => upstreamTypes.some((t) => isTypeCompatible(t, def.type)))) {
    return 'fit'
  }
  if (environmentChecked && status?.status === 'ready') return 'ready'
  return null
}

function upstreamOutputTypes(
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>,
  selectedStep: string | null
): string[] {
  const stepIds = Object.keys(workflow.steps)
  const sourceStep = selectedStep && workflow.steps[selectedStep] ? selectedStep : stepIds[stepIds.length - 1]
  const types = new Set<string>()
  if (sourceStep) {
    const tool = resolveToolDefinition(toolMap, workflow.steps[sourceStep].tool)
    for (const output of Object.values(tool?.outputs ?? {})) types.add(output.type)
  }
  if (types.size === 0) {
    for (const input of Object.values(workflow.inputs)) types.add(input.type)
  }
  return Array.from(types)
}
