#!/usr/bin/env bash
# Fast PR status checker with local caching
# Only fetches full details for PRs that changed since last check
#
# Cache stored in .git/pr-status-cache.json
# First run fetches everything; subsequent runs only update changed PRs

set -euo pipefail

CACHE_FILE=".git/pr-status-cache.json"
METADATA_FILE=".git/git-stack-metadata.json"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Step 1: Single API call to get all open PRs with updatedAt ──
# This is the only network call on cache-hit runs
fresh_data=$(gh pr list --author "@me" --state open \
  --json number,title,headRefName,reviewDecision,statusCheckRollup,isDraft,state,updatedAt,url \
  --limit 50)

fresh_count=$(echo "$fresh_data" | jq 'length')

if [ "$fresh_count" -eq 0 ]; then
  echo "No open PRs found. 🎉"
  # Clear cache since no open PRs
  echo '{}' > "$CACHE_FILE"
  exit 0
fi

# ── Step 2: Compare against cache to find what changed ──
changed_count=0
cache_hit_count=0

if [ -f "$CACHE_FILE" ]; then
  cached=$(cat "$CACHE_FILE")
else
  cached='{}'
fi

# Build new cache from fresh data
new_cache=$(echo "$fresh_data" | jq '
  reduce .[] as $pr ({};
    . + { ($pr.number | tostring): {
      number: $pr.number,
      title: $pr.title,
      branch: $pr.headRefName,
      reviewDecision: ($pr.reviewDecision // "PENDING"),
      isDraft: $pr.isDraft,
      state: $pr.state,
      url: $pr.url,
      updatedAt: $pr.updatedAt,
      statusCheckRollup: $pr.statusCheckRollup,
      totalChecks: ([$pr.statusCheckRollup[] | select(.name != null)] | length),
      passedChecks: ([$pr.statusCheckRollup[] | select(.conclusion == "SUCCESS" or .conclusion == "NEUTRAL")] | length),
      failedChecks: ([$pr.statusCheckRollup[] | select(.conclusion == "FAILURE" or .conclusion == "CANCELLED" or .conclusion == "TIMED_OUT")] | length),
      pendingChecks: ([$pr.statusCheckRollup[] | select(.status == "IN_PROGRESS" or .status == "QUEUED" or .status == "PENDING")] | length),
      failedNames: ([$pr.statusCheckRollup[] | select(.conclusion == "FAILURE" or .conclusion == "CANCELLED" or .conclusion == "TIMED_OUT") | .name] | .[0:3])
    }}
  )
')

# Count changes
for pr_num in $(echo "$new_cache" | jq -r 'keys[]'); do
  new_updated=$(echo "$new_cache" | jq -r ".\"$pr_num\".updatedAt")
  old_updated=$(echo "$cached" | jq -r ".\"$pr_num\".updatedAt // \"\"")
  if [ "$new_updated" != "$old_updated" ]; then
    changed_count=$((changed_count + 1))
  else
    cache_hit_count=$((cache_hit_count + 1))
  fi
done

# Save updated cache
echo "$new_cache" > "$CACHE_FILE"

# ── Step 3: Display ──────────────────────────────────────

format_pr_from_cache() {
  local pr_num=$1
  local indent="${2:-}"
  local pr_json
  pr_json=$(echo "$new_cache" | jq ".\"$pr_num\"")

  local title state is_draft review url
  title=$(echo "$pr_json" | jq -r '.title')
  state=$(echo "$pr_json" | jq -r '.state')
  is_draft=$(echo "$pr_json" | jq -r '.isDraft')
  review=$(echo "$pr_json" | jq -r '.reviewDecision')
  url=$(echo "$pr_json" | jq -r '.url')

  local total passed failed pending
  total=$(echo "$pr_json" | jq -r '.totalChecks')
  passed=$(echo "$pr_json" | jq -r '.passedChecks')
  failed=$(echo "$pr_json" | jq -r '.failedChecks')
  pending=$(echo "$pr_json" | jq -r '.pendingChecks')

  # Was this PR updated since last check?
  local old_updated new_updated change_marker=""
  new_updated=$(echo "$pr_json" | jq -r '.updatedAt')
  old_updated=$(echo "$cached" | jq -r ".\"$pr_num\".updatedAt // \"\"")
  if [ "$new_updated" != "$old_updated" ]; then
    change_marker=" ${YELLOW}●${NC}"
  fi

  # State icon
  local state_icon
  if [ "$is_draft" = "true" ]; then
    state_icon="📝"
  else
    state_icon="🔵"
  fi

  # Review status
  local review_icon review_text
  case $review in
    APPROVED)           review_icon="✅"; review_text="Approved" ;;
    CHANGES_REQUESTED)  review_icon="❌"; review_text="Changes requested" ;;
    REVIEW_REQUIRED)    review_icon="👀"; review_text="Needs review" ;;
    *)                  review_icon="⏳"; review_text="Pending" ;;
  esac

  # CI status
  local ci_icon ci_text
  if [ "$total" -eq 0 ]; then
    ci_icon="⚪"; ci_text="No checks"
  elif [ "$failed" -gt 0 ]; then
    ci_icon="❌"; ci_text="$failed failed"
  elif [ "$pending" -gt 0 ]; then
    ci_icon="🟡"; ci_text="$pending running"
  elif [ "$passed" -eq "$total" ]; then
    ci_icon="✅"; ci_text="All passing ($total)"
  else
    ci_icon="⚪"; ci_text="Unknown"
  fi

  echo -e "${indent}${state_icon} #${pr_num}: ${title:0:70}${change_marker}"
  echo -e "${indent}   ${review_icon} ${review_text}  │  ${ci_icon} ${ci_text}"
  echo -e "${indent}   ${GRAY}${url}${NC}"

  # Show failed check names
  local failed_names
  failed_names=$(echo "$pr_json" | jq -r '.failedNames[]' 2>/dev/null || true)
  if [ -n "$failed_names" ]; then
    echo "$failed_names" | while IFS= read -r name; do
      echo -e "${indent}   ${RED}↳ ${name}${NC}"
    done
  fi
}

echo -e "${BOLD}📊 My Open PRs${NC}  ${GRAY}(${fresh_count} open, ${changed_count} updated, ${cache_hit_count} cached)${NC}"
echo ""

# ── Stacked PRs ──────────────────────────────────────────
stacked_pr_list=""

if [ -f "$METADATA_FILE" ] && command -v jq &> /dev/null; then
  stack_names=$(jq -r '.stacks | keys[]' "$METADATA_FILE" 2>/dev/null || echo "")

  for stack_name in $stack_names; do
    description=$(jq -r ".stacks[\"$stack_name\"].description // empty" "$METADATA_FILE")

    # Walk the stack in order
    declare -a ordered_prs=()
    current_parent="main"

    while true; do
      next_branch=$(jq -r --arg parent "$current_parent" --arg stack "$stack_name" \
        '.stacks[$stack].branches | to_entries[] | select(.value.parent == $parent) | .key' \
        "$METADATA_FILE" 2>/dev/null)

      if [ -z "$next_branch" ] || [ "$next_branch" = "null" ]; then
        break
      fi

      pr_num=$(jq -r --arg branch "$next_branch" --arg stack "$stack_name" \
        '.stacks[$stack].branches[$branch].pr // empty' "$METADATA_FILE")

      if [ -n "$pr_num" ]; then
        # Only include if PR is still open (exists in fresh data)
        if echo "$new_cache" | jq -e ".\"$pr_num\"" > /dev/null 2>&1; then
          ordered_prs+=("$pr_num")
          stacked_pr_list="$stacked_pr_list $pr_num"
        fi
      fi

      current_parent="$next_branch"
    done

    if [ ${#ordered_prs[@]} -eq 0 ]; then
      # All PRs in stack are merged/closed — clean up
      temp_file=$(mktemp)
      jq "del(.stacks[\"$stack_name\"])" "$METADATA_FILE" > "$temp_file"
      current_stack=$(jq -r '.current_stack // empty' "$temp_file")
      if [ "$current_stack" = "$stack_name" ]; then
        jq '.current_stack = null' "$temp_file" > "${temp_file}.2"
        mv "${temp_file}.2" "$temp_file"
      fi
      mv "$temp_file" "$METADATA_FILE"
      echo -e "${GRAY}🗑  Stack ${YELLOW}${stack_name}${GRAY} — all merged, removed${NC}"
      echo ""
      unset ordered_prs
      continue
    fi

    echo -e "${CYAN}📚 Stack: ${YELLOW}${stack_name}${NC}"
    if [ -n "$description" ]; then
      echo -e "   ${GRAY}${description}${NC}"
    fi
    echo ""

    for ((i=0; i<${#ordered_prs[@]}; i++)); do
      pr_num="${ordered_prs[$i]}"

      if [ $i -eq $((${#ordered_prs[@]} - 1)) ]; then
        tree="┗━"
      else
        tree="┣━"
      fi

      if [ $i -gt 0 ]; then
        echo -e "   ┃"
      fi
      echo -ne "   ${tree} "

      pr_output=$(format_pr_from_cache "$pr_num" "      ")
      echo "$pr_output" | head -1 | sed "s/^      //"
      echo "$pr_output" | tail -n +2
    done

    echo ""
    unset ordered_prs
  done
fi

# ── Standalone PRs ───────────────────────────────────────
standalone_found=false

for pr_num in $(echo "$new_cache" | jq -r 'to_entries | sort_by(.value.updatedAt) | reverse | .[].key'); do
  if echo "$stacked_pr_list" | grep -qw "$pr_num"; then
    continue
  fi

  if [ "$standalone_found" = false ]; then
    echo -e "${CYAN}📋 Standalone PRs${NC}"
    echo ""
    standalone_found=true
  fi

  format_pr_from_cache "$pr_num"
  echo ""
done

# ── Footer ───────────────────────────────────────────────
echo -e "${GRAY}────────────────────────────────────────${NC}"
echo -e "${GRAY}${YELLOW}●${GRAY} = updated since last check  │  Cache: ${CACHE_FILE}${NC}"
