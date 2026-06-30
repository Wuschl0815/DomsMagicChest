#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

patterns=(
  'sk-[A-Za-z0-9_-]{20,}'
  'ghp_[A-Za-z0-9_]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY'
  'AKIA[0-9A-Z]{16}'
  'xox[baprs]-[A-Za-z0-9-]+'
  'AIza[0-9A-Za-z_-]{35}'
  '/home/dominik'
  '/mnt/2omarchy'
  '@gmx\.'
  '@gmail\.'
)

fail=0
for pattern in "${patterns[@]}"; do
  if rg --hidden --glob '!node_modules/**' --glob '!.git/**' --glob '!scripts/scan-secrets.sh' -n "$pattern" . >/tmp/doms-magic-chest-scan.$$ 2>/dev/null; then
    echo "Potential sensitive pattern: $pattern"
    cat /tmp/doms-magic-chest-scan.$$
    fail=1
  fi
done
rm -f /tmp/doms-magic-chest-scan.$$

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-git --source .
else
  echo "gitleaks not installed; skipped optional scan"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "Secret scan failed"
  exit 1
fi

echo "Secret scan passed"
