import { useEffect, useMemo, useState } from 'react'
import { AppWindow, Box, ExternalLink } from 'lucide-react'
import type { ToolDefinition, WorkflowDocument } from '../domain/neuroflow'
import {
  buildNeuroVueAssets,
  buildNeuroVueViewerUrl,
  NEUROVUE_VIEWER_HOST
} from '../domain/neurovue'

interface WorkflowAppsPanelProps {
  workflow: WorkflowDocument
  tools: ToolDefinition[]
  selectedStep: string | null
}

export function WorkflowAppsPanel({
  workflow,
  tools,
  selectedStep
}: WorkflowAppsPanelProps): JSX.Element {
  const assets = useMemo(
    () => buildNeuroVueAssets(workflow, tools, selectedStep),
    [selectedStep, tools, workflow]
  )
  const [selectedAssetId, setSelectedAssetId] = useState(assets[0]?.id ?? '')

  useEffect(() => {
    if (assets.some((asset) => asset.id === selectedAssetId)) return
    setSelectedAssetId(assets[0]?.id ?? '')
  }, [assets, selectedAssetId])

  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) ?? assets[0]
  const launchUrl = selectedAsset
    ? buildNeuroVueViewerUrl(selectedAsset, { backend: 'webgl2', host: NEUROVUE_VIEWER_HOST })
    : NEUROVUE_VIEWER_HOST

  return (
    <section className="nf-panel nf-apps-panel">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Pipeline Apps</p>
          <h2>External Sessions</h2>
        </div>
        <AppWindow size={16} />
      </header>

      <div className="nf-app-session">
        <div className="nf-app-session-head">
          <span>
            <Box size={14} />
            NeuroVue
          </span>
          <em>external</em>
        </div>

        <label className="nf-field">
          <span>Artifact</span>
          <select
            disabled={assets.length === 0}
            value={selectedAsset?.id ?? ''}
            onChange={(event) => setSelectedAssetId(event.target.value)}
          >
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.fromSelectedStep ? '* ' : ''}{asset.label}
              </option>
            ))}
          </select>
        </label>

        <div className="nf-app-session-meta">
          <small>{selectedAsset?.detail ?? 'No previewable artifacts.'}</small>
          <code>{selectedAsset?.sourceRef ?? 'neuroflow.viewers/neurovue'}</code>
        </div>

        <a className="nf-action nf-action-primary" href={launchUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          Launch NeuroVue
        </a>
      </div>
    </section>
  )
}
