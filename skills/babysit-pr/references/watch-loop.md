# The Watch Loop

Copy-paste poll scripts for the `Monitor` tool. All of them assume `$pr`, `$owner`, and `$repo`
are resolved (SKILL.md Step 0) and that `gh auth status` is healthy.

> Poll remote APIs at 30s or slower. A tighter interval buys nothing and burns rate limit.

## 1. Round watch — CI + CodeRabbit in one monitor

Emits one line per check that reaches a terminal state, one line when CodeRabbit finishes, and
exits when both are done. Arm it with `Monitor`, `persistent: true`.

```bash
prev=""; rabbit_done=0; ci_done=0; empty_polls=0; rabbit_polls=0; rounds=0
head_sha=$(gh pr view "$pr" --json headRefOid --jq '.headRefOid')

while [ $rounds -lt 120 ]; do
  rounds=$((rounds + 1))

  # A new push restarts everything — reset the seen-state and re-wait.
  now_sha=$(gh pr view "$pr" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "$head_sha")
  if [ "$now_sha" != "$head_sha" ]; then
    echo "push detected: ${now_sha:0:7} — checks restarting"
    head_sha="$now_sha"; prev=""; rabbit_done=0; ci_done=0; empty_polls=0; rabbit_polls=0
  fi

  # `gh pr checks` exits 1 and prints nothing when a repo has no checks at all.
  checks=$(gh pr checks "$pr" --json name,bucket 2>/dev/null) || checks=""
  [ -n "$checks" ] || checks='[]'
  n=$(jq 'length' <<<"$checks" 2>/dev/null || echo 0)

  if [ "$n" -eq 0 ]; then
    empty_polls=$((empty_polls + 1))
    # ~2 min of nothing means this PR genuinely has no CI. Do not wait forever.
    if [ "$empty_polls" -ge 4 ] && [ "$ci_done" -eq 0 ]; then
      echo "ci: no checks configured for this PR — not waiting on CI"
      ci_done=1
    fi
  else
    empty_polls=0
    # Every terminal check, not just failures — silence must not look like success.
    cur=$(jq -r '.[] | select(.bucket != "pending") | "\(.bucket)\t\(.name)"' <<<"$checks" | sort)
    comm -13 <(printf '%s\n' "$prev") <(printf '%s\n' "$cur") | sed '/^$/d'
    prev="$cur"
    if jq -e 'all(.[]; .bucket != "pending")' <<<"$checks" >/dev/null 2>&1; then ci_done=1; else ci_done=0; fi
  fi

  # CodeRabbit posts its own status check. Prefer it; fall back to the banner.
  if [ "$rabbit_done" -eq 0 ]; then
    rb=$(jq -r '[.[] | select(.name | test("code ?rabbit"; "i"))] | .[0].bucket // ""' <<<"$checks")
    if [ -n "$rb" ] && [ "$rb" != "pending" ]; then
      echo "coderabbit: review complete ($rb)"
      rabbit_done=1
    else
      bodies=$(gh pr view "$pr" --json comments,reviews --jq '
        [ (.comments[]?, .reviews[]?)
          | select(.author.login // "" | test("coderabbit"))
          | .body // empty ]' 2>/dev/null || echo '[]')
      seen=$(jq 'length' <<<"$bodies" 2>/dev/null || echo 0)
      working=$(jq '[.[] | select(test("Come back again in a few minutes"))] | length' <<<"$bodies" 2>/dev/null || echo 0)
      if [ "$seen" -gt 0 ] && [ "$working" -eq 0 ]; then
        echo "coderabbit: review complete"
        rabbit_done=1
      elif [ -z "$rb" ] && [ "$seen" -eq 0 ]; then
        rabbit_polls=$((rabbit_polls + 1))
        # ~3 min with no check and no comment means the bot is not on this repo.
        if [ "$rabbit_polls" -ge 6 ]; then
          echo "coderabbit: not enabled on this PR — skipping the review half"
          rabbit_done=1
        fi
      fi
    fi
  fi

  [ "$ci_done" -eq 1 ] && [ "$rabbit_done" -eq 1 ] && { echo "watch: CI terminal + review complete"; break; }
  sleep 30
done

if [ $rounds -ge 120 ]; then echo "watch: gave up after 60 minutes"; fi
exit 0   # keep the last test off the exit code — Monitor reports it as a failure
```

`bucket` values from `gh pr checks`: `pass`, `fail`, `pending`, `skipping`, `cancel`. Anything
that is not `pending` is terminal and gets emitted.

Two cases that will hang the loop if you drop the counters, both confirmed against real repos:

- **No CI at all** (`bennyhodl/dlcdevkit`): `gh pr checks` exits 1 with empty output, so a naive
  `length > 0` predicate never becomes true.
- **No CodeRabbit** on the repo: the banner never appears, so a banner-only check waits forever.

`empty_polls` and `rabbit_polls` bound both.

## 2. Pull the failing logs

```bash
gh pr checks "$pr" --json name,bucket,link --jq '.[] | select(.bucket=="fail")'

# run id from the check link, or the newest run on the branch:
run_id=$(gh run list --branch "$branch" --limit 1 --json databaseId --jq '.[0].databaseId')

gh run view "$run_id" --log-failed
gh run view "$run_id" --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {name, steps: [.steps[] | select(.conclusion=="failure") | .name]}'
```

`--log-failed` is the one to read first — it skips every passing step.

## 3. Re-run a flake

No code change. Use this only for infrastructure failures (see `fix-policy.md`).

```bash
gh run rerun "$run_id" --failed
```

Re-running the same job twice without a code change and getting the same failure means it is
**not** a flake. Stop and treat it as a real break.

## 4. Is the base still clean?

Run this before every fix round. A moved base makes your local reproduction meaningless.

```bash
git fetch origin --quiet
base=$(gh pr view "$pr" --json baseRefName --jq '.baseRefName')
git merge-base --is-ancestor "origin/$base" HEAD && echo "base clean" || echo "base moved — rebase needed"
```

`base moved` → stop the loop and hand off to `safe-rebase`.

## 5. Confirm the push landed

The guardrail allows a push of the current branch to origin. Confirm it actually arrived before
you go back to waiting:

```bash
git rev-parse HEAD
gh pr view "$pr" --json headRefOid --jq '.headRefOid'
```

Same sha → the push landed and CI is about to restart. Different → the push was refused or
rejected; report it and give the user the command.

## 6. Final state

```bash
gh pr checks "$pr"
gh pr view "$pr" --json mergeable,mergeStateStatus --jq '{mergeable, state: .mergeStateStatus}'
```

Unresolved thread count (fetch query lives in `pr-review-triage/references/github-primitives.md`):

```bash
gh api graphql -F owner="$owner" -F repo="$repo" -F pr="$pr" -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) { nodes { isResolved } }
      }
    }
  }' --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length'
```
