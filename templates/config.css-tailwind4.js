// figma-code-sync config — https://github.com/jasonchandesign/figma-code-sync
// Truth mode: EXTRACT. A Tailwind v4 / shadcn stylesheet is the token source of
// truth; design/tokens.json is generated from it and is what Figma variables are
// written from. The contract lives in design/WORKFLOW.md.

module.exports = {
  tokens: {
    adapter: 'css-tailwind4',
    source: 'src/index.css', // the stylesheet with :root / .dark and @theme inline
    out: 'design/tokens.json',
    options: {
      // Which custom-property blocks feed which Figma mode, in source order.
      modes: {
        light: [':root', ':root, .dark'],
        dark: ['.dark', ':root, .dark'],
      },
      remPx: 16,
      // CSS family → the family name Figma knows it by.
      figmaFonts: { 'Inter Variable': 'Inter' },
      // Publish Tailwind's spacing scale as spacing/* tokens, so Figma padding,
      // gaps and control sizes bind to the same steps p-N / gap-N / size-N use.
      // Requires the base in your stylesheet — Tailwind v4's own default, so
      // declaring it changes nothing on screen:   @theme { --spacing: 0.25rem; }
      spacing: { steps: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24] },
    },
  },

  paths: {
    map: 'design/component-map.json',
    snapshot: 'design/figma-components.json',
  },

  code: {
    // A map entry's code.symbol (or code.export) must be exported from code.file,
    // including `export default React.memo(function X(…` / `forwardRef(function X(…`.
    declPattern: String.raw`export\s+(?:default\s+)?(?:const|function|class|let)\s+{sym}\b|export\s+default\s+{sym}\b|export\s+default\s+(?:React\.)?(?:memo|forwardRef)\(\s*function\s+{sym}\b|export\s*\{[^}]*\b{sym}\b`,
  },

  // Call sites decide whether a Figma divergence can break the product.
  usage: {
    roots: ['src'],
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    ignore: ['__tests__', 'stories'],
    pattern: String.raw`<{sym}[\s/>.]`,
  },
};
