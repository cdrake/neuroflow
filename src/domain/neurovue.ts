import type { ToolDefinition, ToolIOFormat, WorkflowDocument } from './neuroflow'
import { buildToolMap, resolveToolDefinition } from './registry'

export const NEUROVUE_VIEWER_HOST = 'http://127.0.0.1:8087'
export const NEUROVUE_DESKTOP_MANIFEST = '/iiif/desktop/neuro/manifest'
export const NEUROVUE_DEFAULT_OME_ZARR_ID = 'pawpawsaurus.ome.zarr'

export type NeuroVueAssetKind = 'dataset' | 'volume' | 'omezarr' | 'tract' | 'mesh'
export type NeuroVueBackend = 'webgl2' | 'webgpu'
export type NeuroVueCorrectionMode = 'inspect' | 'defaceMask' | 'crop' | 'landmark'
export type NeuroVueClipAxis = 'axial' | 'coronal' | 'sagittal' | 'oblique'

export interface NeuroVueAsset {
  id: string
  label: string
  detail: string
  kind: NeuroVueAssetKind
  sourceRef: string
  sourceType: string
  formats: ToolIOFormat[]
  manifest?: string
  volumeId?: string
  omezarrId?: string
  fromSelectedStep?: boolean
}

export interface NeuroVueClipPlane {
  id: string
  label: string
  axis: NeuroVueClipAxis
  enabled: boolean
  depth: number
  azimuth: number
  elevation: number
  opacity: number
}

export interface NeuroVueViewerUrlOptions {
  host?: string
  backend: NeuroVueBackend
}

export interface NeuroVueCorrectionPatch {
  neurovue: string
  asset: {
    id: string
    kind: NeuroVueAssetKind
    sourceRef: string
    sourceType: string
  }
  correctionMode: NeuroVueCorrectionMode
  backend: NeuroVueBackend
  clipPlanes: Array<Pick<NeuroVueClipPlane, 'label' | 'axis' | 'depth' | 'azimuth' | 'elevation' | 'opacity'>>
  createdAt: string
}

const DEFAULT_ASSETS: NeuroVueAsset[] = [
  {
    id: 'reference:volume-desktop',
    label: 'IIIF desktop dataset',
    detail: 'VolumeDesktop manifest from the local volumetric server.',
    kind: 'dataset',
    sourceRef: NEUROVUE_DESKTOP_MANIFEST,
    sourceType: 'neuro:volume-desktop',
    formats: ['nifti'],
    manifest: NEUROVUE_DESKTOP_MANIFEST
  },
  {
    id: 'reference:omezarr',
    label: 'OME-Zarr pyramid',
    detail: 'Pyramid volume through the OME-Zarr reference viewer.',
    kind: 'omezarr',
    sourceRef: NEUROVUE_DEFAULT_OME_ZARR_ID,
    sourceType: 'neuro:ome-zarr',
    formats: ['omezarr'],
    omezarrId: NEUROVUE_DEFAULT_OME_ZARR_ID
  }
]

export function defaultNeuroVueClipPlanes(): NeuroVueClipPlane[] {
  return [
    {
      id: 'clip-a',
      label: 'Anterior',
      axis: 'sagittal',
      enabled: true,
      depth: 0.1,
      azimuth: 180,
      elevation: 20,
      opacity: 0.3
    },
    {
      id: 'clip-b',
      label: 'Inferior',
      axis: 'axial',
      enabled: true,
      depth: 0.1,
      azimuth: 0,
      elevation: -90,
      opacity: 0.3
    }
  ]
}

export function buildNeuroVueAssets(
  workflow: WorkflowDocument,
  tools: ToolDefinition[],
  selectedStep: string | null
): NeuroVueAsset[] {
  const toolMap = buildToolMap(tools)
  const assets: NeuroVueAsset[] = []
  const seen = new Set<string>()
  const stepEntries = Object.entries(workflow.steps)

  for (const [stepId, step] of stepEntries) {
    const tool = resolveToolDefinition(toolMap, step.tool)
    if (!tool) continue

    for (const [outputName, output] of Object.entries(tool.outputs)) {
      const kind = previewKindForOutput(output.type, formatsForOutput(output))
      if (!kind) continue

      const sourceRef = `steps.${stepId}.outputs.${outputName}`
      pushUnique(assets, seen, {
        id: sourceRef,
        label: `${stepId}.${outputName}`,
        detail: `${tool.name} output (${output.type})`,
        kind,
        sourceRef,
        sourceType: output.type,
        formats: formatsForOutput(output),
        manifest: kind === 'volume' || kind === 'dataset' ? NEUROVUE_DESKTOP_MANIFEST : undefined,
        omezarrId: kind === 'omezarr' ? NEUROVUE_DEFAULT_OME_ZARR_ID : undefined,
        fromSelectedStep: stepId === selectedStep
      })
    }
  }

  for (const [name, output] of Object.entries(workflow.outputs)) {
    const kind = previewKindForOutput(output.type, [])
    if (!kind) continue

    pushUnique(assets, seen, {
      id: `workflow.outputs.${name}`,
      label: `workflow.${name}`,
      detail: `Workflow output (${output.type})`,
      kind,
      sourceRef: output.ref,
      sourceType: output.type,
      formats: [],
      manifest: kind === 'volume' || kind === 'dataset' ? NEUROVUE_DESKTOP_MANIFEST : undefined,
      omezarrId: kind === 'omezarr' ? NEUROVUE_DEFAULT_OME_ZARR_ID : undefined
    })
  }

  for (const asset of DEFAULT_ASSETS) {
    pushUnique(assets, seen, asset)
  }

  return assets.sort((a, b) => {
    if (a.fromSelectedStep !== b.fromSelectedStep) return a.fromSelectedStep ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

export function buildNeuroVueViewerUrl(
  asset: NeuroVueAsset,
  options: NeuroVueViewerUrlOptions
): string {
  const host = options.host ?? NEUROVUE_VIEWER_HOST
  const url = new URL(
    asset.kind === 'omezarr' ? '/omezarr.html' : '/osd-volume-desktop.html',
    host.endsWith('/') ? host : `${host}/`
  )

  if (asset.kind === 'omezarr') {
    url.searchParams.set('id', asset.omezarrId ?? NEUROVUE_DEFAULT_OME_ZARR_ID)
    url.searchParams.set('backend', options.backend)
  } else {
    url.searchParams.set('manifest', asset.manifest ?? NEUROVUE_DESKTOP_MANIFEST)
    if (asset.volumeId) url.searchParams.set('volume', asset.volumeId)
    url.searchParams.set('backend', options.backend)
  }

  url.searchParams.set('neurovueAsset', asset.id)
  return url.toString()
}

export function createNeuroVueCorrectionPatch(
  asset: NeuroVueAsset,
  correctionMode: NeuroVueCorrectionMode,
  backend: NeuroVueBackend,
  clipPlanes: NeuroVueClipPlane[]
): NeuroVueCorrectionPatch {
  return {
    neurovue: '0.1.0',
    asset: {
      id: asset.id,
      kind: asset.kind,
      sourceRef: asset.sourceRef,
      sourceType: asset.sourceType
    },
    correctionMode,
    backend,
    clipPlanes: clipPlanes
      .filter((plane) => plane.enabled)
      .map(({ label, axis, depth, azimuth, elevation, opacity }) => ({
        label,
        axis,
        depth,
        azimuth,
        elevation,
        opacity
      })),
    createdAt: new Date().toISOString()
  }
}

function previewKindForOutput(type: string, formats: ToolIOFormat[]): NeuroVueAssetKind | null {
  const normalizedType = type.toLowerCase()
  if (normalizedType.includes('bids-dataset')) return 'dataset'
  if (normalizedType.includes('ome-zarr') || normalizedType.includes('omezarr')) return 'omezarr'
  if (normalizedType.includes('tract')) return 'tract'
  if (normalizedType.includes('mesh') || normalizedType.includes('surface')) return 'mesh'
  if (normalizedType.includes('volume') || formats.includes('nifti')) return 'volume'
  if (formats.includes('omezarr')) return 'omezarr'
  if (formats.includes('tract')) return 'tract'
  if (formats.includes('mesh')) return 'mesh'
  return null
}

function formatsForOutput(output: ToolDefinition['outputs'][string]): ToolIOFormat[] {
  const formats = new Set<ToolIOFormat>()
  for (const source of output.availableFrom ?? []) {
    if (source.format) formats.add(source.format)
  }
  return Array.from(formats)
}

function pushUnique(assets: NeuroVueAsset[], seen: Set<string>, asset: NeuroVueAsset): void {
  if (seen.has(asset.id)) return
  seen.add(asset.id)
  assets.push(asset)
}
