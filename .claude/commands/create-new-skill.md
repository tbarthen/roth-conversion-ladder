---
description: Create a new Claude Code skill from user specifications
---

# Create New Skill

Guide for creating a new skill (slash command) based on user specifications.

## 1. Gather Requirements

Ask the user for the following information:

### Required
- **Skill name**: The command name (e.g., `review-code`, `run-tests`)
- **Description**: One-line description for the frontmatter (shown in skill list)
- **Purpose**: What should this skill accomplish?

### Optional
- **Steps/Workflow**: Specific steps the skill should follow
- **Checklist items**: Any verification checkboxes to include
- **Output format**: What should be reported to the user at the end?

## 2. Skill File Structure

Create the skill file at: `.claude/commands/<skill-name>.md`

### Required Format

```markdown
---
description: <one-line description for skill list>
---

# <Skill Title>

<Brief overview of what this skill does>

## 1. <First Section>

<Instructions for first major step>

## 2. <Second Section>

<Instructions for second major step>

## <N>. <Final Section>

<Final instructions>

## Checklist (optional)

Before completing, confirm:

- [ ] <Item 1>
- [ ] <Item 2>

## Final Output

Report to user:
1. <What to report>
2. <Additional info>
```

## 3. Writing Guidelines

### Structure
- Use numbered sections (## 1., ## 2.) for sequential steps
- Use bullet points for parallel options or lists
- Include checklists for verification steps
- End with a "Final Output" section describing what to report

### Tone
- Use imperative voice ("Run tests", "Review changes")
- Be specific and actionable
- Reference CLAUDE.md for project-specific context rather than duplicating it

### Length
- Keep instructions concise but complete
- Each section should be self-contained

## 4. Validation

Before saving the new skill:

1. **Name check**: Is the skill name descriptive and kebab-case?
2. **Description check**: Is the frontmatter description under 60 characters?
3. **Completeness check**: Does it cover the user's requirements?
4. **Consistency check**: Does it follow the same patterns as existing skills?

## 5. Create the Skill

1. Write the skill file to `.claude/commands/<skill-name>.md`
2. Confirm the file was created successfully
3. Inform the user they can now use `/<skill-name>` to invoke it

## Final Output

Report to user:
1. Skill file path created
2. Command to invoke: `/<skill-name>`
3. Brief summary of what the skill does
