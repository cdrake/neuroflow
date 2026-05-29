import type { ToolDefinition } from './neuroflow'

export const PACKAGING_EXTENSION_KEY = 'neuroflow/packaging'

export type ToolPlatformOS = 'macos' | 'linux' | 'windows' | 'web' | 'service'
export type ToolPlatformArch = 'arm64' | 'x64' | 'wasm32' | 'universal'
export type ToolAccelerator = 'cpu' | 'cuda' | 'metal' | 'webgpu'
export type ToolReproducibilityLevel = 'locked' | 'versioned' | 'bestEffort'
export type ToolInstallProbeKind = 'command' | 'path' | 'env' | 'service' | 'appBundle' | 'container'
export type ToolInstallSourceKind =
  | 'bundledBinary'
  | 'download'
  | 'packageManager'
  | 'container'
  | 'instructions'
  | 'userProvided'
export type ToolBundleMode = 'definitionOnly' | 'instructions' | 'sidecarBinary' | 'container' | 'service'

export interface ToolPlatformTarget {
  os: ToolPlatformOS
  arch: ToolPlatformArch
  accelerator?: ToolAccelerator
  libc?: 'glibc' | 'musl'
  label?: string
}

export interface ToolVersionQualifier {
  exact?: string
  range?: string
  resolvesTo?: string
}

export interface ToolInstallProbe {
  kind: ToolInstallProbeKind
  description: string
  command?: string
  args?: string[]
  path?: string
  env?: string
  serviceUrl?: string
  versionCommand?: string[]
  versionRegex?: string
  versionGroup?: number
  expectedVersion?: ToolVersionQualifier
  required?: boolean
}

export interface ToolLocationPrompt {
  id: string
  label: string
  description: string
  pathKind: 'file' | 'directory' | 'appBundle' | 'url'
  required?: boolean
  defaultPath?: string
  validator?: ToolInstallProbe
}

export interface ToolInstallSource {
  kind: ToolInstallSourceKind
  label: string
  platform?: ToolPlatformTarget
  version?: string
  uri?: string
  sha256?: string
  packageManager?: 'brew' | 'conda' | 'pipx' | 'apt' | 'winget' | 'docker'
  packageName?: string
  executablePath?: string
  installCommand?: string
  instructions?: string[]
  license?: string
}

export interface ToolBundlingPolicy {
  mode: ToolBundleMode
  includesBinaries?: boolean
  lockRequired?: boolean
  notes?: string
}

export interface ToolPackagingSpec {
  packageId: string
  version: string
  versionQualifier?: ToolVersionQualifier
  reproducibility: ToolReproducibilityLevel
  platforms: ToolPlatformTarget[]
  probes?: ToolInstallProbe[]
  userPrompts?: ToolLocationPrompt[]
  install?: ToolInstallSource[]
  bundling: ToolBundlingPolicy
}

export function getToolPackaging(tool: ToolDefinition): ToolPackagingSpec | null {
  const raw = tool.extensions?.[PACKAGING_EXTENSION_KEY]
  return isObject(raw) ? (raw as unknown as ToolPackagingSpec) : null
}

export function packagingModeLabel(packaging: ToolPackagingSpec | null): string {
  if (!packaging) return 'no package'

  switch (packaging.bundling.mode) {
    case 'definitionOnly':
      return 'definition'
    case 'instructions':
      return 'instructions'
    case 'sidecarBinary':
      return 'sidecar'
    case 'container':
      return 'container'
    case 'service':
      return 'service'
  }
}

export function platformTargetLabel(target: ToolPlatformTarget): string {
  if (target.label) return target.label

  const os = target.os === 'macos' ? 'macOS' : target.os
  const accelerator = target.accelerator && target.accelerator !== 'cpu'
    ? ` ${target.accelerator.toUpperCase()}`
    : ''
  const libc = target.libc ? ` ${target.libc}` : ''
  return `${os} ${target.arch}${libc}${accelerator}`
}

export function packagingTargetSummary(packaging: ToolPackagingSpec | null): string {
  if (!packaging) return 'No install target declared'

  if (packaging.platforms.length === 0) return 'No install target declared'
  if (packaging.platforms.length === 1) return platformTargetLabel(packaging.platforms[0])

  return `${platformTargetLabel(packaging.platforms[0])} +${packaging.platforms.length - 1}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
