# Reference: config, component map, snapshot

## Configuration reference

`figma-sync.config.js` sits at the repo root. Commands find it by walking up from the current directory.

```js
module.exports = {
  // root: '.',                       // optional; paths below are relative to it

  tokens: {
    adapter: 'css-tailwind4',         // 'css-tailwind4' | 'swift' | './path/to/your-adapter.js'
    source: 'src/index.css',          // the truth
    out: 'design/tokens.json',        // what is generated
    options: { /* adapter-specific, see adapters.md */ },
  },

  paths: {
    map: 'design/component-map.json',
    snapshot: 'design/figma-components.json',
  },

  code: {
    // A map entry's symbol (or code.export) must match one of these in code.file.
    // {sym} is replaced with the escaped symbol. Either one pattern…
    declPattern: String.raw`export\s+(?:default\s+)?(?:const|function|class)\s+{sym}\b|export\s*\{[^}]*\b{sym}\b`,
    // …or one per entry `kind`, with an optional `default`:
    // declPatterns: { view: String.raw`^\s*struct\s+{sym}\b`, default: … },
  },

  usage: {                            // how call sites are counted for the snapshot gate
    roots: ['src'],
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    ignore: ['__tests__', 'stories'], // directory names to skip, anywhere in the tree
    pattern: String.raw`<{sym}[\s/>.]`,     // each match is one use
    // declPattern: String.raw`^\s*struct\s+{sym}\b`, // optional; matches are subtracted
  },
};
```

## Component map reference

```jsonc
{
  "components": [
    {
      "id": "Button",                                   // stable id for messages; usually the symbol
      "figma": { "component": "Button" },               // or { "components": ["A", "B"] }, or null + "pending"
      "pending": "what Figma owes",                     // only with figma: null
      "code": {
        "symbol": "Button",                             // = the Figma name (name identity)
        "export": "ButtonRoot",                         // only if the export binding differs
        "file": "src/components/ui/button.tsx",
        "kind": "component",                            // selects code.declPatterns[kind]
        "pending": "what code owes"                     // design-first: Library has it, code doesn't yet
      },
      "composite": false,                               // true = deliberately not in the code roster
      "axes": {
        "Variant": {
          "prop": "variant",                            // ties the axis to a prop the roster can verify
          "values": {
            "default": "default",                       // Figma value → code value
            "Hover": { "nonApi": true }                 // Figma-only preview state
          }
        }
      },
      "properties": {
        "Label": { "type": "TEXT", "code": "children" },                // Figma property → where it lands in code; `type` is informational
        "Badge": { "code": "badge", "figma": false }    // code-only: not expected in Figma
      },
      "slots": { "Content": { "accepts": ["Item"] } },
      "allowRaw": ["rounded-full: 9999"],               // raw values the audit should accept
      "notes": "free text"
    }
  ],
  "icons": {
    "figma": { "prefix": "Icon/" },                     // one component per icon (recommended)…
    // "figma": { "component": "Icon", "axis": "Name" }, // …or one set with a Name axis
    "values": { "plus": "plus", "close": "xmark" }      // Figma icon name → code icon key
  }
}
```

Maps written for the original Swift tooling use `"swift": { … }` instead of
`"code": { … }`. Both are read identically, including `swift.pending`.

## Snapshot reference

```jsonc
{
  "fileKey": "…",            // the published Library: required for `snapshot`
  "productFileKey": "…",     // informational; the Product file isn't gated
  "hashVersion": "js2",      // fingerprint format, written by `snapshot`
  "capturedAt": "2026-…",
  "pages": {}, "productScreens": {},   // free-form, preserved across refreshes
  "components": [
    {
      "name": "Button", "key": "…", "nodeId": "8:326", "type": "COMPONENT_SET",
      "updatedAt": "…", "page": "Buttons",
      "axes": { "Variant": ["default", "outline"] },
      "properties": { "Label": "TEXT", "Icon": "INSTANCE_SWAP" },
      "shape": { "variants": { "Variant=default, Size=default": { "pad": [0, 12, 0, 12], "gap": 6, "strokes": {}, "unbound": 0, "hash": "…" }, "…": {} }, "unbound": 0, "hash": "…" },   // a standalone COMPONENT has pad/gap/strokes at the top level instead
      "variables": "…", "note": "…"   // agent-written; a refresh never drops them
    }
  ]
}
```

---

*Part of [figma-code-sync](../README.md).*
