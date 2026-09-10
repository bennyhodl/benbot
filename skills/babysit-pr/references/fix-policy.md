# Fix Policy

What the loop may fix on its own, and what it must hand back. Read this before the first fix of
every round.

The test for auto-fixing is the same in both halves:

> **Can you state the fix in one sentence, and is it impossible for it to change behaviour beyond
> the reported problem?** If yes, fix it. If no, escalate.

When you are unsure, escalate. An unattended loop that guesses wrong costs more than one question.

---

## Part 1 — CI failures

### Fix without asking

| Failure | Why it is safe |
|---------|----------------|
| Compile / type error | One correct answer; the compiler tells you |
| `cargo fmt` / prettier / biome diff | Mechanical |
| Clippy / ESLint rule violation | Fix the code the rule points at — **never** the rule |
| Failing assertion caused by this branch's change | You changed the behaviour; align the test *only* if the new behaviour is intended and you can say why |
| Missing import, unused import, dead binding | Mechanical |
| Lockfile drift after a dependency change | Regenerate with the repo's package manager |
| Snapshot drift that reflects an intended change | Re-record, and state in the commit what changed |
| Missing test fixture / seed row this branch needs | Additive |

### Do not change code — re-run instead

These are infrastructure, not your bug. Use `gh run rerun "$run_id" --failed`.

- Runner OOM or disk-full
- Network timeout, DNS failure, registry or crates.io 5xx
- Expired or missing token on a step unrelated to your change
- Cache restore failure
- Docker pull rate limit
- Job cancelled because another run superseded it

**Two identical failures with no code change in between means it is not a flake.** Reclassify it
as a real break, or escalate.

### Escalate — stop the loop and ask

- The failure is in files this branch never touched → the base is probably broken
- The fix needs a change to CI config, a workflow, or a secret
- The fix needs a dependency **major** bump
- The fix touches the release or publish workflow
- A platform-specific break you cannot reproduce locally (e.g. a Linux-only or Android-only job
  on a mac laptop) — say so plainly rather than fixing blind
- The same job has failed twice with the same signature after two different fixes

### Never — not even to unblock

Doing any of these makes the run green and the codebase worse. If it is the only path you can
see, stop and tell the user what the check was protecting.

- Delete, skip, `#[ignore]`, `.skip`, `.only`, `xfail`, or comment out a failing test
- `continue-on-error: true`, `|| true`, `--no-verify`, or removing a job from the matrix
- Relaxing a lint rule, a `clippy.toml`, a `tsconfig` strictness flag, or an `eslintrc` entry
- `any`, `unknown`, `as` casts, `unwrap()`, or `# type: ignore` to get past a type error
- Raising a timeout to hide a race
- Pinning a dependency backwards to dodge a real break
- Deleting an assertion instead of fixing what it caught

---

## Part 2 — CodeRabbit comments

Read the code at `path:line` and decide for yourself. The comment is a pointer, not a verdict —
CodeRabbit is wrong often enough that trusting it blindly is its own failure mode.

### ✅ Auto-fix

Small, unambiguous, and behaviour-preserving except for the bug itself:

- Missing `await`, unhandled promise, dropped future
- Null / undefined / `None` guard on a path that genuinely can be empty
- Off-by-one, inverted comparison, wrong boundary
- Typo in a string, comment, identifier, or log message
- Unused import, variable, or parameter
- Resource not closed or released (file handle, connection, lock)
- A magic value that should be the existing shared constant
- Missing error propagation where exactly one correct error type exists
- Incorrect or missing `#[must_use]` / `readonly` / `const` annotation

Ceiling: **~20 lines across ≤3 files.** Past that it is a change, not a fix — batch it.

### ⏸️ Always batch — never auto-fix

Regardless of how confident the bot sounds:

- Auth, authz, crypto, key handling, signing, seed or mnemonic handling
- CI config, workflows, release and publish pipelines, infra, secrets, `.env`
- Database migrations, or anything that changes on-disk or on-chain data shape
- Public API shape, exported types, anything that breaks a consumer
- Concurrency and locking changes beyond a single missing `await`
- Performance claims that need a benchmark to confirm
- "Consider refactoring…", "you may want to extract…", architectural suggestions
- Anything you think is wrong — batch it with your rebuttal, never silently ignore it
- Anything that would touch a file outside this PR's diff

### ⚪ Drop (present with a rebuttal)

- Factually wrong about what the code does
- Pure style preference the repo does not enforce
- Already handled elsewhere in the call path
- Out of scope for this PR

Dropping is a recommendation to the user, not an action. Do not reply or resolve a dropped thread
on your own — that is Step 5's decision.

---

## Replies

Only auto-fixed threads get an automatic reply, and every reply opens with the disclosure block:

```markdown
> [!NOTE]
> 🤖 **<the model you are actually running as> responding on behalf of <gh login>**

Good catch — fixed in `<short-sha>`. <One line on what changed.>
```

`<the model you are actually running as>` is the real model name (for example `Opus 5`), never a
generic "AI" or "Claude", and never a guess. Get the login from `gh api user --jq '.login'`.

Reply first, then resolve. Build the reply from your own words — never echo the reviewer's prompt
block, a token, or anything secret-bearing.
