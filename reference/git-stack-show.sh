#!/usr/bin/env bash
# Show the current PR stack by following base branch links
# Uses cached metadata (.git/git-stack-metadata.json) for speed

set -euo pipefail

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Metadata file
METADATA_FILE=".git/git-stack-metadata.json"

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)

# Check for --switch flag
if [[ "${1:-}" == "--switch" ]]; then
  if [[ ! -f "$METADATA_FILE" ]] || ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: No stack metadata found${NC}"
    echo ""
    echo "Initialize with:"
    echo -e "  ${GREEN}tmp/git-stack-init${NC}"
    exit 1
  fi

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  Switch Stack${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  current_stack=$(jq -r '.current_stack // empty' "$METADATA_FILE")
  stack_names=($(jq -r '.stacks | keys[]' "$METADATA_FILE"))

  if [[ ${#stack_names[@]} -eq 0 ]]; then
    echo -e "${YELLOW}No stacks found${NC}"
    exit 0
  fi

  declare -a numbered_stacks=()
  stack_num=1

  for stack_name in "${stack_names[@]}"; do
    description=$(jq -r ".stacks[\"$stack_name\"].description // empty" "$METADATA_FILE")
    branch_count=$(jq -r ".stacks[\"$stack_name\"].branches | length" "$METADATA_FILE")
    last_branch=$(jq -r ".stacks[\"$stack_name\"].last_branch // empty" "$METADATA_FILE")

    if [[ "$stack_name" == "$current_stack" ]]; then
      echo -e "${BLUE}[$stack_num]${NC} ${YELLOW}$stack_name${NC} (${branch_count} PRs) ${BLUE}← current${NC}"
    else
      echo -e "${BLUE}[$stack_num]${NC} $stack_name (${branch_count} PRs)"
    fi

    if [[ -n "$description" ]]; then
      echo -e "     ${GRAY}$description${NC}"
    fi

    numbered_stacks+=("$stack_name")
    ((stack_num++))
  done

  echo ""
  read -p "Switch to stack [1-${#numbered_stacks[@]}] or [q]uit: " -n 1 -r choice
  echo ""

  if [[ "$choice" =~ ^[1-9]$ ]] && [ "$choice" -le "${#numbered_stacks[@]}" ]; then
    target_stack="${numbered_stacks[$((choice-1))]}"

    # Update current_stack
    temp_file=$(mktemp)
    jq ".current_stack = \"$target_stack\"" "$METADATA_FILE" > "$temp_file"
    mv "$temp_file" "$METADATA_FILE"

    # Checkout last branch in stack (even if already on this stack, in case current branch is wrong)
    last_branch=$(jq -r ".stacks[\"$target_stack\"].last_branch // empty" "$METADATA_FILE")

    if [[ -n "$last_branch" ]] && [[ "$last_branch" != "$CURRENT_BRANCH" ]]; then
      echo -e "${BLUE}→ Switching to stack ${YELLOW}$target_stack${NC}"
      echo -e "${BLUE}→ Checking out ${YELLOW}$last_branch${NC}"
      git checkout "$last_branch"
    else
      echo -e "${GREEN}✓ Switched to stack ${YELLOW}$target_stack${NC}"
    fi
  elif [[ "$choice" != "q" ]] && [[ "$choice" != "Q" ]] && [[ -n "$choice" ]]; then
    echo -e "${YELLOW}Invalid selection${NC}"
  fi

  exit 0
fi

# Check if metadata exists
if [[ ! -f "$METADATA_FILE" ]]; then
  echo -e "${YELLOW}No stack metadata found${NC}"
  echo ""
  echo "Create your first stack with:"
  echo -e "  ${GREEN}tmp/git-stack-init${NC}"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is required${NC}"
  exit 1
fi

# Find which stack contains the current branch
find_stack_for_branch() {
  local branch=$1
  jq -r ".stacks | to_entries[] | select(.value.branches[\"$branch\"]) | .key" "$METADATA_FILE" 2>/dev/null | head -1
}

CURRENT_STACK=$(find_stack_for_branch "$CURRENT_BRANCH")

if [[ -z "$CURRENT_STACK" ]]; then
  echo -e "${YELLOW}Branch ${BLUE}$CURRENT_BRANCH${YELLOW} is not in any stack${NC}"
  echo ""
  echo "Add it to a stack with:"
  echo -e "  ${GREEN}tmp/git-stack-init --add${NC}"
  echo ""
  echo "Or create a new stack:"
  echo -e "  ${GREEN}tmp/git-stack-init${NC}"
  exit 1
fi

# Update current_stack and last_branch
temp_file=$(mktemp)
jq ".current_stack = \"$CURRENT_STACK\"" "$METADATA_FILE" > "$temp_file"
jq ".stacks[\"$CURRENT_STACK\"].last_branch = \"$CURRENT_BRANCH\"" "$temp_file" > "$METADATA_FILE"
rm "$temp_file"

stack_description=$(jq -r ".stacks[\"$CURRENT_STACK\"].description // empty" "$METADATA_FILE")

echo -e "${BLUE}📚 PR Stack: ${YELLOW}$CURRENT_STACK${NC}"
if [[ -n "$stack_description" ]]; then
  echo -e "${GRAY}   $stack_description${NC}"
fi
echo ""

# Function to get PR info from metadata
get_pr_info_from_metadata() {
  local branch=$1
  local parent=$(jq -r ".stacks[\"$CURRENT_STACK\"].branches[\"$branch\"].parent // empty" "$METADATA_FILE" 2>/dev/null)
  local pr_number=$(jq -r ".stacks[\"$CURRENT_STACK\"].branches[\"$branch\"].pr // empty" "$METADATA_FILE" 2>/dev/null)
  local description=$(jq -r ".stacks[\"$CURRENT_STACK\"].branches[\"$branch\"].description // empty" "$METADATA_FILE" 2>/dev/null)

  if [ -z "$parent" ]; then
    echo ""
    return
  fi

  # Return JSON in same format as GitHub API
  local json=$(cat <<EOF
{
  "number": ${pr_number:-null},
  "title": "$description",
  "baseRefName": "$parent",
  "state": "OPEN"
}
EOF
)
  echo "$json"
}

# Build the FULL stack (all branches in current stack, ordered by dependency)
declare -a stack_branches=()
declare -a stack_pr_numbers=()
declare -a stack_pr_titles=()
declare -a stack_pr_states=()

# Function to recursively add branches and their children
add_branch_and_children() {
  local parent=$1

  # Find all branches with this parent
  while IFS= read -r branch; do
    if [ -n "$branch" ]; then
      pr_info=$(get_pr_info_from_metadata "$branch")

      if [ -n "$pr_info" ]; then
        pr_number=$(echo "$pr_info" | jq -r '.number')
        pr_title=$(echo "$pr_info" | jq -r '.title')
        pr_state=$(echo "$pr_info" | jq -r '.state')

        stack_branches+=("$branch")
        stack_pr_numbers+=("#$pr_number")
        stack_pr_titles+=("$pr_title")
        stack_pr_states+=("$pr_state")

        # Recursively add this branch's children
        add_branch_and_children "$branch"
      fi
    fi
  done < <(jq -r ".stacks[\"$CURRENT_STACK\"].branches | to_entries[] | select(.value.parent == \"$parent\") | .key" "$METADATA_FILE")
}

# Start from main and build the tree
add_branch_and_children "main"

# If no PRs found
if [ ${#stack_branches[@]} -eq 0 ]; then
  echo -e "${GRAY}No PRs found in this stack${NC}"
  echo -e "${GRAY}Tip: Add branches with 'tmp/git-stack-init --add'${NC}"
  exit 0
fi

# Print the stack (already in correct order: main -> PR1 -> PR2)
echo -e "${GREEN}◯ main${NC}"

# Track branch numbers for interactive switching
declare -a numbered_branches=()
branch_num=1

for ((i=0; i<${#stack_branches[@]}; i++)); do
  branch="${stack_branches[$i]}"
  pr_number="${stack_pr_numbers[$i]}"
  pr_title="${stack_pr_titles[$i]}"
  pr_state="${stack_pr_states[$i]}"

  # Tree characters
  if [ $i -eq $((${#stack_branches[@]}-1)) ]; then
    # Last item in stack
    tree="┗━◯"
  else
    tree="┣━◯"
  fi

  # State indicator
  if [ "$pr_state" == "MERGED" ]; then
    state_icon=" ${GREEN}✓${NC}"
  elif [ "$pr_state" == "CLOSED" ]; then
    state_icon=" ${GRAY}✗${NC}"
  else
    state_icon=""
  fi

  # Add branch number (always, for consistent numbering)
  branch_label="[${BLUE}${branch_num}${NC}] "
  numbered_branches+=("$branch")

  # Add current marker if this is the current branch
  if [ "$branch" == "$CURRENT_BRANCH" ]; then
    marker=" ${YELLOW}(current)${NC}"
  else
    marker=""
  fi

  ((branch_num++))

  # Highlight current branch
  if [ "$branch" == "$CURRENT_BRANCH" ]; then
    echo -e "┃"
    echo -e "${tree} ${branch_label}${YELLOW}${branch}${NC}${state_icon}${marker}"
    echo -e "┃   ${BLUE}${pr_number}${NC}: ${pr_title}"
  else
    echo -e "┃"
    echo -e "${tree} ${branch_label}${branch}${state_icon}"
    echo -e "┃   ${GRAY}${pr_number}: ${pr_title}${NC}"
  fi
done

echo ""
echo -e "${GRAY}Tip: Switch stacks with 'tmp/git-stack --switch'${NC}"

# Interactive branch switcher
if [ ${#numbered_branches[@]} -gt 0 ]; then
  echo ""
  read -p "Switch to branch [1-${#numbered_branches[@]}] or [q]uit: " -n 1 -r choice
  echo ""

  if [[ "$choice" =~ ^[1-9]$ ]] && [ "$choice" -le "${#numbered_branches[@]}" ]; then
    target_branch="${numbered_branches[$((choice-1))]}"

    # Check if already on this branch
    if [ "$target_branch" == "$CURRENT_BRANCH" ]; then
      echo -e "${GRAY}Already on ${YELLOW}${target_branch}${NC}"
    else
      echo -e "${BLUE}→ Switching to ${YELLOW}${target_branch}${NC}"
      git checkout "$target_branch"
    fi
  elif [[ "$choice" != "q" ]] && [[ "$choice" != "Q" ]] && [[ -n "$choice" ]]; then
    echo -e "${YELLOW}Invalid selection${NC}"
  fi
fi
