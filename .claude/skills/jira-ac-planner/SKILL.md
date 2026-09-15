---
name: jira-ac-planner
description: Use this skill when the user gives a Jira ticket key or URL and wants help figuring out how to satisfy it — e.g. "read WWW-15390 and tell me how to satisfy the AC", "what do I need to do for this ticket", "break down the acceptance criteria for DI-123", "plan out APITEST-42". Fetches the ticket via the Jira MCP connector, extracts acceptance criteria, maps each one to concrete files/changes in the current repo, and produces a review checklist. Planning only — does not write code.
---

# Jira acceptance-criteria planner

Turns a Jira ticket into a concrete, per-criterion implementation plan the user can review before any code is written. This skill only plans — it never edits files. If the user wants to proceed to implementation afterward, that's a separate step (use plan mode if the change is non-trivial).

## 1. Resolve the ticket key

Accept whatever the user gave you:
- A bare key (`WWW-15390`, `DI-42`, `APITEST-7`)
- A full Jira URL — extract the key from the path
- Nothing but context ("this ticket", "the one we're on") — check the current git branch name (branch naming convention in this repo is the ticket key, e.g. `WWW-15390-...`) or ask the user directly if it's genuinely ambiguous

## 2. Fetch the ticket

Use the Atlassian Rovo MCP tools (search `ToolSearch` for `select:mcp__claude_ai_Atlassian_Rovo__getJiraIssue,mcp__claude_ai_Atlassian_Rovo__getAccessibleAtlassianResources` if not already loaded):

1. `getAccessibleAtlassianResources` to get the `cloudId` (skip if you already resolved one this session).
2. `getJiraIssue(cloudId, issueKey)` — pull `summary`, `description`, `status`, `issuetype`.

Acceptance criteria usually live in one of these places — check in order:
- A section in the description body under a heading like "Acceptance Criteria", "AC", or "Definition of Done"
- A dedicated custom field (if the description has no such section, call `getJiraIssueTypeMetaWithFields` to check for an AC-shaped custom field on this issue type)
- If truly absent, say so explicitly rather than inventing criteria — ask the user or work from the summary/description as a single implicit criterion.

Parse the criteria into a numbered list, preserving the ticket's own wording. Don't paraphrase away specifics (numbers, thresholds, named components) — those are often load-bearing.

## 3. Map each criterion to the codebase

For each acceptance criterion, work out:
- **What part of the codebase it touches.** If a project `CLAUDE.md` exists with a quick-reference table (task → files), consult that FIRST before grepping — it's there to save exactly this lookup. Otherwise use `Explore` (or a couple of targeted greps) to find the relevant files.
- **What the change actually is.** Be concrete: which file, which function/component, roughly what the diff should do. Not "update the header" — "add a `dnssSignal` field to the payload built in `components/services/third-parties/onetrust.ts`'s `pushToBlueConic()`".
- **Whether it looks already satisfied.** Sometimes part of the AC is already true in the current code — say so and cite the file/line, don't propose redundant work.
- **Open questions.** Flag anything the ticket leaves ambiguous (which env var, which user state, which page types) rather than silently guessing — surface it instead of picking one and hoping.

Use a subagent (`Explore`, or `general-purpose` if it needs judgment) for the codebase mapping when the ticket touches multiple unrelated areas — run them in parallel per criterion rather than serially grepping yourself.

## 4. Output format

Present as a checklist, one entry per acceptance criterion:

```
## AC 1: <verbatim criterion text>
- Status: not started | partially satisfied | already satisfied
- Files: path/to/file.ts, path/to/other.tsx
- Plan: <2-4 sentences, concrete>
- Open questions: <if any>
```

Close with a one-line overall summary (e.g. "3 of 5 criteria need new code, 1 is already satisfied by X, 1 needs clarification on Y before starting").

## Rules

- Do not start implementing. This skill's job ends at the plan.
- Do not invent acceptance criteria that aren't in the ticket — if the ticket is vague, say what's missing rather than filling gaps with assumptions.
- If the ticket references another ticket (blocked-by, sub-task of, duplicates), only pull it in if it changes what the plan should say — don't pad the output with irrelevant ticket graph trivia.
- Respect any project-level `CLAUDE.md` conventions (git rules, file locations, stack) when describing *how* to satisfy a criterion — a technically-correct plan that ignores the repo's own rules (e.g. writing new SCSS where Tailwind is mandated) is not a good plan.
