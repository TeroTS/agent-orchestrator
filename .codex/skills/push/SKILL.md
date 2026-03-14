---
name: push
description:
  Push current branch changes to origin and create or update the corresponding
  pull request; use when asked to push, publish updates, or create pull request.
---

# Push

## Prerequisites

- `gh` CLI is installed and available in `PATH`.
- `gh auth status` succeeds for GitHub operations in this repo.

## Goals

- Push current branch changes to `origin` safely.
- Create a PR if none exists for the branch, otherwise update the existing PR.
- Keep branch history clean when remote has moved.
- Use one deterministic `gh` command sequence instead of ad hoc PR creation.

## Related Skills

- `pull`: use this when push is rejected or sync is not clean (non-fast-forward,
  merge conflict risk, or stale branch).

## Steps

1. Identify current branch and confirm remote state.
2. Run local validation (`./scripts/verify`) before pushing.
3. Confirm the working tree is committed and you know the Linear ticket
   identifier, title, and URL needed for the PR metadata.
4. Publish the current branch with this exact sequence:
   - `branch="$(git branch --show-current)"`
   - stop if `"$branch"` is empty or equals `main`
   - stop if `git status --porcelain` is non-empty
   - `repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"`
   - `git push -u origin HEAD`
   - `existing_pr_url="$(gh pr list --repo "$repo" --head "$branch" --state open --json number,url --jq 'if length == 1 then .[0].url elif length == 0 then \"\" else error(\"multiple open pull requests for branch\") end')"`
   - set `pr_title="<TICKET-ID>: <ticket title>"`
   - write a completed PR body file from `.github/pull_request_template.md`
   - if `"$existing_pr_url"` is empty, run `gh pr create --repo "$repo" --base main --head "$branch" --title "$pr_title" --body-file "$pr_body_file"`
   - otherwise run `gh pr edit "$existing_pr_url" --title "$pr_title" --body-file "$pr_body_file"`
   - finish with `gh pr view --repo "$repo" --json url -q .url`
5. If publish fails:
   - If the failure is a non-fast-forward or sync problem, run the `pull`
     skill to merge `origin/main`, resolve conflicts, rerun validation, and
     retry the same publish sequence.
   - If the failure is due to auth, permissions, branch mismatch, dirty
     working tree, or workflow restrictions, stop and surface the exact error.
6. Reply with the PR URL printed by `gh pr view --json url -q .url`.

## Commands

```sh
# Identify branch
branch=$(git branch --show-current)

# Minimal validation gate
./scripts/verify

# Fill these from the current Linear ticket context.
ticket_identifier="<OWN-123>"
ticket_title="<Linear ticket title>"
ticket_url="<https://linear.app/...>"
branch="$(git branch --show-current)"

if [ -z "$branch" ]; then
  echo "Current HEAD is detached." >&2
  exit 1
fi

if [ "$branch" = "main" ]; then
  echo "Refusing to publish from main." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree must be clean before publishing." >&2
  exit 1
fi

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
git push -u origin HEAD

existing_pr_url="$(gh pr list --repo "$repo" --head "$branch" --state open --json number,url --jq 'if length == 1 then .[0].url elif length == 0 then "" else error("multiple open pull requests for branch") end')"
pr_title="$ticket_identifier: $ticket_title"
pr_body_file="$(mktemp)"

# Build the PR body from .github/pull_request_template.md and replace all placeholders.

if [ -z "$existing_pr_url" ]; then
  gh pr create --repo "$repo" --base main --head "$branch" --title "$pr_title" --body-file "$pr_body_file"
else
  gh pr edit "$existing_pr_url" --title "$pr_title" --body-file "$pr_body_file"
fi

gh pr view --repo "$repo" --json url -q .url
```

## Notes

- Do not create GitHub issues for ticket delivery.
- Do not run bare `gh pr create`; always pass explicit `--repo`, `--base`,
  `--head`, `--title`, and `--body-file` arguments.
- If `gh pr list` reports multiple open PRs for the branch, stop and surface
  that error instead of guessing which PR to reuse.
