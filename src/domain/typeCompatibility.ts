const COERCION_RULES: Record<string, string[]> = {
  'core:string': ['core:directory', 'core:file'],
  'core:directory': ['core:string'],
  'core:file': ['core:string'],
  'neuro:volume': ['core:file', 'core:string'],
  'neuro:ome-zarr': ['neuro:ngff-zarr', 'core:directory', 'core:string'],
  'neuro:ngff-zarr': ['neuro:ome-zarr', 'core:directory', 'core:file', 'core:json', 'core:string'],
  'neuro:tract': ['core:file', 'core:string'],
  'neuro:surface': ['core:file', 'core:string'],
  'neuro:mask': ['neuro:volume', 'core:file', 'core:string'],
  'neuro:statmap': ['neuro:volume', 'core:file', 'core:string'],
  'neuro:probseg': ['neuro:volume', 'core:file', 'core:string'],
  'neuro:cifti': ['core:file', 'core:string'],
  'neuro:gradient-table': ['core:file', 'core:string'],
  'neuro:connectivity-matrix': ['core:tabular', 'core:file', 'core:string'],
  'neuro:qc-metrics': ['core:json', 'core:file', 'core:string'],
  'neuro:report': ['core:file', 'core:string'],
  'core:tabular': ['core:file', 'core:string'],
  'neuro:bids-dataset': ['core:directory', 'core:string'],
  'neurovue:correction-patch': ['core:json', 'core:file', 'core:string']
}

export function isTypeCompatible(sourceType: string, inputType: string): boolean {
  if (sourceType === inputType) return true

  const allowed = COERCION_RULES[sourceType]
  if (allowed?.includes(inputType)) return true

  const sourceElement = arrayElementType(sourceType)
  const inputElement = arrayElementType(inputType)
  if (sourceElement && inputElement) {
    return isTypeCompatible(sourceElement, inputElement)
  }

  return false
}

export function arrayElementType(type: string): string | null {
  const match = /^core:array<(.+)>$/.exec(type)
  return match?.[1] ?? null
}
