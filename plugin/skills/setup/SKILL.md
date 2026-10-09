---
name: setup
description: Set up figma-code-sync in the current project from any starting state — code only, a published Figma Library only, or both half in step — by driving `figma-code-sync init` and `status --json` until the project is in sync. Use when asked to "set up figma-code-sync", "connect this repo to Figma", "install figma sync", or when a project has no figma-sync.config.js yet.
---

# Set up figma-code-sync

Follow `AGENTS.md` in the figma-code-sync repository (also shipped at
`node_modules/figma-code-sync/AGENTS.md` once installed). The short form:

1. **Install**, if `npx figma-code-sync --help` fails:
   `npm i -D github:jasonchandesign/figma-code-sync#v0.1.0`
2. **Ask the user two things before running anything**: the Library file URL (if a
   Library exists), and whether they have a Figma personal access token saved to
   `~/.figma-token`. If not, tell them how to create one (Figma → Settings →
   Security → Personal access tokens, scopes `file_content:read` and
   `library_content:read`) and to save it there themselves. Never ask them to
   paste it into the chat.
3. **Run the guided init non-interactively** with what you know:
   `npx figma-code-sync init --yes [--library <url>] [--seed|--no-seed]`
   Read each of the nine step lines. Act on `skipped` lines (the table in
   AGENTS.md says what each one needs).
4. **Loop on `npx figma-code-sync status --json`** until `state` is `in-sync`:
   - `code-first`: build the Library (skill `figma-workflow`, "Building the Library"), ask the user to publish, re-run `init --library <url>`.
   - `unseeded`: `init --seed` for design-first, or write map entries for the code's components.
   - `design-first` / `in-step`: build or draw what each pending entry owes, then refresh (`npx figma-code-sync snapshot`).
   - `diverged`: fix each error on the side it names. Names must match exactly.
5. **Wire the roster** in the project's test runner (README → "Using it from your own test runner") so `npm test` guards the map from the code side.
6. **Report** the final `status` output and anything that still needs a human: a token, a publish, a decision about which side is right.

Do not edit generated files, do not waive gates, and do not claim a publish
happened. See AGENTS.md → "Rules you must not work around".
