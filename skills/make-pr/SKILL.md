---
name: make-pr
description: Review the branch diff, pick the correct base (origin default, or the parent branch when the work is stacked), write the PR body, and hand back one copy-paste `git push` + `gh pr create` command instead of running it. Use whenever the user wants a PR made or prepared — "make a PR", "open a PR", "PR this up", "give me the gh command", "write a PR body", "push this and PR it" — and also after finishing a chunk of work on a feature branch. The user keeps push guardrails on, so always hand over the command; never push or create the PR yourself.
---

# Make PR

The user runs the push themselves. Your job is everything up to that point: read the
diff, get the base right, and give one command they can paste without editing.

## 1. Commit anything outstanding

Commits are safe to run. Stage the changed files by name (not `git add -A`) and commit
with an imperative `type: description` message. Never mention Claude, Anthropic, or a
co-author — the user's PRs and commits stay unattributed.

## 2. Pick the base branch

```bash
git fetch origin --quiet
DEFAULT=$(git rev-parse --abbrev-ref origin/HEAD | sed 's|origin/||')
CUR=$(git branch --show-current)
# candidate parents: branches whose tip is an ancestor of HEAD
for b in $(git branch --merged HEAD --format='%(refname:short)' | grep -vx "$CUR"); do
  echo "$(git rev-list --count "$b..HEAD") $b"
done | sort -n
```

The nearest branch with a non-zero distance is the stacked parent. Use it as the base
only if it is pushed (`git ls-remote --exit-code --heads origin <branch>`) and still
open — a merged parent means the stack collapsed and the base is `$DEFAULT`. Otherwise
base on `$DEFAULT`. Getting this wrong shows every parent commit in the PR, which is
the main thing this skill exists to prevent.

## 3. Review the real diff

`git --no-pager diff <base>...HEAD ':!*lock.json' ':!*.lock'` — this is what reviewers
see. Read it before writing the body; describe what the code does, not what the commit
messages say.

## 4. Write the body to a temp file

Write the body to `${TMPDIR:-/tmp}/pr-<branch>.md`, with `/` in the branch name replaced
by `-`. Keep it out of the repo — it is a scratch file, not something to commit. Use
this template:

```markdown
## Summary
<1-2 sentences: what changed and why>

## Changes
- <bullet per meaningful change>

## Testing
- <what you ran, or what the reviewer should check>
```

Drop `## Testing` when there is nothing real to put there. For a stacked PR, add a line
under the summary noting it targets the parent branch and merges after it.

## 5. Output

State the base and why (default branch, or stacked on X). Show the body you wrote, so
the user can read it without opening the file. Then give one fenced block that points
at the file — `--body-file` keeps the command short and safe from quoting problems:

```bash
git push -u origin <branch> && gh pr create --base <base> --head <branch> \
  --title "<title>" --body-file /tmp/pr-<branch>.md
```
