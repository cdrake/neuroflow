import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'
import {
  PACKAGING_EXTENSION_KEY,
  type ToolPackagingSpec,
  type ToolPlatformTarget
} from '../domain/packaging'

const REGISTRY_EXTENSION = 'neuroflow/registry'
const MACOS_ARM64: ToolPlatformTarget = { os: 'macos', arch: 'arm64', label: 'macOS Apple Silicon' }
const MACOS_X64: ToolPlatformTarget = { os: 'macos', arch: 'x64', label: 'macOS Intel' }
const LINUX_X64: ToolPlatformTarget = { os: 'linux', arch: 'x64', libc: 'glibc', label: 'Linux x64 glibc' }
const WINDOWS_X64: ToolPlatformTarget = { os: 'windows', arch: 'x64', label: 'Windows x64' }
const WEB_SERVICE: ToolPlatformTarget = { os: 'service', arch: 'universal', label: 'Remote service' }
const WEB_BROWSER: ToolPlatformTarget = { os: 'web', arch: 'wasm32', accelerator: 'webgpu', label: 'Web browser' }

function packaging(spec: ToolPackagingSpec): Record<typeof PACKAGING_EXTENSION_KEY, ToolPackagingSpec> {
  return { [PACKAGING_EXTENSION_KEY]: spec }
}

const NIIVUE_CONSOLE_PROVIDER = {
  [REGISTRY_EXTENSION]: {
    provider: {
      kind: 'console',
      label: 'NiiVue console app',
      source: '~/Dev/niivue/niivue/packages/niivue-desktop/workflows/tools',
      runtime: 'sidecar'
    },
    executor: {
      kind: 'console',
      commandId: 'neuroflow.echo',
      label: 'NiiVue command adapter'
    }
  }
}

const BIDSVUE_CONSOLE_PROVIDER = {
  [REGISTRY_EXTENSION]: {
    provider: {
      kind: 'console',
      label: 'BIDSvue importer',
      source: '~/Dev/bidsui/resources/common/importers',
      runtime: 'sidecar'
    },
    executor: {
      kind: 'console',
      commandId: 'neuroflow.echo',
      label: 'BIDSvue command adapter'
    }
  }
}

const NEUROFLOW_PROVIDER = {
  [REGISTRY_EXTENSION]: {
    provider: {
      kind: 'neuroflow',
      label: 'NeuroFlow component',
      source: 'NeuroFlow built-in registry',
      runtime: 'internal'
    },
    executor: {
      kind: 'internal',
      handler: 'neuroflow.synthetic',
      label: 'NeuroFlow internal adapter'
    }
  }
}

const WEB_FORM_PROVIDER = {
  [REGISTRY_EXTENSION]: {
    provider: {
      kind: 'webForm',
      label: 'Review form',
      source: 'NiiVue Desktop form metadata',
      runtime: 'browser'
    },
    executor: {
      kind: 'internal',
      handler: 'neuroflow.form',
      label: 'Browser form adapter'
    }
  }
}

const NIIVUE_UI_APP_PROVIDER = {
  [REGISTRY_EXTENSION]: {
    provider: {
      kind: 'uiApp',
      label: 'NiiVue desktop UI app',
      source: '~/Dev/niivue/niivue/packages/niivue-desktop/apps',
      runtime: 'desktop'
    },
    executor: {
      kind: 'uiApp',
      appId: 'niivue.desktop.bids-classifier',
      label: 'NiiVue BIDS classifier',
      completion: 'appClosed',
      dryRun: true
    }
  }
}

const NEUROVUE_UI_APP_PROVIDER = {
  [REGISTRY_EXTENSION]: {
    provider: {
      kind: 'uiApp',
      label: 'NeuroVue external viewer app',
      source: '~/Dev/neurovue',
      runtime: 'browser'
    },
    executor: {
      kind: 'uiApp',
      appId: 'neurovue.viewer',
      label: 'NeuroVue viewer session',
      completion: 'appClosed',
      dryRun: true
    }
  }
}

const DCM2NIIX_PACKAGING = packaging({
  packageId: 'dcm2niix',
  version: '1.0.0',
  versionQualifier: { exact: '1.0.0' },
  reproducibility: 'versioned',
  platforms: [MACOS_ARM64, MACOS_X64, LINUX_X64, WINDOWS_X64],
  probes: [
    {
      kind: 'command',
      command: 'dcm2niix',
      args: ['-h'],
      versionRegex: 'dcm2niiX version\\s+([^\\s]+)',
      versionGroup: 1,
      expectedVersion: { exact: '1.0.0' },
      description: 'Check PATH for an existing dcm2niix executable and capture its reported version.'
    },
    {
      kind: 'env',
      env: 'NEUROFLOW_DCM2NIIX',
      versionCommand: ['-h'],
      versionRegex: 'dcm2niiX version\\s+([^\\s]+)',
      versionGroup: 1,
      expectedVersion: { exact: '1.0.0' },
      description: 'Use a user-provided dcm2niix executable when it is not on PATH.'
    }
  ],
  userPrompts: [
    {
      id: 'dcm2niix_executable',
      label: 'dcm2niix executable',
      description: 'Select the dcm2niix binary to use for this platform build.',
      pathKind: 'file',
      validator: {
        kind: 'command',
        args: ['-h'],
        versionRegex: 'dcm2niiX version\\s+([^\\s]+)',
        versionGroup: 1,
        expectedVersion: { exact: '1.0.0' },
        description: 'Validate the selected binary by running its help/version output.'
      }
    }
  ],
  install: [
    {
      kind: 'packageManager',
      label: 'Install dcm2niix with Homebrew',
      platform: MACOS_ARM64,
      packageManager: 'brew',
      packageName: 'dcm2niix',
      installCommand: 'brew install dcm2niix'
    },
    {
      kind: 'instructions',
      label: 'Use a site-managed dcm2niix install',
      instructions: [
        'Install dcm2niix through the local research computing environment.',
        'Point NeuroFlow to the executable if it is not discoverable on PATH.'
      ]
    }
  ],
  bundling: {
    mode: 'instructions',
    includesBinaries: false,
    lockRequired: true,
    notes: 'Install builds can promote this to sidecarBinary once platform artifacts and sha256 hashes are attached.'
  }
})

const NIIVUE_TOOL_PACKAGING = packaging({
  packageId: 'niivue-desktop-tools',
  version: '1.0.0',
  versionQualifier: { exact: '1.0.0' },
  reproducibility: 'versioned',
  platforms: [MACOS_ARM64, MACOS_X64, LINUX_X64],
  probes: [
    {
      kind: 'path',
      path: '~/Dev/niivue/niivue/packages/niivue-desktop',
      description: 'Use a local NiiVue Desktop checkout during development builds.'
    }
  ],
  userPrompts: [
    {
      id: 'niivue_desktop_root',
      label: 'NiiVue Desktop checkout',
      description: 'Select the NiiVue Desktop project root for development-only tool adapters.',
      pathKind: 'directory',
      defaultPath: '~/Dev/niivue/niivue/packages/niivue-desktop'
    }
  ],
  install: [
    {
      kind: 'instructions',
      label: 'Build NiiVue Desktop tools from source',
      instructions: [
        'Use the pinned NiiVue checkout recorded in the workflow bundle lock.',
        'Build the platform-specific tool adapter before packaging NeuroFlow.'
      ]
    }
  ],
  bundling: {
    mode: 'instructions',
    includesBinaries: false,
    lockRequired: true
  }
})

const BIDSVUE_IMPORTER_PACKAGING = packaging({
  packageId: 'bidsvue-importers',
  version: '1.0.0',
  versionQualifier: { exact: '1.0.0' },
  reproducibility: 'versioned',
  platforms: [MACOS_ARM64, MACOS_X64, LINUX_X64],
  probes: [
    {
      kind: 'path',
      path: '~/Dev/bidsui/resources/common/importers',
      description: 'Find BIDSvue importer definitions in the local BIDS UI checkout.'
    }
  ],
  userPrompts: [
    {
      id: 'bidsvue_importers_root',
      label: 'BIDSvue importer directory',
      description: 'Select the BIDSvue importer definition directory when it cannot be discovered.',
      pathKind: 'directory',
      defaultPath: '~/Dev/bidsui/resources/common/importers'
    }
  ],
  bundling: {
    mode: 'definitionOnly',
    includesBinaries: false,
    lockRequired: true,
    notes: 'Importer definitions are bundled with versioned tool contracts; external executables are resolved separately.'
  }
})

const NEUROVUE_PACKAGING = packaging({
  packageId: 'neurovue',
  version: '0.1.0',
  versionQualifier: { exact: '0.1.0' },
  reproducibility: 'versioned',
  platforms: [WEB_BROWSER, MACOS_ARM64, MACOS_X64],
  probes: [
    {
      kind: 'service',
      serviceUrl: 'http://127.0.0.1:8087/osd-volume-desktop.html',
      description: 'Check for a running NeuroVue or volumetric preview service.'
    },
    {
      kind: 'path',
      path: '~/Dev/neurovue',
      description: 'Use the local NeuroVue checkout during development.'
    }
  ],
  userPrompts: [
    {
      id: 'neurovue_url',
      label: 'NeuroVue launch URL',
      description: 'Provide the NeuroVue URL or app endpoint used for viewer sessions.',
      pathKind: 'url',
      defaultPath: 'http://127.0.0.1:8087'
    }
  ],
  install: [
    {
      kind: 'instructions',
      label: 'Start NeuroVue from its own repository',
      instructions: [
        'Build or start NeuroVue from the version recorded in the bundle lock.',
        'Expose the viewer launch URL to NeuroFlow as an external UI app session.'
      ]
    }
  ],
  bundling: {
    mode: 'instructions',
    includesBinaries: false,
    lockRequired: true,
    notes: 'NeuroVue remains a separate app; NeuroFlow bundles only launch and output contracts.'
  }
})

const OPENNEURO_SERVICE_PACKAGING = packaging({
  packageId: 'openneuro-dataset-service',
  version: '1.0.0',
  versionQualifier: { exact: '1.0.0' },
  reproducibility: 'bestEffort',
  platforms: [WEB_SERVICE],
  probes: [
    {
      kind: 'service',
      serviceUrl: 'https://openneuro.org',
      description: 'Verify the OpenNeuro service is reachable before resolving remote datasets.'
    }
  ],
  bundling: {
    mode: 'service',
    includesBinaries: false,
    lockRequired: false,
    notes: 'Remote services require captured request metadata and response provenance for reproducibility.'
  }
})

const NEUROFLOW_INTERNAL_PACKAGING = packaging({
  packageId: 'neuroflow-runtime',
  version: '0.1.0',
  versionQualifier: { exact: '0.1.0' },
  reproducibility: 'locked',
  platforms: [MACOS_ARM64, MACOS_X64, LINUX_X64, WINDOWS_X64],
  bundling: {
    mode: 'definitionOnly',
    includesBinaries: false,
    lockRequired: true,
    notes: 'Built-in steps are qualified by the NeuroFlow app/runtime version in the bundle lock.'
  }
})

export const tools: ToolDefinition[] = [
  {
    id: 'niivue.desktop.tools/dcm2niix',
    name: 'dcm2niix',
    version: '1.0.0',
    description: 'Convert DICOM images to NIfTI and BIDS sidecars.',
    inputs: {
      dicom_dir: {
        type: 'neuro:dicom-folder',
        description: 'DICOM source directory.',
        consumesAs: [{ channel: 'filesystem', format: 'directory', acceptsPipe: false }]
      },
      series: { type: 'core:array<neuro:dicom-series>', description: 'Selected DICOM series.', optional: true },
      bids: {
        type: 'core:string',
        description: 'Generate BIDS sidecars.',
        optional: true,
        default: 'y',
        consumesAs: [{ channel: 'argument', argument: '-b', format: 'text' }]
      },
      compress: {
        type: 'core:string',
        description: 'Compression mode.',
        optional: true,
        default: 'y',
        consumesAs: [{ channel: 'argument', argument: '-z', format: 'text' }]
      },
      bids_anon: {
        type: 'core:string',
        description: 'Anonymize BIDS sidecars.',
        optional: true,
        default: 'n',
        consumesAs: [{ channel: 'argument', argument: '-ba', format: 'text' }]
      }
    },
    outputs: {
      volumes: {
        type: 'core:array<neuro:volume>',
        description: 'Converted NIfTI volumes.',
        availableFrom: [
          {
            source: 'filesystem',
            format: 'nifti',
            glob: '*.nii*',
            pipe: {
              safe: true,
              modes: ['argument', 'file'],
              description: 'Downstream tools receive resolved NIfTI file paths, not shell text.'
            }
          }
        ]
      },
      sidecars: {
        type: 'core:array<core:json>',
        description: 'BIDS sidecar JSON files.',
        availableFrom: [
          {
            source: 'filesystem',
            format: 'json',
            glob: '*.json',
            pipe: {
              safe: true,
              modes: ['argument', 'file'],
              description: 'Downstream tools receive resolved JSON sidecar paths.'
            }
          }
        ]
      },
      outDir: {
        type: 'core:directory',
        description: 'Conversion output directory.',
        availableFrom: [
          {
            source: 'filesystem',
            format: 'directory',
            pipe: {
              safe: true,
              modes: ['argument'],
              description: 'Directory paths are passed as argv values without shell expansion.'
            }
          }
        ]
      },
      diagnostics: {
        type: 'core:string',
        description: 'Console diagnostics captured from dcm2niix.',
        optional: true,
        availableFrom: [
          {
            source: 'stdout',
            format: 'text',
            encoding: 'utf-8',
            pipe: {
              safe: true,
              modes: ['stdin'],
              description: 'Text diagnostics can be piped only to stdin-aware consumers.'
            }
          },
          { source: 'stderr', format: 'text', encoding: 'utf-8' }
        ]
      }
    },
    extensions: {
      [REGISTRY_EXTENSION]: {
        ...NIIVUE_CONSOLE_PROVIDER[REGISTRY_EXTENSION],
        executor: {
          kind: 'console',
          commandId: 'neuroflow.dcm2niix.help',
          label: 'dcm2niix command adapter'
        }
      },
      ...DCM2NIIX_PACKAGING
    },
    block: [
      {
        id: 'filter-import-dicoms',
        label: 'Filter and Import DICOMs',
        description: 'Browse series, filter, and convert the selected acquisitions.',
        category: 'Import',
        icon: 'Upload',
        defaults: { bids: 'y', compress: 'y', bids_anon: 'n' },
        exposedFields: ['dicom_dir', 'dicom_series', 'selected_series']
      }
    ]
  },
  {
    id: 'niivue.desktop.tools/bids-classify',
    name: 'bids-classify',
    version: '1.0.0',
    description: 'Classify DICOM sidecars into BIDS datatypes and suffixes.',
    inputs: {
      sidecars: {
        type: 'core:array<core:json>',
        description: 'Sidecars from conversion.',
        consumesAs: [
          {
            channel: 'filesystem',
            format: 'json',
            acceptsPipe: true,
            description: 'Open sidecar JSON files as editable rows in the classifier UI.'
          }
        ]
      },
      overrides: { type: 'core:array<neuro:series-mapping>', description: 'User edited mappings.', optional: true }
    },
    outputs: {
      mappings: {
        type: 'core:array<neuro:series-mapping>',
        description: 'BIDS series mapping table.',
        availableFrom: [
          {
            source: 'uiSession',
            format: 'uiState',
            selector: 'seriesMappings',
            completion: {
              continueWhen: 'appClosed',
              requiredOutputs: ['mappings']
            }
          },
          {
            source: 'filesystem',
            format: 'json',
            watch: {
              path: 'session://bids-classify/mappings.json',
              required: true,
              debounceMs: 300
            },
            completion: {
              continueWhen: 'appClosed',
              requiredOutputs: ['mappings']
            },
            pipe: {
              safe: true,
              modes: ['file'],
              description: 'Downstream tools can receive the session mapping artifact as a file.'
            }
          }
        ]
      },
      subjects: {
        type: 'core:array<neuro:subject>',
        description: 'Detected subjects.',
        availableFrom: [
          {
            source: 'uiSession',
            format: 'uiState',
            selector: 'subjects',
            completion: {
              continueWhen: 'appClosed'
            }
          }
        ]
      }
    },
    extensions: {
      ...NIIVUE_UI_APP_PROVIDER,
      ...NIIVUE_TOOL_PACKAGING
    },
    block: {
      id: 'classify-bids',
      label: 'Classify BIDS',
      description: 'Infer BIDS datatype, suffix, subject, and session metadata.',
      category: 'Processing',
      icon: 'TableProperties',
      exposedFields: ['series_list', 'subjects']
    }
  },
  {
    id: 'niivue.desktop.tools/bids-write',
    name: 'bids-write',
    version: '1.0.0',
    description: 'Write a BIDS dataset to disk.',
    inputs: {
      volumes: { type: 'core:array<neuro:volume>', description: 'Converted volumes.' },
      mappings: { type: 'core:array<neuro:series-mapping>', description: 'BIDS mapping table.' },
      config: { type: 'core:object', description: 'Full workflow context.' },
      output_dir: { type: 'core:directory', description: 'Dataset output directory.' }
    },
    outputs: {
      bids_dir: { type: 'neuro:bids-dataset', description: 'Written BIDS dataset.' },
      files_copied: { type: 'core:number', description: 'Number of copied files.' }
    },
    extensions: {
      ...NEUROFLOW_PROVIDER,
      ...NEUROFLOW_INTERNAL_PACKAGING
    },
    block: {
      id: 'write-bids',
      label: 'Write BIDS',
      description: 'Create BIDS files, sidecars, and dataset metadata.',
      category: 'Output',
      icon: 'Download',
      defaults: { config: { ref: 'context' } },
      exposedFields: ['dataset_name', 'dataset_version', 'license', 'authors', 'readme', 'output_dir']
    }
  },
  {
    id: 'niivue.desktop.tools/bids-postpass',
    name: 'bids-postpass',
    version: '1.0.0',
    description: 'Finalize fieldmaps, scans.tsv, and BIDS derivatives after writing.',
    inputs: {
      bids_dir: { type: 'neuro:bids-dataset', description: 'Written BIDS dataset.' }
    },
    outputs: {
      bids_dir: { type: 'neuro:bids-dataset', description: 'Finalized BIDS dataset.' },
      failures: { type: 'core:array<core:json>', description: 'Postpass failures.' }
    },
    extensions: {
      ...NEUROFLOW_PROVIDER,
      ...NEUROFLOW_INTERNAL_PACKAGING
    },
    block: {
      id: 'finalize-bids',
      label: 'Finalize BIDS',
      description: 'Apply BIDS post-processing and consistency repairs.',
      category: 'Quality',
      icon: 'BadgeCheck',
      exposedFields: ['bids_dir']
    }
  },
  {
    id: 'bidsvue.importers/heudiconv',
    name: 'heudiconv',
    version: '1.0.0',
    description: 'Convert DICOMs to BIDS with a built-in or custom heudiconv heuristic.',
    inputs: {
      dicom_dir: { type: 'neuro:dicom-folder', description: 'DICOM source directory.' },
      output_dir: { type: 'core:directory', description: 'Output directory for the BIDS dataset.' },
      heuristic: {
        type: 'core:string',
        description: 'Built-in heuristic name or absolute path to a custom Python heuristic.',
        default: 'reproin'
      },
      subject: { type: 'core:string', description: 'BIDS subject label.', optional: true },
      session: { type: 'core:string', description: 'BIDS session label.', optional: true }
    },
    outputs: {
      bids_dir: { type: 'neuro:bids-dataset', description: 'Converted BIDS dataset.' },
      log: { type: 'core:string', description: 'Importer log.' }
    },
    extensions: {
      [REGISTRY_EXTENSION]: {
        provider: {
          kind: 'console',
          label: 'BIDSvue external importer',
          source: '~/Dev/bidsui/resources/common/importers/heudiconv.json',
          runtime: 'external'
        },
        executor: {
          kind: 'console',
          commandId: 'neuroflow.echo',
          label: 'BIDSvue importer adapter'
        }
      },
      ...BIDSVUE_IMPORTER_PACKAGING
    },
    block: {
      id: 'heudiconv-import',
      label: 'heudiconv Import',
      description: 'Run heudiconv with a reproin or custom heuristic.',
      category: 'Import',
      icon: 'Upload',
      defaults: { heuristic: 'reproin' },
      exposedFields: ['dicom_dir', 'output_dir', 'heuristic', 'subject', 'session'],
      formComponent: 'bidsvue-importer-form'
    }
  },
  {
    id: 'bidsvue.importers/dcm2bids',
    name: 'dcm2bids',
    version: '3.2.0',
    description: 'Convert DICOMs to BIDS using a per-protocol dcm2bids JSON config.',
    inputs: {
      dicom_dir: { type: 'neuro:dicom-folder', description: 'DICOM source directory.' },
      output_dir: { type: 'core:directory', description: 'Output directory for the BIDS dataset.' },
      config: { type: 'core:file', description: 'dcm2bids JSON config file.' },
      subject: { type: 'core:string', description: 'Required BIDS subject label.' },
      session: { type: 'core:string', description: 'BIDS session label.', optional: true },
      cleanupUnmatched: {
        type: 'core:boolean',
        description: 'Delete the tmp_dcm2bids working directory after conversion.',
        optional: true,
        default: true
      }
    },
    outputs: {
      bids_dir: { type: 'neuro:bids-dataset', description: 'Converted BIDS dataset.' },
      unmatched: { type: 'core:array<core:file>', description: 'Unmatched source files.' }
    },
    extensions: {
      ...BIDSVUE_CONSOLE_PROVIDER,
      ...BIDSVUE_IMPORTER_PACKAGING
    },
    block: {
      id: 'dcm2bids-import',
      label: 'dcm2bids Import',
      description: 'Use a dcm2bids config to map DICOM series into BIDS.',
      category: 'Import',
      icon: 'Upload',
      defaults: { cleanupUnmatched: true },
      exposedFields: ['dicom_dir', 'output_dir', 'config', 'subject', 'session', 'cleanupUnmatched'],
      formComponent: 'bidsvue-importer-form'
    }
  },
  {
    id: 'openneuro.org/services/dataset-import',
    name: 'openneuro-dataset',
    version: '1.0.0',
    description: 'Resolve an OpenNeuro dataset into a local BIDS dataset workspace.',
    inputs: {
      dataset_id: { type: 'core:string', description: 'OpenNeuro dataset accession such as ds000001.' },
      output_dir: { type: 'core:directory', description: 'Local destination directory.' }
    },
    outputs: {
      bids_dir: { type: 'neuro:bids-dataset', description: 'Resolved BIDS dataset directory.' }
    },
    extensions: {
      [REGISTRY_EXTENSION]: {
        provider: {
          kind: 'webService',
          label: 'OpenNeuro service',
          source: 'openneuro.org dataset service',
          runtime: 'service'
        },
        executor: {
          kind: 'webService',
          serviceId: 'openneuro-dataset',
          label: 'OpenNeuro service adapter',
          dryRun: true
        }
      },
      ...OPENNEURO_SERVICE_PACKAGING
    },
    block: {
      id: 'openneuro-import',
      label: 'OpenNeuro Dataset',
      description: 'Fetch or attach an OpenNeuro-hosted BIDS dataset.',
      category: 'Import',
      icon: 'Download',
      exposedFields: ['dataset_id', 'output_dir'],
      formComponent: 'dataset-service-form'
    }
  },
  {
    id: 'niivue.desktop.tools/brainchop',
    name: 'brainchop',
    version: '1.0.0',
    description: 'Skull strip anatomical NIfTI volumes with Brainchop MindGrab inference.',
    inputs: {
      nifti_paths: { type: 'core:array<neuro:volume>', description: 'Anatomical volumes to skull strip.' },
      model: {
        type: 'core:string',
        description: 'Brain extraction model.',
        optional: true,
        default: 'brain-extract-mindgrab'
      },
      dilation: {
        type: 'core:number',
        description: 'Brain-mask dilation in millimeters.',
        optional: true,
        default: 3,
        min: 0,
        max: 10
      }
    },
    outputs: {
      output_paths: { type: 'core:array<neuro:volume>', description: 'Skull-stripped NIfTI volumes.' }
    },
    extensions: {
      ...WEB_FORM_PROVIDER,
      ...NIIVUE_TOOL_PACKAGING
    },
    block: {
      id: 'skull-strip',
      label: 'Skull Strip',
      description: 'Remove non-brain tissue with the MindGrab model.',
      category: 'Processing',
      icon: 'FileText',
      defaults: { model: 'brain-extract-mindgrab', dilation: 3 },
      exposedFields: ['nifti_paths', 'dilation'],
      formComponent: 'skull-strip-editor'
    }
  },
  {
    id: 'neuroflow.viewers/neurovue',
    name: 'neurovue',
    version: '0.1.0',
    description: 'Review NIfTI, OME-Zarr, tract, and mesh artifacts with lightweight correction patches.',
    inputs: {
      volume: {
        type: 'core:array<neuro:volume>',
        description: 'Preview volumes.',
        optional: true,
        consumesAs: [
          {
            channel: 'filesystem',
            format: 'nifti',
            acceptsPipe: true,
            description: 'Open resolved NIfTI paths in the preview viewer.'
          }
        ]
      },
      omezarr: {
        type: 'neuro:ome-zarr',
        description: 'Preview OME-Zarr pyramid.',
        optional: true,
        consumesAs: [
          {
            channel: 'filesystem',
            format: 'omezarr',
            acceptsPipe: true,
            description: 'Open resolved OME-Zarr stores through the volumetric server.'
          }
        ]
      },
      tract: {
        type: 'core:array<neuro:tract>',
        description: 'Preview tractography files.',
        optional: true,
        consumesAs: [
          {
            channel: 'filesystem',
            format: 'tract',
            acceptsPipe: true,
            description: 'Open resolved tract paths in the preview viewer.'
          }
        ]
      },
      mesh: {
        type: 'core:array<neuro:mesh>',
        description: 'Preview surface or mesh files.',
        optional: true,
        consumesAs: [
          {
            channel: 'filesystem',
            format: 'mesh',
            acceptsPipe: true,
            description: 'Open resolved mesh paths in the preview viewer.'
          }
        ]
      }
    },
    outputs: {
      correction_patch: {
        type: 'neuro:correction-patch',
        description: 'Small JSON artifact describing preview-time corrections.',
        optional: true,
        availableFrom: [
          {
            source: 'uiSession',
            format: 'uiState',
            selector: 'correctionPatch',
            completion: {
              continueWhen: 'appClosed'
            }
          },
          {
            source: 'filesystem',
            format: 'json',
            watch: {
              path: 'session://neurovue/correction.patch.json',
              debounceMs: 250
            },
            pipe: {
              safe: true,
              modes: ['file'],
              description: 'Downstream steps receive the correction patch as a resolved JSON file.'
            }
          }
        ]
      },
      review_state: {
        type: 'core:json',
        description: 'Viewer state at close.',
        optional: true,
        availableFrom: [
          {
            source: 'uiSession',
            format: 'uiState',
            selector: 'viewerState',
            completion: {
              continueWhen: 'appClosed'
            }
          }
        ]
      }
    },
    extensions: {
      ...NEUROVUE_UI_APP_PROVIDER,
      ...NEUROVUE_PACKAGING
    },
    block: {
      id: 'review-in-neurovue',
      label: 'Review in NeuroVue',
      description: 'Open previous artifacts for preview, clip planes, and small correction patches.',
      category: 'Quality',
      icon: 'FileText',
      exposedFields: ['volume', 'omezarr', 'tract', 'mesh']
    }
  },
  {
    id: 'niivue.desktop.tools/niimath',
    name: 'niimath',
    version: '1.0.0',
    description: 'General-purpose NIfTI calculator for smoothing, thresholding, masking, and math ops.',
    inputs: {
      nifti_paths: {
        type: 'core:array<neuro:volume>',
        description: 'Input NIfTI volumes.',
        consumesAs: [
          {
            channel: 'argument',
            format: 'nifti',
            acceptsPipe: true,
            description: 'Accept resolved NIfTI paths from an upstream safe file pipe.'
          }
        ]
      },
      operation: {
        type: 'core:string',
        description: 'NiiMath operation.',
        default: '-s',
        enum: ['-s', '-thr', '-uthr', '-bin', '-mul', '-add', '-sub', '-div', '-mas']
      },
      operand: {
        type: 'core:string',
        description: 'Operand for the selected operation.',
        optional: true,
        default: '2'
      },
      output_dir: {
        type: 'core:directory',
        description: 'Output directory.',
        optional: true,
        consumesAs: [{ channel: 'argument', format: 'directory', acceptsPipe: true }]
      }
    },
    outputs: {
      output_paths: {
        type: 'core:array<neuro:volume>',
        description: 'Processed NIfTI volumes.',
        availableFrom: [
          {
            source: 'filesystem',
            format: 'nifti',
            glob: '*.nii*',
            pipe: {
              safe: true,
              modes: ['argument', 'file'],
              description: 'Downstream tools receive resolved NIfTI file paths.'
            }
          }
        ]
      },
      output_dir: {
        type: 'core:directory',
        description: 'Directory containing outputs.',
        availableFrom: [
          {
            source: 'filesystem',
            format: 'directory',
            pipe: {
              safe: true,
              modes: ['argument'],
              description: 'Directory paths are passed as argv values without shell expansion.'
            }
          }
        ]
      }
    },
    extensions: {
      ...NIIVUE_CONSOLE_PROVIDER,
      ...NIIVUE_TOOL_PACKAGING
    },
    block: {
      id: 'niimath',
      label: 'NiiMath',
      description: 'Apply common NIfTI image operations.',
      category: 'Processing',
      icon: 'FileText',
      defaults: { operation: '-s', operand: '2' },
      exposedFields: ['nifti_paths', 'operation', 'operand', 'output_dir']
    }
  }
]

export const dicomToBidsWorkflow: WorkflowDocument = {
  neuroflow: '0.1.0',
  kind: 'workflow',
  id: 'niivue.desktop/dicom-to-bids',
  version: '2.0.0',
  description: 'Convert DICOM to a BIDS-compliant dataset.',
  inputs: {
    dicom_dir: { type: 'neuro:dicom-folder', description: 'DICOM source directory.' }
  },
  context: {
    description: 'BIDS dataset configuration accumulated during the workflow run.',
    fields: {
      dicom_series: {
        type: 'core:array<neuro:dicom-series>',
        description: 'All DICOM series discovered in the source directory.',
        heuristic: 'list-dicom-series',
        dependsOn: ['dicom_dir']
      },
      selected_series: {
        type: 'core:array<neuro:dicom-series>',
        description: 'Subset of DICOM series chosen for conversion.',
        default: []
      },
      series_list: {
        type: 'core:array<neuro:series-mapping>',
        description: 'Classified BIDS datatype, suffix, and metadata.',
        heuristic: 'bids-classify'
      },
      subjects: {
        type: 'core:array<neuro:subject>',
        description: 'Detected subjects and sessions.',
        heuristic: 'detect-subjects'
      },
      dataset_name: { type: 'core:string', description: 'BIDS dataset name.', default: 'My Dataset' },
      dataset_version: { type: 'core:string', description: 'BIDS version.', default: '1.9.0' },
      license: { type: 'core:string', description: 'Dataset license.', default: 'CC0', enum: ['CC0', 'CC-BY-4.0', 'PDDL', 'custom'] },
      authors: { type: 'core:string', description: 'Dataset authors.', default: '' },
      readme: { type: 'core:string', description: 'Dataset README content.', default: '' },
      output_dir: { type: 'core:directory', description: 'Output directory for the BIDS dataset.' },
      bids_dir: { type: 'neuro:bids-dataset', description: 'Written BIDS dataset directory.' }
    }
  },
  steps: {
    convert: {
      tool: 'niivue.desktop.tools/dcm2niix',
      inputs: {
        dicom_dir: { ref: 'inputs.dicom_dir' },
        series: { ref: 'context.selected_series' },
        bids: { constant: 'y' },
        compress: { constant: 'y' },
        bids_anon: { constant: 'n' }
      }
    },
    classify: {
      tool: 'niivue.desktop.tools/bids-classify',
      inputs: {
        sidecars: { ref: 'steps.convert.outputs.sidecars' },
        overrides: { ref: 'context.series_list' }
      },
      outputMappings: {
        mappings: 'series_list',
        subjects: 'subjects'
      }
    },
    write: {
      tool: 'niivue.desktop.tools/bids-write',
      inputs: {
        volumes: { ref: 'steps.convert.outputs.volumes' },
        mappings: { ref: 'context.series_list' },
        config: { ref: 'context' },
        output_dir: { ref: 'context.output_dir' }
      },
      outputMappings: {
        bids_dir: 'bids_dir'
      }
    },
    postpass: {
      tool: 'niivue.desktop.tools/bids-postpass',
      inputs: {
        bids_dir: { ref: 'steps.write.outputs.bids_dir' }
      }
    }
  },
  outputs: {
    bids_dir: { type: 'neuro:bids-dataset', ref: 'steps.postpass.outputs.bids_dir' }
  },
  extensions: {
    'niivue/ui': {
      menu: 'Import'
    }
  }
}

export const library: WorkflowLibraryItem[] = [
  {
    id: 'dicom-to-bids',
    label: 'DICOM to BIDS',
    description: 'Import, classify, write, and finalize a BIDS dataset.',
    workflow: dicomToBidsWorkflow
  },
  {
    id: 'dicom-to-nifti',
    label: 'DICOM to NIfTI',
    description: 'Small conversion pipeline using the same NeuroFlow contract.',
    workflow: {
      ...dicomToBidsWorkflow,
      id: 'niivue.desktop/dicom-to-nifti',
      version: '1.0.0',
      description: 'Convert DICOM to NIfTI volumes.',
      steps: {
        convert: dicomToBidsWorkflow.steps.convert
      },
      outputs: {
        volumes: { type: 'core:array<neuro:volume>', ref: 'steps.convert.outputs.volumes' },
        outDir: { type: 'core:directory', ref: 'steps.convert.outputs.outDir' }
      }
    }
  }
]
