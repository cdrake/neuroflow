import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Braces, GitCommitHorizontal, ListChecks, Trash2 } from 'lucide-react'
import type { Binding, ToolDefinition, ValidationReport, WorkflowDocument } from '../domain/neuroflow'
import { isConstantBinding, isRefBinding, shortType, stableToolName } from '../domain/neuroflow'

interface InspectorProps {
  workflow: WorkflowDocument
  tools: ToolDefinition[]
  toolMap: Map<string, ToolDefinition>
  selectedStep: string | null
  report: ValidationReport
  onRenameStep: (stepId: string, nextId: string) => void
  onChangeTool: (stepId: string, toolId: string) => void
  onChangeInput: (stepId: string, inputName: string, binding: Binding | null) => void
  onChangeOutputMapping: (stepId: string, outputName: string, contextField: string) => void
  onChangeCondition: (stepId: string, condition: string) => void
  onDeleteStep: (stepId: string) => void
}

interface RefOption {
  value: string
  label: string
}

export function Inspector({
  workflow,
  tools,
  toolMap,
  selectedStep,
  report,
  onRenameStep,
  onChangeTool,
  onChangeInput,
  onChangeOutputMapping,
  onChangeCondition,
  onDeleteStep
}: InspectorProps): JSX.Element {
  const step = selectedStep ? workflow.steps[selectedStep] : undefined
  const tool = step ? toolMap.get(step.tool) ?? toolMap.get(stableToolName(step.tool)) : undefined
  const [draftStepId, setDraftStepId] = useState(selectedStep ?? '')
  const refOptions = useMemo(
    () => buildRefOptions(workflow, toolMap, selectedStep),
    [workflow, toolMap, selectedStep]
  )
  const contextFields = Object.keys(workflow.context?.fields ?? {})

  useEffect(() => {
    setDraftStepId(selectedStep ?? '')
  }, [selectedStep])

  const inputNames = Array.from(
    new Set([...Object.keys(tool?.inputs ?? {}), ...Object.keys(step?.inputs ?? {})])
  )
  const outputNames = Array.from(
    new Set([...Object.keys(tool?.outputs ?? {}), ...Object.keys(step?.outputMappings ?? {})])
  )
  const canRename = !!selectedStep && draftStepId.trim() !== selectedStep

  return (
    <section className="nf-panel nf-inspector">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Inspector</p>
          <h2>{selectedStep ?? 'Workflow'}</h2>
        </div>
        <GitCommitHorizontal size={16} />
      </header>

      {step ? (
        <div className="nf-inspector-body">
          <section className="nf-compact-section nf-step-editor">
            <div className="nf-edit-grid">
              <label className="nf-field">
                <span>Step id</span>
                <input
                  value={draftStepId}
                  onChange={(event) => setDraftStepId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && selectedStep) {
                      onRenameStep(selectedStep, draftStepId)
                    }
                  }}
                />
              </label>
              <button
                className="nf-action nf-action-compact"
                disabled={!canRename}
                onClick={() => selectedStep && onRenameStep(selectedStep, draftStepId)}
                type="button"
              >
                Rename
              </button>
            </div>

            <label className="nf-field">
              <span>Tool</span>
              <select value={step.tool} onChange={(event) => onChangeTool(selectedStep!, event.target.value)}>
                {!tools.some((candidate) => candidate.id === step.tool) && (
                  <option value={step.tool}>{step.tool}</option>
                )}
                {tools.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="nf-kv">
              <span>Version</span>
              <strong>{tool?.version ?? 'unknown'}</strong>
            </div>

            <label className="nf-field">
              <span>Condition</span>
              <input
                placeholder="optional expression"
                value={step.condition ?? ''}
                onChange={(event) => onChangeCondition(selectedStep!, event.target.value)}
              />
            </label>
          </section>

          <section className="nf-compact-section">
            <h3>
              <Braces size={14} />
              Inputs
            </h3>
            <datalist id="nf-ref-options">
              {refOptions.map((option) => (
                <option key={option.value} label={option.label} value={option.value} />
              ))}
            </datalist>
            {inputNames.length === 0 && <p className="nf-muted">No inputs.</p>}
            {inputNames.map((name) => (
              <InputEditor
                key={name}
                name={name}
                type={tool?.inputs[name]?.type ?? 'core:any'}
                binding={step.inputs[name]}
                refOptions={refOptions}
                onChange={(binding) => onChangeInput(selectedStep!, name, binding)}
              />
            ))}
          </section>

          <section className="nf-compact-section">
            <h3>
              <ListChecks size={14} />
              Outputs
            </h3>
            <datalist id="nf-context-field-options">
              {contextFields.map((field) => (
                <option key={field} value={field} />
              ))}
            </datalist>
            {outputNames.length === 0 && <p className="nf-muted">No outputs.</p>}
            {outputNames.map((name) => (
              <div className="nf-binding-row nf-binding-editor" key={name}>
                <span>
                  <strong>{name}</strong>
                  <small>{shortType(tool?.outputs[name]?.type ?? 'core:any')}</small>
                </span>
                <input
                  list="nf-context-field-options"
                  placeholder="context field"
                  value={step.outputMappings?.[name] ?? ''}
                  onChange={(event) => onChangeOutputMapping(selectedStep!, name, event.target.value)}
                />
              </div>
            ))}
          </section>

          <section className="nf-danger-zone">
            <button className="nf-action nf-action-danger" onClick={() => onDeleteStep(selectedStep!)} type="button">
              <Trash2 size={14} />
              Delete Step
            </button>
          </section>
        </div>
      ) : (
        <div className="nf-empty-panel">Select a workflow step.</div>
      )}

      <section className="nf-compact-section">
        <h3>
          <AlertTriangle size={14} />
          Validation
        </h3>
        {report.issues.length === 0 ? (
          <p className="nf-muted">No issues.</p>
        ) : (
          <div className="nf-issues">
            {report.issues.map((issue, index) => (
              <div className={`nf-issue is-${issue.severity}`} key={`${issue.path ?? 'issue'}:${index}`}>
                <strong>{issue.severity}</strong>
                <span>{issue.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}

function InputEditor({
  name,
  type,
  binding,
  refOptions,
  onChange
}: {
  name: string
  type: string
  binding: Binding | undefined
  refOptions: RefOption[]
  onChange: (binding: Binding | null) => void
}): JSX.Element {
  const kind = isRefBinding(binding) ? 'ref' : isConstantBinding(binding) ? 'constant' : 'unbound'

  return (
    <div className="nf-binding-row nf-binding-editor">
      <span>
        <strong>{name}</strong>
        <small>{shortType(type)}</small>
      </span>
      <div className="nf-binding-control">
        <select
          aria-label={`${name} binding kind`}
          value={kind}
          onChange={(event) => {
            if (event.target.value === 'unbound') {
              onChange(null)
            } else if (event.target.value === 'ref') {
              onChange({ ref: isRefBinding(binding) ? binding.ref : refOptions[0]?.value ?? 'context' })
            } else {
              onChange({ constant: isConstantBinding(binding) ? binding.constant : '' })
            }
          }}
        >
          <option value="ref">Ref</option>
          <option value="constant">Constant</option>
          <option value="unbound">Unbound</option>
        </select>

        {kind === 'ref' && (
          <input
            list="nf-ref-options"
            value={isRefBinding(binding) ? binding.ref : ''}
            onChange={(event) => onChange({ ref: event.target.value })}
          />
        )}

        {kind === 'constant' && (
          <input
            value={constantToInput(binding)}
            onChange={(event) => onChange({ constant: parseConstant(event.target.value) })}
          />
        )}

        {kind === 'unbound' && <span className="nf-unbound">Not bound</span>}
      </div>
    </div>
  )
}

function buildRefOptions(
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>,
  selectedStep: string | null
): RefOption[] {
  const options: RefOption[] = [
    { value: 'context', label: 'Context object' },
    ...Object.entries(workflow.inputs).map(([name, def]) => ({
      value: `inputs.${name}`,
      label: `Input: ${shortType(def.type)}`
    })),
    ...Object.entries(workflow.context?.fields ?? {}).map(([name, def]) => ({
      value: `context.${name}`,
      label: `Context: ${shortType(def.type)}`
    }))
  ]

  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (stepId === selectedStep) continue
    const tool = toolMap.get(step.tool) ?? toolMap.get(stableToolName(step.tool))
    for (const [outputName, output] of Object.entries(tool?.outputs ?? {})) {
      options.push({
        value: `steps.${stepId}.outputs.${outputName}`,
        label: `${stepId}: ${shortType(output.type)}`
      })
    }
  }

  return options
}

function constantToInput(binding: Binding | undefined): string {
  if (!isConstantBinding(binding)) return ''
  if (typeof binding.constant === 'string') return binding.constant
  return JSON.stringify(binding.constant)
}

function parseConstant(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}
