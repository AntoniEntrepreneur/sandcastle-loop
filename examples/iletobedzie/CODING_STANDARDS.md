# Coding standards

Triggered pointers into this repo's real standards — the rules live in the linked docs, not here. Read a doc when its trigger fires. Paths are repo-root-relative; the reviewer runs from the repo root.

## Style

- Python formatting belongs to black: reformat with `uv run black backend scripts tests`, and let `pyproject.toml` own the version settings.
- TypeScript: no `any`, no unchecked casts.
- Wire shapes: `backend/models.py` (Pydantic) is mirrored by `frontend/lib/session/types.ts` and `frontend/lib/types.ts`. A changed field updates both; JSON field names are stable wire format.

## Docstrings and comments

`docs/agents/documentation.md` whenever the diff adds or edits a module, class, function, test, comment, or prose doc — TypeScript included.

Its Docstrings, Comments and Tests sections are the specification. `make lint` only catches `Args:`/`Returns:` sections, so the one-line-docstring rule, the why-not-what comment rule, and the Polish-one-liner exemption for problem generators are all the reviewer's to enforce.

## Architecture

- `docs/adr/0002-backend-owns-game-rules.md` when the diff has React or TypeScript computing grading, Streak, XP, Flawless, input mode, or Locked vs Reachable. Mapping server-computed fields into UI is fine; re-deriving an outcome is a leak.
- `backend/AGENTS.md` when the diff adds or moves a backend module, import, or problem generator — it points on to the layer, import, submission-cycle and geometry rules.
- `frontend/AGENTS.md` when the diff touches pages, `lib/`, or frontend tests. `lib/session/client.ts` is the test seam; tests inject the fake beneath it, and no second fake is added.
- `docs/adr/` when the diff changes a rule in an area an ADR already owns. If the change contradicts one, surface the contradiction instead of silently overriding it — `docs/agents/domain.md`.

## Domain language

`GLOSSARY.md` when the diff introduces or renames a concept, type, function, or test name: use the glossary term and check that entry's `_Avoid_` line. Code, names and glossary are English; student-facing copy is Polish — `docs/adr/0001-english-code-polish-ui.md`.
