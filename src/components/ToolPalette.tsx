import {
  BadgeCheck,
  Download,
  Plus,
  Search,
  TableProperties,
  Upload,
  Wrench
} from 'lucide-react'
import type { BlockDef, ToolDefinition } from '../domain/neuroflow'

const ICONS = {
  Upload,
  TableProperties,
  Download,
  BadgeCheck
}

interface ToolPaletteProps {
  tools: ToolDefinition[]
  onAddTool: (toolId: string, blockId?: string) => void
}

export function ToolPalette({ tools, onAddTool }: ToolPaletteProps): JSX.Element {
  const blocks = tools.flatMap((tool) => {
    const blockList = Array.isArray(tool.block) ? tool.block : tool.block ? [tool.block] : []
    return blockList.map((block) => ({ block, tool }))
  })

  return (
    <section className="nf-panel nf-palette">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Blocks</p>
          <h2>Tool Palette</h2>
        </div>
        <Search size={16} />
      </header>
      <div className="nf-block-list">
        {blocks.map(({ block, tool }) => (
          <PaletteBlock
            key={`${tool.id}:${block.id}`}
            block={block}
            tool={tool}
            onAddTool={onAddTool}
          />
        ))}
      </div>
    </section>
  )
}

function PaletteBlock({
  block,
  tool,
  onAddTool
}: {
  block: BlockDef
  tool: ToolDefinition
  onAddTool: (toolId: string, blockId?: string) => void
}): JSX.Element {
  const Icon = block.icon && block.icon in ICONS ? ICONS[block.icon as keyof typeof ICONS] : Wrench
  return (
    <button
      className="nf-block"
      draggable
      onClick={() => onAddTool(tool.id, block.id)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData(
          'application/neuroflow-tool',
          JSON.stringify({ toolId: tool.id, blockId: block.id })
        )
      }}
      title="Drag to the canvas or click to add"
      type="button"
    >
      <span className="nf-block-icon">
        <Icon size={16} />
      </span>
      <span>
        <strong>{block.label}</strong>
        <small>{tool.name}</small>
      </span>
      <em>
        <Plus size={12} />
        {block.category}
      </em>
    </button>
  )
}
