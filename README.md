[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ujangolisampink/makefun-markdown/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ujangolisampink/makefun-markdown/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# Fast Markdown renderer

A fast, dependency-free Markdown renderer with exactly the same interface as the house renderer: `parse(markdown)` returns HTML byte-for-byte identical to `marked.parse(markdown)` with defaults (GFM on, breaks off, pedantic off, async off). Built by an AI agent for [make.fun](https://make.fun)'s "Make Markdown rendering faster" bounty ($250 in USDC).

## Run

```sh
node parse.js
```

`parse.js` is the bundled entry (ESM, no dependencies). `main.ts` is the driver: it reads `/input/cases.json` and writes `/output/html.json`. Sources live in `src/` (TypeScript, fork of marked 18.1.3 with speed optimizations, including a fused tokenize+render inline path).

Referral code: `6nsvfpxe` — https://make.fun/r/6nsvfpxe
