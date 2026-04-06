---
description: Review code quality guidelines and establish session baselines
---

# Start Coding Session

Begin each coding session by grounding yourself in quality standards and understanding the current state of the code.

## 1. Review Code Quality Guidelines

Re-read the coding conventions in CLAUDE.md, specifically:

- **SRP** - One function = one job
- **DRY** - No duplicate logic; extract repeated patterns to shared utilities
- **Self-documenting code** - Clear naming over inline comments
- **Defensive programming** - Validate inputs, handle nulls/edge cases, explicit error handling

## 2. Cross-File DRY Enforcement

The DRY principle applies across the entire codebase, not just within individual files:

- Before creating new helper functions, search for existing utilities that do the same thing
- When you spot duplicate logic across files, extract to a shared utility
- If similar patterns exist in multiple files, consolidate them

## 3. Avoid Fragile Code

Write robust code that won't break under edge cases:

- Validate inputs at function boundaries
- Don't assume array lengths or object properties exist
- Use defensive access patterns (optional chaining, null coalescing where appropriate)
- Prefer explicit error handling over silent failures

## 4. Defer Subjective Decisions

Some decisions have real implications for correctness or behavior. Do not make these unilaterally:

- Threshold values, scoring weights, or classification rules
- Architectural choices with broad impact
- Anything where the right answer depends on product or business context

**Instead:**
1. Identify the decision that needs to be made
2. Present the options with trade-offs
3. Wait for direction before implementing

## 5. Regression Test Baseline (When Appropriate)

For changes that could have side effects:

1. **Identify affected functionality** - What existing features could break?
2. **Run baseline tests** before making changes and note results
3. **Identify integration points** - What other code calls the functions being modified?

**Triggers for baseline testing:**
- Modifying shared utility functions
- Changing data flow or core logic
- Refactoring functions called from multiple places

## Session Checklist

Before starting work, confirm:

- [ ] Understood the task requirements
- [ ] Reviewed relevant existing code
- [ ] Identified potential side effects
- [ ] Identified any subjective decisions that need user input
- [ ] Established test baseline if needed
- [ ] Ready to follow all CLAUDE.md guidelines
