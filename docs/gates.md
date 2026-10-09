# The gates: what they reject, and why

Every rejection is meant to say *what* moved and *what to do*. These are the
rules, and why they're the rules.

## `tokens --check`: "`<file>` is stale"

**Rejects:** the committed generated file differs from what the source would generate.

**Why:** a generated file that's also committed is a drift trap. Someone edits the source and forgets to regenerate, and the committed copy silently describes the old design. Equally bad, someone edits the generated file by hand, and the next regeneration erases their change. A byte comparison catches both. The generated file embeds the source's sha256 so a reviewer can see what it came from.

**Note:** line endings are normalised before comparing and hashing, so a Windows checkout with `core.autocrlf=true` doesn't read as stale. (The original Python tooling did, on Windows.)

## `check`: map integrity

| Rejection | Why |
|---|---|
| `code.file does not exist` / `<Symbol> is not exported from <file>` | A map entry pointing at nothing makes every downstream answer wrong, including the gate's count of call sites. Mark it `code.pending` if it's genuinely not built yet. |
| `Figma component "X" is also claimed by Y` | Two code components can't both be the implementation of one Figma component; one of them is lying. |
| `figma is null with no pending note` | A `null` with no explanation is invisible debt. The note forces someone to say what Figma owes, and it's repeated on every run until paid. |
| *(warning)* `awaits a Figma component — …` / `awaits its code — …` | Debt is reported, not blocked. Being one side ahead is normal; *forgetting* that you are isn't. |

## `check`: the code roster (when your test runner supplies it)

| Rejection | Why |
|---|---|
| `X is a code component with no map entry` | A new component can't slip into code without the Library learning about it. This is the gate that forces "add it to Figma" into the same PR. |
| `variant="ghost" exists in code but no Variant value maps to it` | Code supports a variant the Library can't express, so designers will never use it, or will draw it by hand. |
| `Variant maps to variant="x", which Button does not accept` | The Library offers something code can't render. |
| `X is not in the code roster` | A map entry for a component that isn't in your roster. Mark it `"composite": true` if it's deliberately built from roster parts. |

Both directions are checked against **the same arrays your code exports**
(`BUTTON_VARIANTS`, …), so an enumeration is never typed a second time.

## `check`: map ↔ snapshot, both directions

| Rejection | Why |
|---|---|
| `Figma component has no entry in the map` | Something published in the Library has no pairing in code. Either code is missing it, or it shouldn't be in the Library. |
| `<Axis>=<value> is not mapped (add a value or mark it nonApi)` | Every variant a designer can pick must mean something in code. `{ "nonApi": true }` is the explicit escape hatch for Figma-only states such as `Hover` previews. |
| `<TYPE> property "X" has no home in the map` | An exposed Figma property that code doesn't take is a knob that silently does nothing in the implementation. |
| `declares "X" but <component> has no such property in the snapshot` | The map promises a property Figma doesn't have. Mark it `"figma": false` if it's code-only by design. |
| `maps <Axis>=<value> but <component> has no such value in the snapshot` | The reverse of "not mapped": the map (and so the code) relies on a variant Figma never published. |
| `… — did you mean "Button"? Names must match exactly` | A near miss (`button`, `Primary Button`) is the usual half-synced state. The hint names the candidate; the rule stays exact. |
| `no Icon/x in the snapshot` / `Icon/x has no entry in the icons table` | Icons are paired like components, by name, both ways. |

## `snapshot --check`: the published Library moved

This is the gate with the most judgement built in. When the published Library
differs from the snapshot, every divergence is classified:

| | Code calls it (≥ 1 use) | Nothing calls it |
|---|---|---|
| **Additive** (new component, new variant, new property — every existing variant byte-identical) | advisory | advisory |
| **Breaking** (removed; variant or property taken away or retyped; any change inside an existing variant) | **blocks** (with `--block`) | advisory |

**Why "breaking only when called":** a component nobody calls can't break the
product, however much it changed in Figma. One with call sites has already
changed the product's shape. The gate decides that from **evidence**, by
counting call sites, rather than from anyone's assertion, because the assertion
is the part that goes stale. An earlier version counted instances in the Figma
Product file instead. That answers whether the *drawings* use a component, not
whether the *product* does.

**Why additive changes don't block:** adding a variant or property leaves every
existing call site working. They're still reported. And the moment you refresh
the snapshot, `check` will reject any new variant value the map doesn't cover.
So additive changes are caught *at the right time*: when you pull them in, not
when someone else publishes them.

**Why padding and stroke changes count as breaking:** they change what a
consumer's layout has to compensate for, and they're the most common real
change to a component. A designer re-padding a button is precisely the change
that ships unnoticed.

**Why a rename blocks:** Figma identifies components by node, but this contract
identifies them by **name**. A rename is a removal plus an addition, and
removing a component the code calls is breaking. That's deliberate: renames are
rare, and silently following one would break the name-identity rule everywhere
else.

**Why the commit hook warns but CI blocks:** a commit is a checkpoint; a push is
a publication. A divergence found mid-change is usually one you're in the middle
of making, so blocking every commit would just teach people `--no-verify`. CI is
where it has to be resolved.

## Waivers: `Design-drift: <Name>, … — reason`

| Rule | Why |
|---|---|
| The line must **name** every blocking component (case-insensitive, whole word) | The first version accepted any `Design-drift:` line, and it immediately waved through a real divergence in a commit whose message was *explaining the waiver mechanism*. Naming forces the author to look at each one. |
| `IconButton` does not waive `Button` | Whole-word matching, so a similar name can't waive a different component by accident. |
| Partial waivers still block, and say which components aren't covered | Waiving three components shouldn't quietly waive a fourth. |
| The reason stays in git history | Next to the change it waved through, where the next person will look. |

**Caveat:** in CI the waiver is read from `HEAD`'s commit message. On a pull
request the workflow checks out the PR's head commit (not GitHub's merge
commit), so the waiver must be in the **last commit of the PR**. A waiver in an
earlier commit isn't seen. Squash-merge flows are fine, as long as the squash
message keeps the line.

## `--soft`

`--soft` exists for the commit hook and for local gates. A missing token, a
missing `fileKey` or no network shouldn't stop you committing on a plane. It
does **not** swallow HTTP errors: a 403 means your token is wrong or lacks a
scope, and that should be loud. **Don't use `--soft` in CI.** There, a skipped
check would look like a passing one, so the workflow template skips the step
explicitly, with a visible `::warning`, when the secret isn't set.

## Why `check` isn't in your build

`tokens --check` belongs in the build, because it's purely about code.
`check` and `snapshot` compare code against Figma, and **a Figma change must
never break a code build**: a designer publishing the Library at 5pm shouldn't
turn every engineer's local build red. They run in pre-commit, in CI and in
your test suite, where the failure is attributable and the fix is a choice.

## What isn't gated, on purpose

- **Raw values in your UI code** (a hex in a view, a raw font size). Your own linter owns that. Two linters with overlapping rules disagree, and the disagreement becomes its own drift.
- **Visual pixel diffs.** The fingerprint is structural. A changed glyph, a new image fill or a different shadow colour still changes `hash`, but no structural check will say *how* it looks. Pair this with screenshot review.
- **Unpublished Figma work.** It's invisible to the gate by design. Work in progress can't raise false alarms, and only what consumers can actually receive is compared.

---

*Part of [figma-code-sync](../README.md).*
