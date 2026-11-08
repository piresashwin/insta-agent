#!/usr/bin/env bash
# Start a live HTTPS tunnel for Instagram publish only.
# Prefers POST /api/admin/publish-tunnel (stores URL in SQLite — no API restart).
# Falls back to writing PUBLIC_API_BASE in .env.local if the API route is unavailable.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/.env.local"
PORT="${PORT:-3001}"
API="http://127.0.0.1:${PORT}"

if ! curl -sf "${API}/api/brand-profiles" >/dev/null; then
  echo "API not reachable on :${PORT} — start the server first (pnpm --filter server dev)" >&2
  exit 1
fi

echo "Starting publish tunnel via API (stores URL in database)…"
RESP="$(curl -sS -X POST "${API}/api/admin/publish-tunnel" -H 'Content-Type: application/json' -d '{}' || true)"
BASE="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print((d.get("tunnel") or {}).get("base_url") or "")' "$RESP" 2>/dev/null || true)"
ERR="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get("error") or "")' "$RESP" 2>/dev/null || true)"

if [[ -n "$BASE" ]]; then
  echo "Publish tunnel: $BASE (source=database — publish uses it immediately)"
  # Keep .env.local in sync for tools that still read PUBLIC_API_BASE
  if [[ -f "$ENV_FILE" ]] && grep -q '^PUBLIC_API_BASE=' "$ENV_FILE" 2>/dev/null; then
    python3 - "$ENV_FILE" "$BASE" <<'PY'
import re, sys
from pathlib import Path
path, base = Path(sys.argv[1]), sys.argv[2]
text = re.sub(r"^PUBLIC_API_BASE=.*$", f"PUBLIC_API_BASE={base}", path.read_text(), count=1, flags=re.M)
path.write_text(text)
PY
  else
    echo "PUBLIC_API_BASE=$BASE" >>"$ENV_FILE"
  fi
  exit 0
fi

echo "API tunnel start failed${ERR:+: $ERR}" >&2
echo "Is cloudflared installed? Try: brew install cloudflared" >&2
exit 1
