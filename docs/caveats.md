# Caveats and known limitations

These are honest limitations. Several are Figma's, some are ours.

## Figma

- **Variable values aren't on the REST API below Enterprise.** The snapshot sees components, axes, properties and structure, but not what `color/primary` is set to. Only the `design-audit` skill (through the Figma MCP) compares variable values. **Token drift in Figma isn't caught by CI.** Run the audit before every publish.
- **Only the published Library is visible.** A changed but unpublished component looks unchanged. That's intended (see [what isn't gated](gates.md#what-isnt-gated-on-purpose)), but it means the gate reports what consumers can receive, not what's on the designer's canvas.
- **The Product file isn't gated.** Screens drift from code without any check; the contract only covers the Library. Keep screens built from Library instances, and treat them as illustrations.
- **Publishing is manual, and so is accepting it.** Every Library change needs a human click before anything downstream sees it, and a consuming file keeps stale copies of the components until the update is accepted there too; the `figma-workflow` skill refreshes instances by re-importing their component keys.
- **Plugin API quirks** (they matter if you, or Claude, build components programmatically):
  - Assigning a variable-bound paint can reset its `opacity` to 1. Bind, assign, then reassign a copy with the opacity.
  - Instances can render bound paints at full opacity regardless. Put translucency on the layer: node opacity, or a locked full-size "wash" rectangle.
  - `createFrame()` clips content by default, which shaves shadows. Set `clipsContent = false`.
  - Binding a variable on a nested instance creates an override, even when the value matches the main component. Bind on instances only what they genuinely override.
  - Component descriptions escape `<`, `>` and `"` on write. Keep them out of the `Code:` line.
  - `fetch` isn't available inside `use_figma` scripts. Bulk SVGs (icons) go in through the MCP's `upload_assets`.
- **Per-mode values on a single paint aren't possible.** A component whose code uses a `dark:` override with a different role, or different opacity, can only be drawn with one of them. Bind to roles that resolve per mode instead, so the variable modes do the work.
- **Interaction states** (hover, focus, pressed, disabled) usually aren't drawn as variants in a code-first library, and so aren't gated. If you draw them, map them as `{ "nonApi": true }`.

## This package

- **Call sites are counted with a regex**, not a parser. It counts matches in comments and strings too, and a `pattern` that's too loose (`\bButton\b` also matches `</Button>`) over-counts. Over-counting errs towards blocking, which is the safe direction. Under-counting (a component only used through a re-export alias, or via `React.createElement`) makes a breaking change look advisory. Check your pattern against your codebase.
- **Declarations are matched with a regex too** (`code.declPattern`). Unusual export forms need a pattern that covers them.
- **The map is hand-maintained.** There's no generator; seed it from your own component metadata (Tripeaz does this once from its test runner). The roster check keeps it honest afterwards, but only if your test runner supplies a roster.
- **`check` verifies the Figma side of `properties`, not the code side.** It knows the Figma property `Label` exists and has a home in the map, but not that `children` is really what `Button` renders it from.
- **`css-tailwind4` limits:**
  - **Not resolved:** `hsl()`, `color-mix()`, `lab()`/`lch()`, relative colour syntax, and `calc()` beyond `var(--x) * k`. Any of these in a role is an **error**, not a guess. (shadcn's older Tailwind v3 themes, which store bare `222 84% 5%` HSL triplets, aren't supported.)
  - **Modes by selector only:** modes come from block selectors, not `@media (prefers-color-scheme)` queries. A theme that switches dark mode with a media query instead of a class/selector needs a custom `modes` setup, and may not be expressible.
  - **One stylesheet:** a single stylesheet is read; `@import`ed files aren't followed.
  - **Not tokenised:** shadows (they're Figma effect *styles*, written by Claude from your elevation scale), gradients and motion. Spacing *is*, but only once you declare `--spacing` and list the steps you use. Arbitrary values in code (`p-[3px]`) stay raw by definition; list them in `allowRaw`.
  - **Key order in `tokens.json`:** JSON objects put integer-like keys first, so `spacing` lists `1, 2, 3 … 24` before `0-5, 1-5 …`. Nothing that reads the file depends on the order, and the output is deterministic.
  - **Light-first output:** the first mode is `$value`, and other modes go in `$extensions.modes`. That's a convention, not DTCG standard; DTCG has no multi-mode value yet.
- **`swift` limits:** one mode only (no light/dark per token), four font weights (`regular`, `medium`, `semibold`, `bold`), and semantic colours exactly three levels deep. These are the original generator's rules, kept for byte-compatibility.
- **oklch rounding:** a hex converted to oklch and back can land one 8-bit step away (`#d97706` → `#d97708`). The audit allows ±1 per channel when the source is oklch.
- **A snapshot entry without a fingerprint** (written by hand, by the audit skill's no-token fallback, or by the original Python tool) is compared without it until the next plain `snapshot` fills it in; padding, gap, strokes and the unbound count still gate. **The first `snapshot --check` after migrating from another tool** likewise compares without fingerprints. The hashes aren't comparable across implementations, so padding, gap, strokes and the unbound count still gate, but "internals changed" can't be detected until you run one plain `snapshot` to rewrite them.
- **`--soft` hides network failures** from the hook and local gates. That's by design, but a misconfigured machine can skip the Library check for a long time without anyone noticing. CI shouldn't use it.
- **Hooks are POSIX `sh`.** They work in Git for Windows and in any Unix shell, not in plain `cmd.exe`. The pre-commit hook's path filter is deliberately narrow (`design/`, the config). Widen it to your token source and component directories.
- **Hooks need the executable bit, and Windows can't set it on disk.** Git silently skips a hook that isn't executable, so a hook committed from Windows would do nothing on a macOS or Linux clone. `figma-code-sync hooks` marks both hooks executable in the git index (`git update-index --chmod=+x`) once they're tracked; run it again after the first commit that adds them, or check with `git ls-files -s scripts/githooks` (mode should be `100755`).
- **Not on the npm registry yet.** Install from GitHub and pin a tag. `npx github:…` in CI clones on every run; a devDependency is faster. In a non-Node repo (Swift), add `node_modules/` to `.gitignore`.
- **Not supported yet:** Code Connect (it would complement the map, not replace it), Android/Compose and Flutter adapters, multi-brand modes beyond light/dark, and the Product file.

---

*Part of [figma-code-sync](../README.md).*
