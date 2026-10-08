// figma-code-sync config — https://github.com/jdaawg812/figma-code-sync
// Truth mode: EMIT. design/tokens.json (DTCG) is the hand-edited source of truth;
// the SwiftUI theme is generated from it. The contract lives in design/WORKFLOW.md.

module.exports = {
  tokens: {
    adapter: 'swift',
    source: 'design/tokens.json',
    out: 'App/Theme+Generated.swift', // ← your app's path
    options: {
      header: 'figma-code-sync tokens',
      regenerate: 'npx figma-code-sync tokens',
    },
  },

  paths: {
    map: 'design/component-map.json',
    snapshot: 'design/figma-components.json',
  },

  code: {
    // Per map-entry `kind` (swift.kind / code.kind).
    declPatterns: {
      view: String.raw`^\s*(struct|final class|class)\s+{sym}\b`,
      buttonStyle: String.raw`^\s*struct\s+{sym}\s*:\s*ButtonStyle`,
      modifier: String.raw`^\s*func\s+{sym}\s*[<(]`,
      composition: String.raw`^\s*(struct|final class|class|func)\s+{sym}\b`,
      default: String.raw`^\s*(struct|final class|class|enum|func)\s+{sym}\b`,
    },
  },

  usage: {
    roots: ['App/UI'], // ← where views call components
    extensions: ['.swift'],
    ignore: ['Debug'],
    pattern: String.raw`\b{sym}\b`,
    // subtracted from the hits: a declaration is not a use
    declPattern: String.raw`^\s*(?:struct|final class|class|enum|func)\s+{sym}\b`,
  },
};
