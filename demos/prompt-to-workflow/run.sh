#!/usr/bin/env bash
# Prompt-to-workflow demo: a headless coding agent reads prompt.md, and with
# nothing but the neuroflow MCP server composes, validates and runs a workflow
# from the registered lightNIIng tools. Results land in out/ (Claude Code, the
# default) or out-<agent>/ (NEUROFLOW_DEMO_AGENT=codex).
#
# Usage: demos/prompt-to-workflow/run.sh [extra agent flags]
# Needs: the agent CLI (claude or codex), jq, target/release/neuroflow-mcp
# (cargo build --release), dcm2niix, niimath >= v1.0.20260924, the brainchop CLI,
# and native synthseg or the Neurodesk Webapps suite (see docs/neurodesk-webapps.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
agent="${NEUROFLOW_DEMO_AGENT:-claude}"
case "$agent" in
  claude) out="$here/out" ;;
  codex) out="$here/out-codex" ;;
  *) echo "prompt-to-workflow: NEUROFLOW_DEMO_AGENT must be claude or codex, not $agent" >&2; exit 1 ;;
esac
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
data_root="${NEUROFLOW_DEMO_DATA_ROOT:-$HOME/Data}"
dicom_dir="${NEUROFLOW_DEMO_DICOM_DIR:-$data_root/DICOMs/5_anat-T1w}"
template="${NEUROFLOW_DEMO_TEMPLATE:-$data_root/templates/MNI152_T1_1mm_brain.nii.gz}"
spec_dir="${NEUROFLOW_DEMO_SPEC_DIR:-$repo/../neuroflow-spec}"
python="${NEUROFLOW_DEMO_PYTHON:-$(command -v python3)}"
node="${NEUROFLOW_DEMO_NODE:-$(command -v node)}"
server="$repo/target/release/neuroflow-mcp"

for cmd in "$agent" jq; do
  command -v "$cmd" >/dev/null || { echo "prompt-to-workflow: $cmd is not installed" >&2; exit 1; }
done
[ -x "$server" ] || { echo "prompt-to-workflow: $server is missing; run: cargo build --release -p neuroflow-mcp" >&2; exit 1; }
[ -n "$python" ] && [ -n "$node" ] || { echo "prompt-to-workflow: python3 and node are required (or NEUROFLOW_DEMO_PYTHON / NEUROFLOW_DEMO_NODE)" >&2; exit 1; }
[ -d "$dicom_dir" ] || { echo "prompt-to-workflow: DICOM folder $dicom_dir not found (set NEUROFLOW_DEMO_DICOM_DIR)" >&2; exit 1; }
[ -f "$template" ] || { echo "prompt-to-workflow: template $template not found (set NEUROFLOW_DEMO_TEMPLATE)" >&2; exit 1; }
# The spec checkout is optional: it only exposes the schemas as MCP resources.
[ -d "$spec_dir" ] || spec_dir=""

mcp_config="$(mktemp "${TMPDIR:-/tmp}/neuroflow-mcp.XXXXXX")"
transcript="$(mktemp "${TMPDIR:-/tmp}/neuroflow-transcript.XXXXXX")"
answer="$(mktemp "${TMPDIR:-/tmp}/neuroflow-answer.XXXXXX")"
done_ok=0
# The raw transcript holds local paths, so it is never written to out/; on a
# failed run (or with NEUROFLOW_DEMO_KEEP_TRANSCRIPT=1) it is left in place.
trap 'rm -f "$mcp_config" "$answer"; if [ "$done_ok" = 1 ] && [ -z "${NEUROFLOW_DEMO_KEEP_TRANSCRIPT:-}" ]; then rm -f "$transcript"; else echo "prompt-to-workflow: transcript kept at $transcript" >&2; fi' EXIT

# One server definition for every agent: the Claude Code MCP config, from which
# the Codex overrides are derived.
jq --arg command "$server" \
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
system="$(<"$here/system.md")"

# Keep committed/demo records portable: the raw transcript and session files
# retain their local paths only in temporary/session storage.
redact_paths='walk(if type == "string" and startswith("/") then "<local-path>" else . end)'

echo "prompt-to-workflow: starting $agent ($stamp)"
case "$agent" in
  claude)
    # CLAUDECODE is unset so the demo also runs from inside a Claude Code session.
    env -u CLAUDECODE claude -p "$prompt" \
      --mcp-config "$mcp_config" --strict-mcp-config \
      --allowedTools "mcp__neuroflow__*" \
      --max-turns 40 \
      --output-format stream-json --verbose \
      --append-system-prompt "$system" \
      "$@" > "$transcript"
    jq -r 'select(.type == "result") | .result' "$transcript" > "$answer"
    jq -c "select(.type == \"assistant\") | .message.content[] | select(.type == \"tool_use\") | {tool: .name, input: (.input | $redact_paths)}" \
      "$transcript" > "$out/tool-calls.jsonl"
    jq -r 'select(.type == "result") | "turns: \(.num_turns)  duration: \(.duration_ms / 1000 | floor) s  cost: $\(.total_cost_usd | . * 100 | round / 100)"' "$transcript"
    results="$(jq -r 'select(.type == "user") | .message.content[]? | select(.type == "tool_result") | .content | if type == "array" then .[0].text else . end' "$transcript" 2>/dev/null || true)"
    ;;
  codex)
    # Codex has no system-prompt flag; system.md leads the prompt. The MCP server
    # is passed as config overrides (TOML accepts the JSON array), and the shell
    # sandbox stays read-only: the agent only needs the MCP tools. stdin is closed
    # because codex exec otherwise waits to append whatever is piped to it.
    codex exec --ephemeral --skip-git-repo-check --sandbox read-only --json \
      --output-last-message "$answer" \
      -c "mcp_servers.neuroflow.command=\"$server\"" \
      -c "mcp_servers.neuroflow.args=$(jq -c '.mcpServers.neuroflow.args' "$mcp_config")" \
      "$@" "$system"$'\n\n'"$prompt" < /dev/null > "$transcript"
    jq -c "select(.type == \"item.completed\") | .item | select(.type == \"mcp_tool_call\") | {tool: \"mcp__\\(.server)__\\(.tool)\", input: (.arguments | $redact_paths), status: .status}" \
      "$transcript" > "$out/tool-calls.jsonl"
    jq -r 'select(.type == "turn.completed") | "tool calls: see tool-calls.jsonl  tokens: \(.usage.input_tokens) in (\(.usage.cached_input_tokens) cached), \(.usage.output_tokens) out"' "$transcript"
    results="$(jq -r 'select(.type == "item.completed") | .item | select(.type == "mcp_tool_call") | .result | tostring' "$transcript" 2>/dev/null || true)"
    ;;
esac

# The answer may quote paths; keep the home directory out of the committed copy.
sed "s#$HOME#~#g" "$answer" > "$out/answer.md"

# Copy the workflow the agent ran (the newest run the tool results mention).
run_id="$(printf '%s\n' "$results" | grep -o 'run-[0-9TZ]*-[0-9a-f]*' | tail -1 || true)"
if [ -n "$run_id" ] && [ -d "$HOME/.neuroflow/runs/$run_id" ]; then
  jq "$redact_paths" "$HOME/.neuroflow/runs/$run_id/workflow.json" > "$out/agent-workflow.json"
  jq "$redact_paths" "$HOME/.neuroflow/runs/$run_id/run.provenance.json" > "$out/run.provenance.json"
  jq -c "$redact_paths" "$HOME/.neuroflow/runs/$run_id/provenance.jsonl" > "$out/provenance.jsonl"
  echo "run: $run_id (copied workflow.json, provenance to $out)"
fi
echo "answer: $out/answer.md"
done_ok=1
