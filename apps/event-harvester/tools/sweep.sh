#!/bin/bash
# tools/sweep.sh — Harness sweep for knue-event-harvester
# Usage:
#   bash tools/sweep.sh        # full sweep
#   bash tools/sweep.sh --quick  # lint only
#
# Adapted from harness-init scripts/sweep.sh.

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$TOOLS_DIR/.." && pwd)"

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

FINDINGS=()
QUICK_MODE=false
[[ "${1:-}" == "--quick" ]] && QUICK_MODE=true

cd "$PROJ_DIR"

echo -e "${CYAN}=== Sweep ===${NC}"
echo -e "  Date: $(date '+%Y-%m-%d %H:%M')"

# ── 1. Lint scan ─────────────────────────────────────────────
echo -e "${CYAN}[1/4] Lint scan (tsc --noEmit)...${NC}"
if lint_output=$(npm run lint 2>&1); then
  echo -e "  ${GREEN}Lint clean${NC}"
else
  FINDINGS+=("[lint] tsc --noEmit failed — see output above")
  echo -e "  ${RED}Lint failed${NC}"
  echo "$lint_output" | tail -20
fi

$QUICK_MODE && { echo "Quick mode — done."; exit 0; }

# ── 2. Test coverage gate ────────────────────────────────────
echo -e "${CYAN}[2/4] Test coverage (80/80/75 thresholds)...${NC}"
if npm run test:coverage --silent 2>&1 | tail -5; then
  echo -e "  ${GREEN}Coverage thresholds met${NC}"
else
  FINDINGS+=("[coverage] One or more coverage thresholds (lines 80 / functions 80 / branches 75) failed")
fi

# ── 3. Worker boundary and secret checks ──────────────────────
echo -e "${CYAN}[3/4] Worker boundary and secrets...${NC}"
gp_issues=0

if grep -REn 'better-sqlite3|from "node:fs"|import\("dotenv"\)' src/; then
  FINDINGS+=("[worker-runtime] Server-only dependency found in Worker source")
  gp_issues=1
fi

# Secret leak check: console.log of sensitive env var values
secret_patterns=("GOOGLE_SERVICE_ACCOUNT_JSON" "TELEGRAM_BOT_TOKEN" "AI_GATEWAY_TOKEN" "STATE_IMPORT_TOKEN" "private_key")
while IFS= read -r sfile; do
  for spat in "${secret_patterns[@]}"; do
    while IFS= read -r sline; do
      if [[ "$sline" =~ console\.log ]] && [[ "$sline" =~ $spat ]]; then
        FINDINGS+=("[secret-leak] Possible secret logged in $sfile: $sline")
        gp_issues=1
      fi
    done < "$sfile"
  done
done < <(find src/ -name "*.ts" 2>/dev/null)

[[ $gp_issues -eq 0 ]] && echo -e "  ${GREEN}No golden principle violations${NC}"

# ── 4. Harness freshness ────────────────────────────────────
echo -e "${CYAN}[4/4] Harness freshness...${NC}"
harness_issues=0

# AGENTS.md line count
agents_lines=$(wc -l < AGENTS.md 2>/dev/null || echo 999)
if [[ $agents_lines -gt 200 ]]; then
  FINDINGS+=("[harness] AGENTS.md is ${agents_lines} lines — HARD WARN (>200). Move content to docs/.")
  harness_issues=1
elif [[ $agents_lines -gt 100 ]]; then
  echo -e "  ${YELLOW}AGENTS.md is ${agents_lines} lines (>100 target — still in soft band)${NC}"
else
  echo -e "  ${GREEN}AGENTS.md: ${agents_lines} lines (target ≤100)${NC}"
fi

# .agents/skills symlink
if [[ "$(readlink .agents/skills 2>/dev/null)" == "../.claude/skills" ]]; then
  echo -e "  ${GREEN}.agents/skills symlink OK${NC}"
else
  FINDINGS+=("[harness] .agents/skills symlink missing or wrong target")
  harness_issues=1
fi

# Key docs exist
for doc in docs/architecture.md docs/conventions.md docs/workflows.md docs/delegation.md docs/eval-criteria.md docs/runbook.md; do
  if [[ ! -f "$doc" ]]; then
    FINDINGS+=("[harness] Missing doc: $doc")
    harness_issues=1
  fi
done

# ── Summary ──────────────────────────────────────────────────
echo ""
if [[ ${#FINDINGS[@]} -eq 0 ]]; then
  echo -e "${GREEN}=== Sweep clean ===${NC}"
  touch tools/.sweep-stamp
  exit 0
fi

echo -e "${YELLOW}=== ${#FINDINGS[@]} finding(s) ===${NC}"
for f in "${FINDINGS[@]}"; do echo "  $f"; done
echo ""
echo -e "${YELLOW}Sweep stamp NOT updated — fix findings first.${NC}"
exit 1
