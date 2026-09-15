# eng-ai-skills

Internal AI skills for Inquirer engineering teams, built for use with [Claude Code](https://claude.ai/code).

## Available Skills

| Skill | Description |
|-------|-------------|
| `/gpp-adtech-test` | Test GPP privacy signal integration on a website — checks CMP state, cookies, and ad partner network requests |
| `/gpp-audit-compare` | Compare GPP string implementations across multiple news sites — CMP provider, opt-out posture, MSPA fields, and cookie architecture |
| `/sophi-health-check` | Run a Sophi 2.0 Phase 1 health check on an Inquirer article — SDK loading, Demeter, consent, decisions/me, dataLayer, Piano, and paywall decision logic |
| `/jira-ac-planner` | Fetch a Jira ticket and map its acceptance criteria to concrete files/changes in the current repo, producing a review checklist (planning only, no code) |

---

## Installation

Skills must be placed in your personal Claude Code skills directory so they are available across all projects.

### 1. Clone this repository

```bash
git clone https://github.com/phillymedia/eng-ai-skills.git ~/eng-ai-skills
```

### 2. Copy skills to your Claude Code skills directory

```bash
cp -r ~/eng-ai-skills/.claude/skills/* ~/.claude/skills/
```

> **Tip:** To stay up to date, re-run the `cp` command after pulling the latest changes, or use symlinks:
> ```bash
> ln -s ~/eng-ai-skills/.claude/skills/gpp-adtech-test ~/.claude/skills/gpp-adtech-test
> ln -s ~/eng-ai-skills/.claude/skills/gpp-audit-compare ~/.claude/skills/gpp-audit-compare
> ```

### 3. Verify installation

Start Claude Code and type `/` — the skills should appear in the autocomplete menu.

---

## Usage

Invoke a skill by typing its name as a slash command in Claude Code:

```
/gpp-adtech-test https://www.inquirer.com
```

```
/gpp-audit-compare https://www.inquirer.com https://www.nytimes.com
```

Arguments are passed directly after the skill name. Each skill's `SKILL.md` documents its expected arguments and behavior.

---

## Structure

```
.claude/skills/
├── gpp-adtech-test/
│   └── SKILL.md
├── gpp-audit-compare/
│   └── SKILL.md
├── sophi-health-check/
│   └── SKILL.md
└── jira-ac-planner/
    └── SKILL.md
```

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter (name, description, allowed tools) followed by instructions for Claude.

---

## Contributing

To add a new skill:

1. Create a directory under `.claude/skills/<skill-name>/`
2. Add a `SKILL.md` with the required frontmatter:
   ```yaml
   ---
   name: your-skill-name
   description: What this skill does and when to use it
   disable-model-invocation: true
   allowed-tools: Bash, Read, Write
   argument-hint: <argument>
   ---
   ```
3. Write the skill instructions in the body of the file
4. Open a PR

For guidance on the SKILL.md format, see the [Claude Code skills documentation](https://docs.anthropic.com/en/docs/claude-code/skills).
