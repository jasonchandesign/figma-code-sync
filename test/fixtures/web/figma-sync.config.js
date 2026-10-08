module.exports = {
  tokens: { adapter: 'css-tailwind4', source: 'src/theme.css', out: 'design/tokens.json', options: { figmaFonts: { 'Inter Variable': 'Inter' } } },
  paths: { map: 'design/component-map.json', snapshot: 'design/figma-components.json' },
  code: { declPattern: String.raw`export\s+(?:default\s+)?(?:const|function|class)\s+{sym}\b` },
  usage: { roots: ['src'], extensions: ['.jsx'], pattern: String.raw`<{sym}[\s/>.]` },
};
