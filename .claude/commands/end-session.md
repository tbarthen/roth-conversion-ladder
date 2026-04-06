---
description: Validate work, update docs, and commit changes
---

# End Coding Session

Validate all local changes before committing and pushing to the repository.

**Scope**: This applies to ALL uncommitted local changes, regardless of when they were made.

## 1. Review All Local Changes

Run `git status` and `git diff` to identify all modified files.

For each modified code file, examine the diff and verify:

### Code Quality Compliance

- **SRP**: Does each new/modified function do exactly one thing?
- **DRY**: Is there any duplicated logic - within files or across files?
- **Naming**: Are names clear and self-documenting? Any unnecessary inline comments?
- **Defensive programming**: Are inputs validated? Are edge cases handled?
- **Error handling**: Are errors surfaced explicitly, not swallowed silently?

### Fragility Check

- Are there assumptions about data that could fail?
- Could null/undefined values cause crashes?
- Is error handling adequate for failure modes?

### Cross-File Impact

- If shared utilities were modified, are all callers still compatible?
- Were any breaking changes introduced to function signatures?

## 2. Build and Test Validation

Run the project's build and test commands to verify everything passes:

1. Run the build command (if the project has one)
2. Run the test suite (if the project has one)
3. If either fails, fix all errors before proceeding

## 3. Regression Testing (If Applicable)

If the changes involve shared code or core logic:

1. Run relevant tests
2. Compare results to the baseline established at session start
3. Investigate any new failures before proceeding
4. All tests must pass before committing

## 4. Documentation Updates

Review changes and update CLAUDE.md if needed:

- New patterns or architectural decisions worth capturing
- Gotchas or lessons learned
- Changes to how the project is built or deployed
- New key files or components

**Make documentation updates before committing** so they're included in the same commit.

## 5. Violation Resolution

If any guideline violations are found:

1. List each violation with file and line reference
2. Fix each violation before proceeding
3. Re-verify after fixes
4. Do not commit until all violations are resolved

## 6. Commit and Push

Once all checks pass:

1. **Stage changes**: `git add` relevant files
2. **Review staged changes**: `git diff --staged` for final verification
3. **Commit**: Write a clear, descriptive commit message
4. **Push**: `git push`

## Pre-Commit Checklist

- [ ] All code quality guidelines followed (SRP, DRY, naming, defensive programming)
- [ ] No fragile code patterns introduced
- [ ] Cross-file DRY maintained
- [ ] Build passes (if applicable)
- [ ] Tests pass (if applicable)
- [ ] No debugging/logging code left behind
- [ ] CLAUDE.md updated if architectural decisions or gotchas were discovered

## Final Output

Report to user:
1. Summary of all files reviewed
2. Any violations found and how they were resolved
3. Test results (if tests were run)
4. Commit hash and push status
