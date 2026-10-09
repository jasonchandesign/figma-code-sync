# FAQ

**Why not Code Connect?** It's an Organization/Enterprise feature, and it maps
components to *snippets*. This maps them to a *contract* that is checked in
both directions. The two could coexist.

**Why not Tokens Studio?** It's a fine way to *author* tokens in Figma. This is
about *gating* drift between whatever the truth is and both sides.

**Can Figma be the token truth?** Not directly yet. The `design-audit` skill's
"pull token drift" writes Figma's values back into your truth file, so Figma
can *originate* a change, but the repo stays canonical. Icons can be
Figma-owned: Seesay draws its icons in Figma and generates the code from them.
That pipeline isn't packaged yet.

**Does Claude have to be involved?** No. The CLI, the hooks and CI work alone.
Claude (or a person with the Figma plugin API) is only needed to *write* to
Figma and to audit variable values.

**Is my Figma token safe?** It's read only from `FIGMA_TOKEN` or `~/.figma-token`,
sent only to `api.figma.com` as `X-Figma-Token`, and needs only read scopes.
Never commit it.

---

*Part of [figma-code-sync](../README.md).*
