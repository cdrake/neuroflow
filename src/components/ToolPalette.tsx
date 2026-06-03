import { useMemo, useState } from 'react'
import {
  BadgeCheck,
  Cloud,
  Code2,
  Download,
  FileText,
  FormInput,
  AppWindow,
  Plus,
  Search,
  TableProperties,
  Upload,
  Wrench
} from 'lucide-react'
import type { ToolRegistryEntry, ToolProviderKind } from '../domain/registry'
import { getSourceSuggestions } from '../domain/registry'
import type { WorkflowDocument, WorkflowStage } from '../domain/neuroflow'
import { shortType, stageInfo, WORKFLOW_STAGES } from '../domain/neuroflow'
import type { ToolDefinition } from '../domain/neuroflow'
import { getToolPackaging, packagingModeLabel, packagingTargetSummary } from '../domain/packaging'

const BLOCK_ICONS = {
  Upload,
  TableProperties,
  Download,
  BadgeCheck,
  FileText
}

const PROVIDER_ICONS = {
  console: Code2,
  webForm: FormInput,
  webService: Cloud,
  uiApp: AppWindow,
  neuroflow: Wrench
}

const PROVIDERS: Array<{ kind: ToolProviderKind | 'all'; label: string }> = [
  { kind: 'all', label: 'All' },
  { kind: 'console', label: 'Console' },
  { kind: 'webForm', label: 'Forms' },
  { kind: 'uiApp', label: 'Apps' },
  { kind: 'webService', label: 'Services' },
  { kind: 'neuroflow', label: 'Built-in' }
]

const STAGE_FILTERS: Array<{ id: WorkflowStage | 'all'; label: string }> = [
  { id: 'all', label: 'All stages' },
  ...WORKFLOW_STAGES.map((stage) => ({ id: stage.id, label: stage.label }))
]

// Stable display order for the grouped list; untagged tools fall into 'other'.
const STAGE_ORDER: Array<WorkflowStage | 'other'> = [
  ...WORKFLOW_STAGES.map((stage) => stage.id),
  'other'
]

function stageGroupLabel(group: WorkflowStage | 'other'): string {
  return group === 'other' ? 'Other' : stageInfo(group).label
}

interface ToolPaletteProps {
  registry: ToolRegistryEntry[]
  workflow: WorkflowDocument
  toolMap: Map<string, ToolDefinition>
  onAddTool: (toolId: string, blockId?: string) => void
}

export function ToolPalette({ registry, workflow, toolMap, onAddTool }: ToolPaletteProps): JSX.Element {
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState<ToolProviderKind | 'all'>('all')
  const [stage, setStage] = useState<WorkflowStage | 'all'>('all')

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return registry.filter((entry) => {
      const providerMatch = provider === 'all' || entry.provider.kind === provider
      if (!providerMatch) return false
      const stageMatch = stage === 'all' || entry.stage === stage
      if (!stageMatch) return false
      if (!q) return true
      return [entry.label, entry.description, entry.tool.name, entry.provider.label, entry.provider.source]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [provider, registry, search, stage])

  const groupedEntries = useMemo(() => {
    const groups = new Map<WorkflowStage | 'other', ToolRegistryEntry[]>()
    for (const entry of filteredEntries) {
      const key = entry.stage ?? 'other'
      groups.set(key, [...(groups.get(key) ?? []), entry])
    }
    return STAGE_ORDER.filter((key) => groups.has(key)).map(
      (key) => [key, groups.get(key) as ToolRegistryEntry[]] as const
    )
  }, [filteredEntries])

  return (
    <section className="nf-panel nf-palette">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Registry</p>
          <h2>Tools and Forms</h2>
        </div>
        <Search size={16} />
      </header>

      <label className="nf-search-field">
        <Search size={13} />
        <input
          aria-label="Search tool registry"
          placeholder="Search registry"
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

      <div className="nf-segmented" aria-label="Provider filter">
        {PROVIDERS.map((item) => (
          <button
            className={provider === item.kind ? 'is-active' : ''}
            key={item.kind}
            onClick={() => setProvider(item.kind)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="nf-block-list">
        {groupedEntries.map(([group, entries]) => (
          <div className="nf-registry-group" key={group}>
            <div className="nf-registry-group-header">
              <strong>{stageGroupLabel(group)}</strong>
              <span>{entries.length}</span>
            </div>
            {entries.map((entry) => (
              <PaletteBlock
                entry={entry}
                key={entry.id}
                toolMap={toolMap}
                workflow={workflow}
                onAddTool={onAddTool}
              />
            ))}
          </div>
        ))}
        {filteredEntries.length === 0 && <p className="nf-empty-panel">No matching registry entries.</p>}
      </div>
    </section>
  )
}

function PaletteBlock({
  entry,
  workflow,
  toolMap,
  onAddTool
}: {
  entry: ToolRegistryEntry
  workflow: WorkflowDocument
  toolMap: Map<string, ToolDefinition>
  onAddTool: (toolId: string, blockId?: string) => void
}): JSX.Element {
  const BlockIcon =
    entry.block?.icon && entry.block.icon in BLOCK_ICONS
      ? BLOCK_ICONS[entry.block.icon as keyof typeof BLOCK_ICONS]
      : Wrench
  const ProviderIcon = PROVIDER_ICONS[entry.provider.kind]
  const packaging = getToolPackaging(entry.tool)
  const satisfied = entry.requiredInputs.filter((inputName) => {
    const input = entry.tool.inputs[inputName]
    return input ? getSourceSuggestions(workflow, toolMap, input.type).length > 0 : false
  }).length

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
      title="Drag to the canvas or click to add"
      type="button"
    >
      <span className="nf-block-icon">
        <BlockIcon size={16} />
      </span>
      <span>
        <strong>{entry.label}</strong>
        <small>{entry.description}</small>
      </span>
      <em>
        <Plus size={12} />
        {entry.category}
      </em>
      <div className="nf-registry-meta">
        <span title={entry.provider.source}>
          <ProviderIcon size={12} />
          {entry.provider.label}
        </span>
        <span title={packagingTargetSummary(packaging)}>
          v{entry.tool.version} {packagingModeLabel(packaging)}
        </span>
        <span>
          {satisfied}/{entry.requiredInputs.length} inputs
        </span>
        {entry.formComponent && <span>{entry.formComponent}</span>}
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
