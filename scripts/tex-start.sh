#!/usr/bin/env bash
# tex: start Siftly with the local-LLM key loaded from a file (never stored in Siftly's DB,
# never on a command line, never printed). Used by siftly.service.
set -euo pipefail

KEY_FILE="${SIFTLY_KEY_FILE:-$HOME/.config/strata-api-key}"
if [[ ! -r "$KEY_FILE" ]]; then
  echo "tex-start: cannot read key file $KEY_FILE" >&2
  exit 1
fi
mode="$(stat -c %a "$KEY_FILE")"
if [[ "$mode" != "600" && "$mode" != "400" ]]; then
  echo "tex-start: refusing to use $KEY_FILE with mode $mode (want 600)" >&2
  exit 1
fi
key="$(<"$KEY_FILE")"
export OPENAI_API_KEY="${key//[$'\r\n\t ']/}"
unset key

cd "$(dirname "$(readlink -f "$0")")/.."
exec ./node_modules/.bin/next start -H "${SIFTLY_HOST:-0.0.0.0}" -p "${SIFTLY_PORT:-8097}"
