#!/bin/bash

# Git Stack Init - Metadata manager for stacked PRs
# Central tool to manage .git/git-stack-metadata.json with named stacks

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Metadata file location (in .git/, persists across branches)
METADATA_FILE=".git/git-stack-metadata.json"

# Usage
usage() {
  cat << EOF
Usage: tmp/git-stack-init [COMMAND] [OPTIONS]

Manage git stack metadata for stacked PRs with named stacks.

COMMANDS:
  (none)          Initialize new stack interactively (or use CLI flags)
  --add           Add current branch to current stack
  --stack <name>  Create or switch to named stack
  --remove <br>   Remove a branch from current stack
  --show          Display all stacks
  --help          Show this help message

OPTIONS (for init and --add):
  --name <name>         Stack name (init only, skips prompt)
  --parent <branch>     Parent branch (skips interactive selection)
  --description <desc>  Description for branch or stack
  --create <branch>     Create new branch off top of stack and add it

EXAMPLES:
  # Initialize new stack (prompts for name and parent)
  tmp/git-stack-init

  # Fully non-interactive init
  tmp/git-stack-init --name podcast-preview --parent main --description "Podcast preview"

  # Create or switch to named stack
  tmp/git-stack-init --stack api-v3-migration

  # Add current branch to current stack
  tmp/git-stack-init --add

  # Add with explicit parent (non-interactive)
  tmp/git-stack-init --add --parent main --description "My feature"

  # Create new branch off top of stack and add it
  tmp/git-stack-init --add --create kiliman/merge-tag-refactor-WEB-7012

  # Remove a branch
  tmp/git-stack-init --remove kiliman/old-branch-WEB-1234

  # Show all stacks
  tmp/git-stack-init --show

METADATA LOCATION:
  .git/git-stack-metadata.json (persists, not committed)

EOF
  exit 0
}

# Check if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo -e "${RED}Error: Not in a git repository${NC}"
  exit 1
fi

# Get current branch
current_branch=$(git rev-parse --abbrev-ref HEAD)

if [[ "$current_branch" == "HEAD" ]]; then
  echo -e "${RED}Error: Detached HEAD state${NC}"
  exit 1
fi

# Initialize empty metadata file
init_metadata() {
  cat > "$METADATA_FILE" << 'EOF'
{
  "stacks": {},
  "current_stack": null
}
EOF
  echo -e "${GREEN}✓ Initialized empty stack metadata${NC}"
}

# Get current stack name
get_current_stack() {
  if [[ ! -f "$METADATA_FILE" ]]; then
    echo ""
    return
  fi

  if command -v jq &> /dev/null; then
    jq -r '.current_stack // empty' "$METADATA_FILE" 2>/dev/null
  else
    echo ""
  fi
}

# Find which stack contains the current branch
find_stack_for_branch() {
  local branch=$1

  if [[ ! -f "$METADATA_FILE" ]] || ! command -v jq &> /dev/null; then
    echo ""
    return
  fi

  jq -r ".stacks | to_entries[] | select(.value.branches[\"$branch\"]) | .key" "$METADATA_FILE" 2>/dev/null | head -1
}

# Get list of recent local branches (excluding current)
get_recent_branches() {
  git for-each-ref --sort=-committerdate refs/heads/ --format='%(refname:short)' | \
    grep -v "^$current_branch$" | \
    head -20
}

# Auto-detect if current branch is based on main
detect_parent() {
  # Check if the branch's merge-base is main (i.e., branched directly from main)
  local merge_base
  merge_base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo "")

  if [[ -z "$merge_base" ]]; then
    return 1
  fi

  # Check if any other local branch tip sits between main and HEAD
  # If merge-base with main equals the parent commit, it's directly off main
  local main_sha
  main_sha=$(git rev-parse origin/main 2>/dev/null || git rev-parse main 2>/dev/null)

  # If the merge-base IS main's HEAD, branch was created from latest main
  if [[ "$merge_base" == "$main_sha" ]]; then
    echo "main"
    return 0
  fi

  # Still likely based on main even if not tip — check no other stack branch is the parent
  # For now, if merge-base is on main's history, default to main
  if git merge-base --is-ancestor "$merge_base" main 2>/dev/null || \
     git merge-base --is-ancestor "$merge_base" origin/main 2>/dev/null; then
    echo "main"
    return 0
  fi

  return 1
}

# Prompt user to select parent branch
# All menu/prompt output goes to stderr so stdout is clean for the return value
select_parent() {
  # Auto-detect main-based branches
  local detected_parent
  detected_parent=$(detect_parent 2>/dev/null) || true

  if [[ -n "$detected_parent" ]]; then
    echo -e "${GREEN}✓ Auto-detected parent: ${YELLOW}${detected_parent}${NC}" >&2
    read -p "Use $detected_parent as parent? (Y/n): " confirm </dev/tty
    if [[ -z "$confirm" || "$confirm" =~ ^[Yy]$ ]]; then
      echo "$detected_parent"
      return 0
    fi
  fi

  local branches=()

  echo -e "${BLUE}Select parent branch for: ${YELLOW}$current_branch${NC}" >&2
  echo "" >&2
  echo "Recent branches:" >&2

  local i=1
  while IFS= read -r branch; do
    echo "  $i) $branch" >&2
    branches+=("$branch")
    ((i++))
  done < <(get_recent_branches)

  echo "  m) main" >&2
  echo "  c) Custom branch name" >&2
  echo "" >&2

  read -p "Select parent (number/m/c): " selection

  if [[ "$selection" == "m" ]]; then
    echo "main"
  elif [[ "$selection" == "c" ]]; then
    read -p "Enter branch name: " custom_branch
    echo "$custom_branch"
  elif [[ "$selection" =~ ^[0-9]+$ ]] && [[ "$selection" -ge 1 ]] && [[ "$selection" -lt "$i" ]]; then
    echo "${branches[$((selection-1))]}"
  else
    echo -e "${RED}Invalid selection${NC}" >&2
    return 1
  fi
}

# Get PR number for a branch (if it exists)
get_pr_number() {
  local branch=$1
  gh pr list --head "$branch" --json number --jq '.[0].number' 2>/dev/null || echo ""
}

# Get the last (top) branch in the current stack
get_top_of_stack() {
  local stack_name=$1

  if [[ ! -f "$METADATA_FILE" ]] || ! command -v jq &> /dev/null; then
    echo ""
    return
  fi

  jq -r ".stacks[\"$stack_name\"].last_branch // empty" "$METADATA_FILE" 2>/dev/null
}

# Create new stack
create_stack() {
  local stack_name=$1
  local description=${2:-""}

  if [[ ! -f "$METADATA_FILE" ]]; then
    init_metadata
  fi

  local temp_file=$(mktemp)
  jq ".stacks[\"$stack_name\"] = {\"description\": \"$description\", \"last_branch\": null, \"branches\": {}}" "$METADATA_FILE" > "$temp_file"
  jq ".current_stack = \"$stack_name\"" "$temp_file" > "$METADATA_FILE"
  rm "$temp_file"

  echo -e "${GREEN}✓ Created stack: ${BLUE}$stack_name${NC}"
}

# Add branch to stack
add_branch_to_stack() {
  local stack_name=$1
  local branch=$2
  local parent=$3
  local pr_number=${4:-""}
  local description=${5:-""}

  if [[ ! -f "$METADATA_FILE" ]]; then
    init_metadata
  fi

  # Build JSON for the branch
  local branch_json="{\"parent\": \"$parent\""

  if [[ -n "$pr_number" ]]; then
    branch_json="$branch_json, \"pr\": $pr_number"
  fi

  if [[ -n "$description" ]]; then
    # Escape quotes in description
    description=$(echo "$description" | sed 's/"/\\"/g')
    branch_json="$branch_json, \"description\": \"$description\""
  fi

  branch_json="$branch_json}"

  # Use jq to add the branch
  if command -v jq &> /dev/null; then
    local temp_file=$(mktemp)
    jq ".stacks[\"$stack_name\"].branches[\"$branch\"] = $branch_json" "$METADATA_FILE" > "$temp_file"
    jq ".stacks[\"$stack_name\"].last_branch = \"$branch\"" "$temp_file" > "$METADATA_FILE"
    rm "$temp_file"
  else
    echo -e "${RED}Error: jq is required for this operation${NC}"
    exit 1
  fi

  echo -e "${GREEN}✓ Added $branch to stack ${BLUE}$stack_name${NC}"
}

# Remove branch from stack
remove_branch_from_stack() {
  local stack_name=$1
  local branch=$2

  if [[ ! -f "$METADATA_FILE" ]]; then
    echo -e "${RED}Error: No stack metadata found${NC}"
    exit 1
  fi

  if command -v jq &> /dev/null; then
    local temp_file=$(mktemp)
    jq "del(.stacks[\"$stack_name\"].branches[\"$branch\"])" "$METADATA_FILE" > "$temp_file"
    mv "$temp_file" "$METADATA_FILE"
    echo -e "${GREEN}✓ Removed $branch from stack ${BLUE}$stack_name${NC}"
  else
    echo -e "${RED}Error: jq is required for this operation${NC}"
    exit 1
  fi
}

# Show all stacks
show_all_stacks() {
  if [[ ! -f "$METADATA_FILE" ]]; then
    echo -e "${RED}No stack metadata found${NC}"
    exit 1
  fi

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  All Git Stacks${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  if ! command -v jq &> /dev/null; then
    cat "$METADATA_FILE"
    exit 0
  fi

  local current_stack=$(get_current_stack)
  local stack_names=($(jq -r '.stacks | keys[]' "$METADATA_FILE"))

  if [[ ${#stack_names[@]} -eq 0 ]]; then
    echo -e "${YELLOW}No stacks found${NC}"
    exit 0
  fi

  for stack_name in "${stack_names[@]}"; do
    local description=$(jq -r ".stacks[\"$stack_name\"].description" "$METADATA_FILE")
    local branch_count=$(jq -r ".stacks[\"$stack_name\"].branches | length" "$METADATA_FILE")
    local last_branch=$(jq -r ".stacks[\"$stack_name\"].last_branch // empty" "$METADATA_FILE")

    if [[ "$stack_name" == "$current_stack" ]]; then
      echo -e "${GREEN}●${NC} ${YELLOW}$stack_name${NC} ${BLUE}(current)${NC}"
    else
      echo -e "${BLUE}○${NC} $stack_name"
    fi

    if [[ -n "$description" ]]; then
      echo -e "  ${GRAY}$description${NC}"
    fi

    echo -e "  ${BLUE}Branches:${NC} $branch_count"

    if [[ -n "$last_branch" ]]; then
      echo -e "  ${BLUE}Last:${NC} $last_branch"
    fi

    echo ""
  done
}

# Parse all arguments into variables
CMD=""
OPT_NAME=""
OPT_PARENT=""
OPT_DESCRIPTION=""
OPT_CREATE=""
OPT_STACK=""
OPT_REMOVE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)     CMD="help"; shift ;;
    --add)      CMD="add"; shift ;;
    --show)     CMD="show"; shift ;;
    --remove)   CMD="remove"; OPT_REMOVE="${2:-}"; shift 2 ;;
    --stack)    CMD="stack"; OPT_STACK="${2:-}"; shift 2 ;;
    --name)     OPT_NAME="${2:-}"; shift 2 ;;
    --parent)   OPT_PARENT="${2:-}"; shift 2 ;;
    --description) OPT_DESCRIPTION="${2:-}"; shift 2 ;;
    --create)   OPT_CREATE="${2:-}"; shift 2 ;;
    *)          echo -e "${RED}Unknown option: $1${NC}"; usage ;;
  esac
done

# Default command is "init" when no command given
CMD="${CMD:-init}"

case "$CMD" in
  help)
    usage
    ;;

  add)
    current_stack=$(get_current_stack)

    if [[ -z "$current_stack" ]]; then
      echo -e "${RED}Error: No current stack set${NC}"
      echo ""
      echo "Create a new stack first:"
      echo -e "  ${GREEN}tmp/git-stack-init --stack <name>${NC}"
      exit 1
    fi

    # --create: make a new branch off the top of the stack
    if [[ -n "$OPT_CREATE" ]]; then
      top_branch=$(get_top_of_stack "$current_stack")

      if [[ -z "$top_branch" ]]; then
        echo -e "${RED}Error: Stack has no branches yet. Add the base branch first.${NC}"
        exit 1
      fi

      echo -e "${CYAN}Creating branch off top of stack: ${YELLOW}$top_branch${NC}"

      # Checkout top of stack if not already there
      if [[ "$current_branch" != "$top_branch" ]]; then
        echo -e "${BLUE}Switching to $top_branch...${NC}"
        git checkout "$top_branch"
      fi

      # Create new branch
      git checkout -b "$OPT_CREATE"
      current_branch="$OPT_CREATE"

      echo -e "${GREEN}✓ Created branch: ${YELLOW}$OPT_CREATE${NC}"
      echo ""

      # Parent is automatically the top of stack
      OPT_PARENT="$top_branch"
    fi

    branch_to_add="$current_branch"

    echo -e "${CYAN}Adding branch to stack ${BLUE}$current_stack${CYAN}: ${YELLOW}$branch_to_add${NC}"
    echo ""

    # Get parent: CLI flag > interactive
    if [[ -n "$OPT_PARENT" ]]; then
      parent="$OPT_PARENT"
      echo -e "${GREEN}✓ Parent: ${YELLOW}$parent${NC}"
    else
      parent=$(select_parent)
      if [[ -z "$parent" ]]; then
        exit 1
      fi
    fi

    echo ""
    echo -e "${BLUE}Getting PR information...${NC}"
    pr_number=$(get_pr_number "$branch_to_add")

    if [[ -n "$pr_number" ]]; then
      echo -e "${GREEN}Found PR #$pr_number${NC}"
    fi

    # Get description: CLI flag > interactive
    if [[ -n "$OPT_DESCRIPTION" ]]; then
      description="$OPT_DESCRIPTION"
    else
      read -p "Enter description (optional): " description
    fi

    add_branch_to_stack "$current_stack" "$branch_to_add" "$parent" "$pr_number" "$description"
    ;;

  stack)
    if [[ -z "$OPT_STACK" ]]; then
      echo -e "${RED}Error: Stack name required${NC}"
      echo "Usage: tmp/git-stack-init --stack <name>"
      exit 1
    fi

    stack_name="$OPT_STACK"

    if [[ ! -f "$METADATA_FILE" ]]; then
      init_metadata
    fi

    # Check if stack exists
    if command -v jq &> /dev/null; then
      stack_exists=$(jq -e ".stacks[\"$stack_name\"]" "$METADATA_FILE" >/dev/null 2>&1 && echo "true" || echo "false")
    else
      stack_exists="false"
    fi

    if [[ "$stack_exists" == "true" ]]; then
      # Switch to existing stack
      temp_file=$(mktemp)
      jq ".current_stack = \"$stack_name\"" "$METADATA_FILE" > "$temp_file"
      mv "$temp_file" "$METADATA_FILE"
      echo -e "${GREEN}✓ Switched to stack: ${BLUE}$stack_name${NC}"
    else
      # Create new stack
      if [[ -n "$OPT_DESCRIPTION" ]]; then
        description="$OPT_DESCRIPTION"
      else
        read -p "Enter stack description (optional): " description
      fi
      create_stack "$stack_name" "$description"
      echo ""
      echo "Add current branch to stack with:"
      echo -e "  ${GREEN}tmp/git-stack-init --add${NC}"
    fi
    ;;

  remove)
    if [[ -z "$OPT_REMOVE" ]]; then
      echo -e "${RED}Error: Branch name required${NC}"
      echo "Usage: tmp/git-stack-init --remove <branch>"
      exit 1
    fi

    current_stack=$(get_current_stack)

    if [[ -z "$current_stack" ]]; then
      echo -e "${RED}Error: No current stack set${NC}"
      exit 1
    fi

    remove_branch_from_stack "$current_stack" "$OPT_REMOVE"
    ;;

  show)
    show_all_stacks
    ;;

  init)
    # Default: Initialize new stack with current branch
    echo -e "${CYAN}Initializing new stack with: ${YELLOW}$current_branch${NC}"
    echo ""

    # Get stack name: CLI flag > interactive
    if [[ -n "$OPT_NAME" ]]; then
      stack_name="$OPT_NAME"
    else
      read -p "Enter stack name: " stack_name
    fi

    if [[ -z "$stack_name" ]]; then
      echo -e "${RED}Error: Stack name required${NC}"
      exit 1
    fi

    # Get stack description: CLI flag > interactive
    if [[ -n "$OPT_DESCRIPTION" ]]; then
      stack_description="$OPT_DESCRIPTION"
    else
      read -p "Enter stack description (optional): " stack_description
    fi

    create_stack "$stack_name" "$stack_description"

    echo ""

    # Get parent: CLI flag > interactive
    if [[ -n "$OPT_PARENT" ]]; then
      parent="$OPT_PARENT"
      echo -e "${GREEN}✓ Parent: ${YELLOW}$parent${NC}"
    else
      parent=$(select_parent)
      if [[ -z "$parent" ]]; then
        exit 1
      fi
    fi

    echo ""
    echo -e "${BLUE}Getting PR information...${NC}"
    pr_number=$(get_pr_number "$current_branch")

    if [[ -n "$pr_number" ]]; then
      echo -e "${GREEN}Found PR #$pr_number${NC}"
    fi

    # For init, description was already used for the stack, so prompt for branch description
    read -p "Enter description for branch (optional): " branch_description

    add_branch_to_stack "$stack_name" "$current_branch" "$parent" "$pr_number" "$branch_description"

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Stack initialized!${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Next steps:"
    echo -e "  • Add more branches: ${BLUE}tmp/git-stack-init --add${NC}"
    echo -e "  • View stack: ${BLUE}tmp/git-stack${NC}"
    echo -e "  • Sync stack: ${BLUE}tmp/git-stack-sync${NC}"
    ;;
esac
