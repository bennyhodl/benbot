---
name: linear-daily
description: >-
  Daily Linear stand-up for Ben. Pull Linear inbox, assigned issues, led projects and yesterday's
  GitHub PRs, show a short brief with urgent items at the top, then ask "what are you working on
  today?" and update Linear from the answer. Use when the user says "linear daily", "triage linear",
  "start my day", "morning stand-up", "what's in linear", "let's go through linear", or opens a
  session with "what am I working on today".
---

# Linear daily

Goal: a two-minute morning brief, then a conversation. Not a checklist to walk through item by
item. Ben decides what he works on. The skill keeps Linear true to that.

## Rules

- **Linear only.** This skill reads Linear and GitHub and writes to Linear. It does not
  create files, branches, commits, documents, PRs or anything outside Linear. If the work
  Ben describes needs code or a document, note it in the Linear issue and stop. Ben starts
  that work himself in a separate session.
- Ask before you create a Linear issue. Ben decides what gets tracked.
- Write in ASD-STE100 Simplified Technical English. Short sentences. Active voice.
- Urgent and High items go to the top. Never bury them.
- Do not list closed, canceled or duplicate issues.
- Do not ask permission for routine status moves that Ben stated. Apply them and report.
- Ask before you cancel or reassign an issue that another person created.
- Linear comments do not need the GitHub NOTE alert. GitHub comments do.

## Identity

- Linear user: `ben@lygos.finance`, display name `benny`, id `f8114373-219d-481e-938a-6b56954a0a7a`
- Team: Technical (`ENG`), id `04c704ef-71a0-4e49-bd9b-4bb760394100`
- GitHub org: `LygosLabs`. Main repos: `orange-grove`, `lygos-app`, `chainlink-oracle`, `dlcd-rs`,
  `infrastructure`, `lygos-deployment`, `kim-replay`, `kimjong`

## Step 1 — Pull (all calls in parallel)

Load tools with `ToolSearch` `select:` first. Then call:

1. `list_issues` `assignee: "me"`, `limit: 100`, fields
   `id,title,priority,status,statusType,project,updatedAt,startedAt,url`
2. `get_notifications` `unreadOnly: true`, `limit: 50`
3. `list_projects` `member: "me"` OR filter the full list to `lead == ben`. Fields
   `id,name,status,targetDate,priority,updatedAt`
4. `list_cycles` `teamId: <ENG id>`, `type: current`
5. `list_issues` `team: Technical`, `state: Triage`, `createdAt: -P1D` (new triage since yesterday)
6. Bash: yesterday's PR activity
   ```bash
   gh search prs --author=@me --org=LygosLabs --updated=">=$(date -d yesterday +%F)" \
     --json repository,number,title,state,isDraft,url,updatedAt --limit 30
   gh search prs --review-requested=@me --org=LygosLabs --state=open \
     --json repository,number,title,url,updatedAt --limit 30
   ```

Filter issues to `statusType` in `triage, backlog, unstarted, started`.

## Step 2 — Brief

Print in this order. Keep each section short. Omit an empty section.

1. **Urgent / High first.** Any of Ben's open issues at priority 1 or 2. Any Urgent Triage issue
   created since yesterday. One line each.
2. **Inbox that waits on Ben.** Only review requests, re-requests, mentions and direct questions.
   Skip approvals and status changes; count them in one line ("N approvals/status changes, safe
   to archive").
3. **In progress / In review.** Ben's `started` issues. Flag any with no update in 14 days as
   stale.
4. **Projects Ben leads.** One line each: name, status, target date (flag if past), count of open
   issues.
5. **Yesterday's PRs.** Merged, opened, or changed. Flag PRs that have no linked Linear issue.
6. **Todo / Backlog count.** One line. Do not list them unless asked.

Then ask: **"What are you working on today?"**

## Step 3 — Update from the answer

Ben talks. Map what he says to Linear changes and apply them at once:

| Ben says | Action |
|---|---|
| "X is done" | `save_issue` state `Done` |
| "X is in review" / "PR is up" | state `In Review`, add PR link via `links` |
| "working on X today" | state `In Progress`, move to current cycle |
| "X is blocked on Y" | `save_comment` with the blocker, keep state |
| "we changed the plan for X" | retitle, `save_comment` with the new scope |
| "that project is done" | `save_project` state `Completed` |
| "not doing X" | ask once if Ben created it; else `Canceled` with a short comment |
| New work with no issue | Ask: "Do you want an issue for this?" Create only on yes |
| "that PR needs a ticket" | create issue, add the PR URL under `links` |

After the changes, print one short table of what changed. Then continue the conversation until
Ben says he is done.

## Step 4 — Yesterday's loose ends

Before the session ends, check:

- A PR merged yesterday whose linked issue is still open → mark `Done`.
- An issue Ben moved to In Progress yesterday with no PR today → ask if it is still active.
- Review requests older than 7 days → ask: review, or tell the author no.

## Weekly (Mondays only)

Add one section: project target dates that are past, and projects with no update in 30 days.
Propose a new date or close.
