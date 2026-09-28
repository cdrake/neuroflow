#!/usr/bin/env bash
# Prompt-to-workflow demo: a headless Claude Code agent reads prompt.md, and with
# nothing but the neuroflow MCP server composes, validates and runs a workflow
# from the registered lightNIIng tools. Results land in out/.
#
# Usage: demos/prompt-to-workflow/run.sh [extra claude flags]
# Needs: claude (Claude Code CLI), jq, target/release/neuroflow-mcp (cargo build --release),
# dcm2niix, niimath >= v1.0.20260924, the brainchop CLI, and native synthseg or the
# Neurodesk Webapps suite (see docs/neurodesk-webapps.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/out"
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
data_root="${NEUROFLOW_DEMO_DATA_ROOT:-$HOME/Data}"
dicom_dir="${NEUROFLOW_DEMO_DICOM_DIR:-$data_root/DICOMs/5_anat-T1w}"
template="${NEUROFLOW_DEMO_TEMPLATE:-$data_root/templates/MNI152_T1_1mm_brain.nii.gz}"
spec_dir="${NEUROFLOW_DEMO_SPEC_DIR:-$repo/../neuroflow-spec}"
python="${NEUROFLOW_DEMO_PYTHON:-$(command -v python3)}"
node="${NEUROFLOW_DEMO_NODE:-$(command -v node)}"
mcp_config="$(mktemp "${TMPDIR:-/tmp}/neuroflow-mcp.XXXXXX.json")"
transcript="$(mktemp "${TMPDIR:-/tmp}/neuroflow-transcript.XXXXXX.jsonl")"
trap 'rm -f "$mcp_config" "$transcript"' EXIT

jq --arg command "$repo/target/release/neuroflow-mcp" \
  --arg registry "$repo/gallery" --arg data_root "$data_root" --arg spec "$spec_dir" \
  --arg python "$python" --arg node "$node" \
  '.mcpServers.neuroflow.command = $command | .mcpServers.neuroflow.args =
    ["--registry", $registry, "--data-root", $data_root] +
    (if $spec == "" then [] else ["--spec", $spec] end) +
    ["--interpreter", "python3=" + $python, "--interpreter", "node=" + $node]' \
  "$here/mcp.json" > "$mcp_config"

prompt="$(<"$here/prompt.md")"
prompt="${prompt//\{\{dicom_dir\}\}/$dicom_dir}"
prompt="${prompt//\{\{template\}\}/$template}"

# Keep committed/demo records portable: the raw transcript and session files
# retain their local paths only in temporary/session storage.
redact_paths='walk(if type == "string" and startswith("/") then "<local-path>" else . end)'

echo "prompt-to-workflow: starting agent ($stamp)"
# CLAUDECODE is unset so the demo also runs from inside a Claude Code session.
env -u CLAUDECODE claude -p "$prompt" \
  --mcp-config "$mcp_config" --strict-mcp-config \
  --allowedTools "mcp__neuroflow__*" \
  --max-turns 40 \
  --output-format stream-json --verbose \
  --append-system-prompt "$(cat "$here/system.md")" \
  "$@" > "$transcript"

# The final assistant message and the run record.
jq -r 'select(.type == "result") | .result' "$transcript" > "$out/answer.md"
jq -c "select(.type == \"assistant\") | .message.content[] | select(.type == \"tool_use\") | {tool: .name, input: (.input | $redact_paths)}" \
  "$transcript" > "$out/tool-calls.jsonl"
jq -r 'select(.type == "result") | "turns: \(.num_turns)  duration: \(.duration_ms / 1000 | floor) s  cost: $\(.total_cost_usd | . * 100 | round / 100)"' "$transcript"

# Copy the workflow the agent ran (the newest run whose workflow is not a registry id).
run_id="$(jq -r 'select(.type == "user") | .message.content[]? | select(.type == "tool_result") | .content | if type == "array" then .[0].text else . end' "$transcript" 2>/dev/null \
  | grep -o 'run-[0-9TZ]*-[0-9a-f]*' | tail -1 || true)"
if [ -n "$run_id" ] && [ -d "$HOME/.neuroflow/runs/$run_id" ]; then
  cp "$HOME/.neuroflow/runs/$run_id/workflow.json" "$out/agent-workflow.json"
  jq "$redact_paths" "$HOME/.neuroflow/runs/$run_id/run.provenance.json" > "$out/run.provenance.json"
  jq -c "$redact_paths" "$HOME/.neuroflow/runs/$run_id/provenance.jsonl" > "$out/provenance.jsonl"
  echo "run: $run_id (copied workflow.json, provenance to $out)"
fi
echo "answer: $out/answer.md"
