# Markdown Artifact Contracts

Status: proposed (Task 2). Applies to `knowledge/notes/*.md`, `tasks/<id>/task.md`,
and the optional `tasks/<id>/result.md`. Validation is by **required H2
headings** (case-insensitive), never by line numbers. Extra sections are allowed.

## 1. Knowledge analysis note (`knowledge/notes/n-<slug>.md`)

Required H2 headings, in order:

```
# <Title>
## Scope
## Verified facts
## Interpretation
## Assumptions
## Unknowns
## References
```

- **Scope** — paths/globs covered; must match the `index.json` entry `scope`.
- **Verified facts** — only facts backed by machine facts or direct observation;
  each item references a fact (`#Verified facts` anchor) or a file path.
- **Interpretation** — the Analyzer's reasoning; clearly not raw fact.
- **Assumptions** — explicitly labeled, falsifiable statements.
- **Unknowns** — open gaps; drives future incremental analysis.
- **References** — `path#Heading` anchors only; no line numbers, no large
  excerpts.

Invalid if any required heading is missing, or if a reference does not resolve.

## 2. Task file (`tasks/<id>/task.md`)

Required H2 headings:

```
# Task <T-yyyymmdd-nnn>
## Request
## Scope
## Out of scope
## Acceptance criteria
```

- **Request** — the user's request, verbatim or tightly summarized.
- **Scope / Out of scope** — explicit boundaries (guards against scope creep).
- **Acceptance criteria** — testable statements; each gets an `AC*.n` id when
  mirrored in `plan.json` / `result.json`.

## 3. Result narrative (`tasks/<id>/result.md`, optional)

Required H2 headings (human view; `result.json` remains authoritative):

```
# Result <task-id>
## Summary
## Changes
## Verification
## Limitations
## Follow-ups
```

## 4. Execution manifest (`manifest.md`, optional machine view)

Required H2 headings: `## Tasks` (table), `## Decisions`, `## Blockers`. Table
columns: ID, Source, Status, Depends on, Next action.

## 5. Validation rules (Markdown)

- Missing required heading → artifact `incomplete`.
- Leading `# ` title missing → `invalid`.
- Any `path#Heading` reference that does not resolve → `invalid` for that
  reference (reported, does not crash the validator).
- A note whose `## Scope` disagrees with its index entry → `stale`.
