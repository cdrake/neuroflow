import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'

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
    block: {
      id: 'finalize-bids',
      label: 'Finalize BIDS',
      description: 'Apply BIDS post-processing and consistency repairs.',
      category: 'Quality',
      icon: 'BadgeCheck',
      exposedFields: ['bids_dir']
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
