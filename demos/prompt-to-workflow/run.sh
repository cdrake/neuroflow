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
out="$here/out"
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

echo "prompt-to-workflow: starting agent ($stamp)"
# CLAUDECODE is unset so the demo also runs from inside a Claude Code session.
env -u CLAUDECODE claude -p "$(cat "$here/prompt.md")" \
  --mcp-config "$here/mcp.json" --strict-mcp-config \
  --allowedTools "mcp__neuroflow__*" \
  --max-turns 40 \
  --output-format stream-json --verbose \
  --append-system-prompt "$(cat "$here/system.md")" \
  "$@" > "$out/transcript.jsonl"

# The final assistant message and the run record.
jq -r 'select(.type == "result") | .result' "$out/transcript.jsonl" > "$out/answer.md"
jq -c 'select(.type == "assistant") | .message.content[] | select(.type == "tool_use") | {tool: .name, input: .input}' \
  "$out/transcript.jsonl" > "$out/tool-calls.jsonl"
jq -r 'select(.type == "result") | "turns: \(.num_turns)  duration: \(.duration_ms / 1000 | floor) s  cost: $\(.total_cost_usd | . * 100 | round / 100)"' "$out/transcript.jsonl"

# Copy the workflow the agent ran (the newest run whose workflow is not a registry id).
run_id="$(jq -r 'select(.type == "user") | .message.content[]? | select(.type == "tool_result") | .content | if type == "array" then .[0].text else . end' "$out/transcript.jsonl" 2>/dev/null \
  | grep -o 'run-[0-9TZ]*-[0-9a-f]*' | tail -1 || true)"
if [ -n "$run_id" ] && [ -d "$HOME/.neuroflow/runs/$run_id" ]; then
  cp "$HOME/.neuroflow/runs/$run_id/workflow.json" "$out/agent-workflow.json"
  cp "$HOME/.neuroflow/runs/$run_id/run.provenance.json" "$out/run.provenance.json"
  cp "$HOME/.neuroflow/runs/$run_id/provenance.jsonl" "$out/provenance.jsonl"
  echo "run: $run_id (copied workflow.json, provenance to $out)"
fi
echo "answer: $out/answer.md"
