#!/usr/bin/env bash
# Update PR descriptions with stack visualization for ALL PRs in the stack.
# Can be run from any branch in the stack — it finds the stack and updates every PR.

set -euo pipefail

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
RED='\033[0;31m'
NC='\033[0m' # No Color

METADATA_FILE=".git/git-stack-metadata.json"

# Check if metadata file exists
if [ ! -f "$METADATA_FILE" ]; then
  echo -e "${RED}❌ No metadata file found. Run tmp/git-stack-init first.${NC}"
  exit 1
fi

# Get current branch or use argument to find the stack
BRANCH=${1:-$(git branch --show-current)}

echo -e "${BLUE}📝 Updating PR descriptions with stack visualization${NC}\n"

# Find which stack this branch belongs to
STACK_NAME=$(jq -r --arg branch "$BRANCH" '
  .stacks | to_entries[] | select(.value.branches | has($branch)) | .key
' "$METADATA_FILE")

if [ -z "$STACK_NAME" ] || [ "$STACK_NAME" == "null" ]; then
  echo -e "${RED}❌ Branch ${BRANCH} not found in any stack${NC}"
  exit 1
fi

echo -e "${GRAY}Stack: ${STACK_NAME}${NC}"

# Get all branches in the stack with their parent relationships
STACK_DATA=$(jq -r --arg stack "$STACK_NAME" '.stacks[$stack].branches' "$METADATA_FILE")

# Build ordered list of branches (from main to leaf)
declare -a stack_branches=()
declare -a stack_pr_numbers=()
declare -a stack_pr_titles=()
declare -a stack_review_emojis=()

# Walk the chain from main to leaf
current="main"

while true; do
  # Find the branch that has current as parent
  next_branch=$(echo "$STACK_DATA" | jq -r --arg parent "$current" '
    to_entries[] | select(.value.parent == $parent) | .key
  ')

  if [ -z "$next_branch" ] || [ "$next_branch" == "null" ]; then
    break
  fi

  # Get PR number and description
  pr_number=$(echo "$STACK_DATA" | jq -r --arg branch "$next_branch" '.[$branch].pr // "null"')
  description=$(echo "$STACK_DATA" | jq -r --arg branch "$next_branch" '.[$branch].description')

  # Get PR title and review status from GitHub if PR exists
  if [ "$pr_number" != "null" ]; then
    pr_info=$(gh pr view "$pr_number" --json title,reviewDecision 2>/dev/null || echo '{}')
    pr_title=$(echo "$pr_info" | jq -r '.title // ""')
    [ -z "$pr_title" ] && pr_title="$description"
    review_decision=$(echo "$pr_info" | jq -r '.reviewDecision // "PENDING"')
  else
    pr_title="$description"
    review_decision="NONE"
  fi

  # Map review decision to emoji
  case $review_decision in
    APPROVED)           review_emoji="✅" ;;
    CHANGES_REQUESTED)  review_emoji="❌" ;;
    REVIEW_REQUIRED)    review_emoji="👀" ;;
    *)                  review_emoji="⏳" ;;
  esac

  stack_branches+=("$next_branch")
  stack_pr_numbers+=("$pr_number")
  stack_pr_titles+=("$pr_title")
  stack_review_emojis+=("$review_emoji")

  current="$next_branch"
done

echo -e "${GRAY}Found ${#stack_branches[@]} branches in stack${NC}\n"

# Generate stack viz and update each PR that has one
updated=0
skipped=0

for ((target=0; target<${#stack_branches[@]}; target++)); do
  target_branch="${stack_branches[$target]}"
  target_pr="${stack_pr_numbers[$target]}"

  # Skip branches without PRs
  if [ "$target_pr" == "null" ]; then
    echo -e "${GRAY}⏭  ${target_branch} — no PR, skipping${NC}"
    skipped=$((skipped + 1))
    continue
  fi

  # Build stack visualization with 👈 for this specific PR
  STACK_VIZ="### 📚 Stacked on\n\n"

  if [ ${#stack_branches[@]} -eq 1 ]; then
    STACK_VIZ+="- ⚫ **main**\n"
  else
    STACK_VIZ+="<pre>\n"
    STACK_VIZ+="⚫ main\n"
    STACK_VIZ+="┃\n"

    for ((i=0; i<${#stack_branches[@]}; i++)); do
      branch="${stack_branches[$i]}"
      pr_num="${stack_pr_numbers[$i]}"
      pr_title="${stack_pr_titles[$i]}"
      review_emoji="${stack_review_emojis[$i]}"

      # 👈 marker for the PR we're updating
      current_marker=""
      if [ "$branch" == "$target_branch" ]; then
        current_marker=" 👈"
      fi

      # Format PR link
      if [ "$pr_num" != "null" ]; then
        pr_link="<a href=\"https://github.com/beehiiv/swarm/pull/${pr_num}\">#${pr_num}</a>"
      else
        pr_link="(no PR yet)"
      fi

      # Last item uses └, others use ├
      if [ $i -eq $((${#stack_branches[@]} - 1)) ]; then
        STACK_VIZ+="┗━ ${review_emoji} ${pr_link} ${pr_title}${current_marker}\n"
      else
        STACK_VIZ+="┣━ ${review_emoji} ${pr_link} ${pr_title}${current_marker}\n"
        STACK_VIZ+="┃\n"
      fi
    done

    STACK_VIZ+="</pre>\n"
  fi

  # Get current PR body and update it
  CURRENT_BODY=$(gh pr view "$target_pr" --json body --jq '.body')

  # Remove existing stack section if present
  if echo "$CURRENT_BODY" | grep -q "### 📚 Stacked on"; then
    UPDATED_BODY=$(echo "$CURRENT_BODY" | sed '/### 📚 Stacked on/,$d')
  else
    UPDATED_BODY="$CURRENT_BODY"
  fi

  # Trim trailing whitespace
  UPDATED_BODY=$(echo "$UPDATED_BODY" | sed -e 's/[[:space:]]*$//')

  # Append stack visualization
  if [ -n "$UPDATED_BODY" ]; then
    NEW_BODY="${UPDATED_BODY}\n\n${STACK_VIZ}"
  else
    NEW_BODY="${STACK_VIZ}"
  fi

  # Update PR description
  TEMP_FILE=$(mktemp)
  echo -e "$NEW_BODY" > "$TEMP_FILE"
  gh pr edit "$target_pr" --body-file "$TEMP_FILE" > /dev/null
  rm "$TEMP_FILE"

  echo -e "${GREEN}✅ PR #${target_pr}${NC} ${stack_pr_titles[$target]}"
  updated=$((updated + 1))
done

echo -e "\n${GREEN}Done!${NC} Updated ${updated} PR(s)$([ $skipped -gt 0 ] && echo ", skipped ${skipped} without PRs")."
