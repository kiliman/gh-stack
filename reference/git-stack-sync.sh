#!/bin/bash

# Git Stack Sync - Interactive rebase tool for stacked PRs
# Similar to `gt repo sync` but for our manual git stack workflow
#
# TYPICAL WORKFLOW (restack after updating a parent PR):
#   1. Make changes to PR1 based on review feedback
#   2. Commit and push PR1
#   3. Checkout PR2 and run: tmp/git-restack (or tmp/gh-stack-sync)
#   4. This propagates changes from PR1 → PR2 → PR3 → etc.
#
# The script uses temporary tags to mark the exact divergence point
# of each branch BEFORE any rebasing starts. This ensures we only
# move commits that belong to each PR, not commits from parent rebases.

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# State file for resuming after conflicts
STATE_FILE=".git/.gh-stack-sync-state"

# Usage
usage() {
  cat << EOF
Usage: tmp/gh-stack-sync [OPTIONS]

Interactive tool to rebase stacked branches onto their updated parents.

OPTIONS:
  --dry-run       Show what would happen without executing
  --resume        Resume after resolving rebase conflicts
  --verbose, -v   Show verbose logging (diagnostic info)
  --rebase        Include rebasing base branch onto main (full sync)
  --help          Show this help message

WORKFLOW (typical - restack after updating parent PR):
  1. Make changes to PR1 based on review feedback
  2. Commit and push PR1
  3. Run from any child branch: tmp/git-restack
  4. This propagates PR1 changes → PR2 → PR3 → etc.
  5. By default, skips rebasing PR1 onto main

WORKFLOW (full sync from main):
  1. Run from base branch: tmp/gh-stack-sync --rebase
  2. This rebases PR1 onto main, then restacks all children
  3. Use this after main has significant updates

EXAMPLE:
  # After rebasing PR1 onto main:
  git checkout kiliman/feature-pr2-WEB-1234
  tmp/gh-stack-sync

  # If conflicts occur, resolve them and resume:
  git rebase --continue
  tmp/gh-stack-sync --resume

EOF
  exit 0
}

# Parse arguments
DRY_RUN=false
RESUME=false
VERBOSE=false
REBASE_FROM_MAIN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --resume)
      RESUME=true
      shift
      ;;
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    --rebase)
      REBASE_FROM_MAIN=true
      shift
      ;;
    --help)
      usage
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      usage
      ;;
  esac
done

# Check if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo -e "${RED}Error: Not in a git repository${NC}"
  exit 1
fi

# Check for clean working tree (unless resuming)
if [[ "$RESUME" == false ]]; then
  if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}Error: Working tree is not clean${NC}"
    echo "Please commit or stash your changes first"
    exit 1
  fi
fi

# Check if stack metadata exists
STACK_FILE=".git/gh-stack-metadata.json"
if [[ ! -f "$STACK_FILE" ]]; then
  echo -e "${YELLOW}No stack metadata found${NC}"
  echo ""
  echo "Create your first stack with:"
  echo -e "  ${GREEN}tmp/gh-stack-init${NC}"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is required${NC}"
  exit 1
fi

# Get current branch
current_branch=$(git rev-parse --abbrev-ref HEAD)

if [[ "$current_branch" == "HEAD" ]]; then
  echo -e "${RED}Error: Detached HEAD state${NC}"
  echo "Please checkout a branch first"
  exit 1
fi

# Find which stack contains the current branch
find_stack_for_branch() {
  local branch=$1
  jq -r ".stacks | to_entries[] | select(.value.branches[\"$branch\"]) | .key" "$STACK_FILE" 2>/dev/null | head -1
}

CURRENT_STACK=$(find_stack_for_branch "$current_branch")

# Validate current branch is in a stack (unless resuming)
if [[ "$RESUME" == false ]]; then
  if [[ -z "$CURRENT_STACK" ]]; then
    echo -e "${YELLOW}Branch ${BLUE}$current_branch${YELLOW} is not in any stack${NC}"
    echo ""
    echo "Add it to a stack with:"
    echo -e "  ${GREEN}tmp/gh-stack-init --add${NC}"
    echo ""
    echo "Or create a new stack:"
    echo -e "  ${GREEN}tmp/gh-stack-init${NC}"
    exit 1
  fi
fi

# Function to get parent branch from stack metadata
get_parent() {
  local branch=$1
  jq -r ".stacks[\"$CURRENT_STACK\"].branches[\"$branch\"].parent // empty" "$STACK_FILE"
}

# Function to get all children of a branch
get_children() {
  local parent_branch=$1
  local children=()

  while IFS= read -r child; do
    [[ -n "$child" ]] && children+=("$child")
  done < <(jq -r ".stacks[\"$CURRENT_STACK\"].branches | to_entries[] | select(.value.parent == \"$parent_branch\") | .key" "$STACK_FILE")

  printf '%s\n' "${children[@]}"
}

# Function to build rebase chain (current branch + all descendants)
build_chain() {
  local start_branch=$1
  local chain=("$start_branch")
  local queue=("$start_branch")

  while [[ ${#queue[@]} -gt 0 ]]; do
    local current="${queue[0]}"
    queue=("${queue[@]:1}")  # Remove first element

    # Get children of current branch
    local children=()
    while IFS= read -r child; do
      [[ -n "$child" ]] && children+=("$child")
    done < <(get_children "$current")

    for child in "${children[@]}"; do
      if [[ -n "$child" ]]; then
        chain+=("$child")
        queue+=("$child")
      fi
    done
  done

  printf '%s\n' "${chain[@]}"
}

# Save state for resume
save_state() {
  local current_index=$1
  shift
  local chain=("$@")

  cat > "$STATE_FILE" << EOF
CURRENT_INDEX=$current_index
CURRENT_STACK="$CURRENT_STACK"
CHAIN=(${chain[@]})
EOF
}

# Load state for resume
load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    source "$STATE_FILE"
    return 0
  else
    echo -e "${RED}Error: No saved state found${NC}"
    echo "Nothing to resume"
    exit 1
  fi
}

# Cleanup function to remove temporary tags
cleanup_tags() {
  git tag -l "stack-sync-*" | xargs -r git tag -d > /dev/null 2>&1
}

# Ensure cleanup happens on exit
trap cleanup_tags EXIT

# Check for stale tags from previous runs (unless resuming)
if [[ "$RESUME" == false ]]; then
  stale_tags=$(git tag -l "stack-sync-*")
  if [[ -n "$stale_tags" ]]; then
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  Warning: Stale Tags Found${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${YELLOW}Found existing stack-sync-* tags from a previous run:${NC}"
    echo "$stale_tags" | while read -r tag; do
      echo -e "  ${CYAN}$tag${NC}"
    done
    echo ""
    echo "This usually means a previous sync was interrupted."
    echo ""
    echo "Options:"
    echo -e "  ${GREEN}1${NC} - Clean up tags and start fresh sync"
    echo -e "  ${GREEN}2${NC} - Resume from previous sync (same as --resume)"
    echo -e "  ${RED}3${NC} - Abort (keep tags, exit)"
    echo ""
    read -p "Choose [1/2/3]: " -n 1 -r
    echo ""
    echo ""

    case $REPLY in
      1)
        echo -e "${BLUE}Cleaning up stale tags...${NC}"
        cleanup_tags
        echo -e "${GREEN}✓ Tags cleaned${NC}"
        echo ""
        ;;
      2)
        echo -e "${BLUE}Resuming from previous sync...${NC}"
        RESUME=true
        ;;
      3)
        echo -e "${YELLOW}Aborted${NC}"
        exit 0
        ;;
      *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
    esac
  fi
fi

# Main logic
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  Git Stack Sync${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Track rebased branches for push summary
declare -a rebased_branches=()

# Handle resume mode
if [[ "$RESUME" == true ]]; then
  echo -e "${YELLOW}Resuming from saved state...${NC}"
  load_state

  # Check if we're still in a rebase (check if rebase directories exist)
  rebase_dir_merge=".git/rebase-merge"
  rebase_dir_apply=".git/rebase-apply"

  if [[ -d "$rebase_dir_merge" ]] || [[ -d "$rebase_dir_apply" ]]; then
    echo -e "${RED}Error: Rebase still in progress${NC}"
    echo "Please complete the rebase first:"
    echo "  git rebase --continue"
    echo "  # or"
    echo "  git rebase --abort"
    exit 1
  fi

  # Rebase is complete (no rebase directories exist)
  # Now check if it was successful or aborted
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  saved_branch="${CHAIN[$CURRENT_INDEX]}"

  if [[ "$current_branch" != "$saved_branch" ]]; then
    echo -e "${YELLOW}Warning: Branch mismatch detected${NC}"
    echo -e "Expected: ${BLUE}$saved_branch${NC}"
    echo -e "Current:  ${BLUE}$current_branch${NC}"
    echo ""
    echo "This likely means the rebase was aborted."
    echo -e "${YELLOW}Cleaning up stale state...${NC}"
    rm -f "$STATE_FILE"
    echo ""
    echo "State cleared. To sync the stack, run from the desired branch:"
    echo -e "  ${GREEN}tmp/gh-stack-sync${NC}"
    exit 0
  else
    # We're on the expected branch - check if it was successfully rebased
    parent=$(get_parent "$saved_branch")
    if [[ -n "$parent" ]] && ! git merge-base --is-ancestor "$parent" "$saved_branch" 2>/dev/null; then
      echo -e "${YELLOW}⚠ Branch still needs rebasing (rebase may have been aborted)${NC}"
      echo -e "${YELLOW}Cleaning up stale state...${NC}"
      rm -f "$STATE_FILE"
      echo ""
      echo "State cleared. To retry, run:"
      echo -e "  ${GREEN}tmp/gh-stack-sync${NC}"
      exit 0
    else
      echo -e "${GREEN}✓ Rebase completed successfully${NC}"
      echo ""
      # Add to rebased branches so it gets prompted for push
      rebased_branches+=("$saved_branch")
      # Remove state file on success
      rm -f "$STATE_FILE"

      # Check if branch needs to be pushed (do this immediately after resume too)
      if git ls-remote --exit-code --heads origin "$saved_branch" >/dev/null 2>&1; then
        local_sha=$(git rev-parse "$saved_branch")
        remote_sha=$(git rev-parse "origin/$saved_branch" 2>/dev/null || echo "")

        if [[ "$local_sha" != "$remote_sha" ]]; then
          echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
          echo -e "${BLUE}  Push Rebased Branch?${NC}"
          echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
          echo ""
          echo -e "${BLUE}Branch:${NC} $saved_branch"
          echo -e "${YELLOW}⚠ Branch is out of sync with remote${NC}"
          echo -e "  Local:  ${local_sha:0:8}"
          echo -e "  Remote: ${remote_sha:0:8}"
          echo ""
          read -p "Push with --force-with-lease? (y/n): " -n 1 -r
          echo ""

          if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${BLUE}→ Pushing $saved_branch...${NC}"
            if git push --force-with-lease; then
              echo -e "${GREEN}✓ Pushed successfully${NC}"
            else
              echo -e "${RED}✗ Push failed${NC}"
              echo "You may need to push manually later"
            fi
          else
            echo -e "${YELLOW}⊘ Skipping push (you'll need to push manually)${NC}"
          fi
          echo ""
        fi
      fi

      # Move to next branch in chain
      CURRENT_INDEX=$((CURRENT_INDEX + 1))
    fi
  fi
else
  # Build the rebase chain
  echo -e "${BLUE}Building rebase chain...${NC}"
  CHAIN=()
  while IFS= read -r branch; do
    [[ -n "$branch" ]] && CHAIN+=("$branch")
  done < <(build_chain "$current_branch")
  CURRENT_INDEX=0

  if [[ ${#CHAIN[@]} -eq 0 ]]; then
    echo -e "${RED}Error: Could not build rebase chain${NC}"
    exit 1
  fi

  echo -e "${GREEN}Found ${#CHAIN[@]} branch(es) to process:${NC}"

  # Identify base branch(es) (branches with 'main' as parent)
  base_branches=()
  for branch in "${CHAIN[@]}"; do
    parent=$(get_parent "$branch")
    if [[ "$parent" == "main" ]]; then
      base_branches+=("$branch")
    fi
    if [[ -n "$parent" ]]; then
      echo -e "  ${YELLOW}→${NC} $branch ${BLUE}(parent: $parent)${NC}"
    else
      echo -e "  ${YELLOW}→${NC} $branch ${RED}(no parent found)${NC}"
    fi
  done
  echo ""

  # By default, skip base branches (don't rebase onto main)
  if [[ "$REBASE_FROM_MAIN" == false ]] && [[ ${#base_branches[@]} -gt 0 ]]; then
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  Skipping Base Branch${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    for base in "${base_branches[@]}"; do
      echo -e "${CYAN}Skipping:${NC} $base ${BLUE}(parent: main)${NC}"
    done
    echo ""
    echo -e "${BLUE}This is a restack operation - we'll propagate changes from${NC}"
    echo -e "${BLUE}the base branch to its children without rebasing onto main.${NC}"
    echo ""
    echo -e "${BLUE}To include rebasing the base branch onto main, use:${NC}"
    echo -e "  ${GREEN}tmp/gh-stack-sync --rebase${NC}"
    echo ""

    # Filter out base branches from the chain
    filtered_chain=()
    for branch in "${CHAIN[@]}"; do
      is_base=false
      for base in "${base_branches[@]}"; do
        if [[ "$branch" == "$base" ]]; then
          is_base=true
          break
        fi
      done
      if [[ "$is_base" == false ]]; then
        filtered_chain+=("$branch")
      fi
    done
    CHAIN=("${filtered_chain[@]}")

    if [[ ${#CHAIN[@]} -eq 0 ]]; then
      echo -e "${YELLOW}No branches to process after skipping base branches${NC}"
      echo ""
      echo "Either:"
      echo -e "  1. Run from a child branch (e.g., PR2)"
      echo -e "  2. Use ${GREEN}--rebase${NC} to include rebasing base onto main"
      exit 0
    fi

    echo -e "${GREEN}Processing ${#CHAIN[@]} branch(es):${NC}"
    for branch in "${CHAIN[@]}"; do
      parent=$(get_parent "$branch")
      echo -e "  ${YELLOW}→${NC} $branch ${BLUE}(parent: $parent)${NC}"
    done
    echo ""
  fi

  # Create temporary tags for stable base references
  # This ensures we can precisely identify which commits belong to each PR
  echo -e "${BLUE}Creating temporary base tags...${NC}"
  for branch in "${CHAIN[@]}"; do
    parent=$(get_parent "$branch")
    if [[ -n "$parent" ]]; then
      # Tag the current position of the parent (where this branch diverged)
      merge_base=$(git merge-base "$branch" "$parent" 2>/dev/null || echo "")
      if [[ -n "$merge_base" ]]; then
        tag_name="stack-sync-base-$(echo "$branch" | sed 's/[^a-zA-Z0-9-]/_/g')"
        git tag -f "$tag_name" "$merge_base" > /dev/null 2>&1
        echo -e "  ${GREEN}✓${NC} Tagged base for $branch: ${CYAN}$tag_name${NC} (${merge_base:0:8})"
      fi
    fi
  done
  echo ""
fi

# Process each branch in the chain
while [[ $CURRENT_INDEX -lt ${#CHAIN[@]} ]]; do
  branch="${CHAIN[$CURRENT_INDEX]}"
  parent=$(get_parent "$branch")

  if [[ -z "$parent" ]]; then
    echo -e "${YELLOW}⚠ Skipping $branch (no parent defined)${NC}"
    CURRENT_INDEX=$((CURRENT_INDEX + 1))
    continue
  fi

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}Branch:${NC}  $branch"
  echo -e "${BLUE}Parent:${NC}  $parent"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Check if already up to date
  current_commit=$(git rev-parse "$branch" 2>/dev/null || echo "")
  parent_commit=$(git rev-parse "$parent" 2>/dev/null || echo "")

  if [[ -z "$parent_commit" ]]; then
    echo -e "${RED}Error: Parent branch '$parent' not found${NC}"
    echo "Please fetch or create the parent branch first"
    exit 1
  fi

  # Check if branch is ancestor of parent (already up to date)
  if git merge-base --is-ancestor "$parent" "$branch" 2>/dev/null; then
    echo -e "${GREEN}✓ Already up to date with parent${NC}"
    echo ""
    CURRENT_INDEX=$((CURRENT_INDEX + 1))
    continue
  fi

  # Prompt for rebase
  if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}[DRY RUN]${NC} Would rebase $branch onto $parent"
    CURRENT_INDEX=$((CURRENT_INDEX + 1))
    continue
  fi

  read -p "Rebase $branch onto $parent? (y/n): " -n 1 -r
  echo ""

  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}⊘ Skipping rebase${NC}"
    echo ""
    CURRENT_INDEX=$((CURRENT_INDEX + 1))
    continue
  fi

  # Checkout the branch
  echo -e "${BLUE}→ Checking out $branch...${NC}"
  git checkout "$branch" || {
    echo -e "${RED}Error: Could not checkout $branch${NC}"
    exit 1
  }

  # Save state before rebase
  save_state "$CURRENT_INDEX" "${CHAIN[@]}"

  # Use the temporary tag as the stable base reference
  # This tag was created before any rebasing, so it marks exactly where this branch diverged
  tag_name="stack-sync-base-$(echo "$branch" | sed 's/[^a-zA-Z0-9-]/_/g')"

  if git rev-parse --verify "$tag_name" > /dev/null 2>&1; then
    tagged_base=$(git rev-parse "$tag_name")
    echo -e "${BLUE}Using tagged base: ${CYAN}$tag_name${NC} (${tagged_base:0:8})"

    # Show diagnostic comparison if verbose
    if [[ "$VERBOSE" == true ]]; then
      current_merge_base=$(git merge-base "$branch" "$parent" 2>/dev/null || echo "")
      echo ""
      echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo -e "${YELLOW}  Diagnostic: Tag vs Merge-Base Comparison${NC}"
      echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo -e "${CYAN}Tagged base (stable):${NC}  ${tagged_base:0:8}"
      if [[ -n "$current_merge_base" ]]; then
        echo -e "${CYAN}Current merge-base:${NC}    ${current_merge_base:0:8}"
        if [[ "$tagged_base" == "$current_merge_base" ]]; then
          echo -e "${GREEN}✓ Same${NC} - Parent hasn't been updated"
        else
          echo -e "${YELLOW}⚠ Different${NC} - Parent was rebased (tag protects us!)"
          echo ""
          echo -e "${BLUE}Old approach would have used:${NC} $current_merge_base"
          echo -e "${BLUE}But we're using the tag:${NC}     $tagged_base"
          echo ""
          echo -e "${GREEN}This ensures we only move THIS branch's commits,${NC}"
          echo -e "${GREEN}not including commits from parent's rebase.${NC}"
        fi
      else
        echo -e "${RED}Could not calculate current merge-base${NC}"
      fi
      echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo ""
    fi

    rebase_cmd="git rebase --onto \"$parent\" \"$tag_name\" \"$branch\""
  else
    # Fallback to merge-base if tag doesn't exist (shouldn't happen)
    echo -e "${YELLOW}⚠ Tag not found, calculating merge-base...${NC}"
    old_base=$(git merge-base "$branch" "$parent" 2>/dev/null || echo "")

    if [[ -z "$old_base" ]]; then
      echo -e "${YELLOW}⚠ Could not find merge-base, using simple rebase${NC}"
      rebase_cmd="git rebase \"$parent\""
    else
      echo -e "${BLUE}Found merge-base: ${old_base:0:8}${NC}"
      rebase_cmd="git rebase --onto \"$parent\" \"$old_base\" \"$branch\""
    fi
  fi

  # Perform rebase
  echo -e "${BLUE}→ Rebasing onto $parent...${NC}"
  echo -e "${BLUE}   Command: $rebase_cmd${NC}"
  if [[ "$VERBOSE" == true ]]; then
    echo -e "${CYAN}   Moving commits: ${tagged_base:0:8}..${branch}${NC}"
    commit_count=$(git rev-list --count "${tagged_base}..${branch}" 2>/dev/null || echo "?")
    echo -e "${CYAN}   Commit count: $commit_count${NC}"
  else
    echo -e "${CYAN}   This will move ONLY commits after $tag_name${NC}"
  fi

  if eval "$rebase_cmd"; then
    echo -e "${GREEN}✓ Rebase successful${NC}"
    echo ""
    rebased_branches+=("$branch")

    # Remove state file on success
    rm -f "$STATE_FILE"

    # Check if branch needs to be pushed (do this immediately so we don't lose track)
    if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      local_sha=$(git rev-parse "$branch")
      remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || echo "")

      if [[ "$local_sha" != "$remote_sha" ]]; then
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${BLUE}  Push Rebased Branch?${NC}"
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "${BLUE}Branch:${NC} $branch"
        echo -e "${YELLOW}⚠ Branch is out of sync with remote${NC}"
        echo -e "  Local:  ${local_sha:0:8}"
        echo -e "  Remote: ${remote_sha:0:8}"
        echo ""
        read -p "Push with --force-with-lease? (y/n): " -n 1 -r
        echo ""

        if [[ $REPLY =~ ^[Yy]$ ]]; then
          echo -e "${BLUE}→ Pushing $branch...${NC}"
          if git push --force-with-lease; then
            echo -e "${GREEN}✓ Pushed successfully${NC}"
          else
            echo -e "${RED}✗ Push failed${NC}"
            echo "You may need to push manually later"
          fi
        else
          echo -e "${YELLOW}⊘ Skipping push (you'll need to push manually)${NC}"
        fi
        echo ""
      fi
    fi

    CURRENT_INDEX=$((CURRENT_INDEX + 1))
  else
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  Rebase Conflict${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${YELLOW}Conflicts detected during rebase.${NC}"
    echo ""
    echo "Please resolve the conflicts, then:"
    echo -e "  ${GREEN}git rebase --continue${NC}"
    echo -e "  ${GREEN}tmp/gh-stack-sync --resume${NC}"
    echo ""
    echo "Or abort the rebase:"
    echo -e "  ${RED}git rebase --abort${NC}"
    echo ""
    exit 1
  fi
done

# Clean up state file
rm -f "$STATE_FILE"

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  All Rebases Complete${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [[ ${#rebased_branches[@]} -eq 0 ]]; then
  echo -e "${YELLOW}No branches were rebased${NC}"
  exit 0
fi

echo -e "${GREEN}Rebased branches:${NC}"
for branch in "${rebased_branches[@]}"; do
  echo -e "  ${GREEN}✓${NC} $branch"
done
echo ""

# Prompt for pushing
if [[ "$DRY_RUN" == true ]]; then
  echo -e "${YELLOW}[DRY RUN]${NC} Would prompt to push branches"
  exit 0
fi

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Push Updated Branches?${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

for branch in "${rebased_branches[@]}"; do
  echo -e "${BLUE}Branch:${NC} $branch"

  # Check if branch exists on remote and is out of sync
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    local_sha=$(git rev-parse "$branch")
    remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || echo "")

    if [[ "$local_sha" != "$remote_sha" ]]; then
      echo -e "${YELLOW}⚠ Branch is out of sync with remote${NC}"
      echo -e "  Local:  ${local_sha:0:8}"
      echo -e "  Remote: ${remote_sha:0:8}"
    else
      echo -e "${GREEN}✓ Already in sync with remote${NC}"
      echo ""
      continue
    fi
  else
    echo -e "${YELLOW}⚠ Branch not yet pushed to remote${NC}"
  fi

  read -p "Push with --force-with-lease? (y/n): " -n 1 -r
  echo ""

  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}→ Pushing $branch...${NC}"
    git checkout "$branch"
    git push --force-with-lease
    echo -e "${GREEN}✓ Pushed successfully${NC}"
  else
    echo -e "${YELLOW}⊘ Skipping push${NC}"
  fi
  echo ""
done

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Stack Sync Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
