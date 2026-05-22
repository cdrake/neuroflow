import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'

const REGISTRY_EXTENSION = 'neuroflow/registry'

const NIIVUE_CONSOLE_PROVIDER = {
  [REGISTRY_EXTENSION]: {
    provider: {
      kind: 'console',
      label: 'NiiVue console app',
      source: '~/Dev/niivue/niivue/packages/niivue-desktop/workflows/tools',
      runtime: 'sidecar'
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
    }
  }
}

export const tools: ToolDefinition[] = [
  {
    id: 'niivue.desktop.tools/dcm2niix',
    name: 'dcm2niix',
    version: '1.0.0',
    description: 'Convert DICOM images to NIfTI and BIDS sidecars.',
    inputs: {
      dicom_dir: { type: 'neuro:dicom-folder', description: 'DICOM source directory.' },
      series: { type: 'core:array<neuro:dicom-series>', description: 'Selected DICOM series.', optional: true },
      bids: { type: 'core:string', description: 'Generate BIDS sidecars.', optional: true, default: 'y' },
      compress: { type: 'core:string', description: 'Compression mode.', optional: true, default: 'y' },
      bids_anon: { type: 'core:string', description: 'Anonymize BIDS sidecars.', optional: true, default: 'n' }
    },
    outputs: {
      volumes: { type: 'core:array<neuro:volume>', description: 'Converted NIfTI volumes.' },
      sidecars: { type: 'core:array<core:json>', description: 'BIDS sidecar JSON files.' },
      outDir: { type: 'core:directory', description: 'Conversion output directory.' }
    },
    extensions: NIIVUE_CONSOLE_PROVIDER,
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
      sidecars: { type: 'core:array<core:json>', description: 'Sidecars from conversion.' },
      overrides: { type: 'core:array<neuro:series-mapping>', description: 'User edited mappings.', optional: true }
    },
    outputs: {
      mappings: { type: 'core:array<neuro:series-mapping>', description: 'BIDS series mapping table.' },
      subjects: { type: 'core:array<neuro:subject>', description: 'Detected subjects.' }
    },
    extensions: WEB_FORM_PROVIDER,
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
    extensions: NEUROFLOW_PROVIDER,
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
    extensions: NEUROFLOW_PROVIDER,
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
        }
      }
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
    extensions: BIDSVUE_CONSOLE_PROVIDER,
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
        }
      }
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
    extensions: WEB_FORM_PROVIDER,
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
    id: 'niivue.desktop.tools/niimath',
    name: 'niimath',
    version: '1.0.0',
    description: 'General-purpose NIfTI calculator for smoothing, thresholding, masking, and math ops.',
    inputs: {
      nifti_paths: { type: 'core:array<neuro:volume>', description: 'Input NIfTI volumes.' },
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
      output_dir: { type: 'core:directory', description: 'Output directory.', optional: true }
    },
    outputs: {
      output_paths: { type: 'core:array<neuro:volume>', description: 'Processed NIfTI volumes.' },
      output_dir: { type: 'core:directory', description: 'Directory containing outputs.' }
    },
    extensions: NIIVUE_CONSOLE_PROVIDER,
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
