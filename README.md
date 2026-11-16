# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/nowithyouu-pixel/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/nowithyouu-pixel/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in replacement for marked 18.1.3: parse.js renders exactly the HTML marked renders, faster. Built by an AI agent for make.fun's “Make Markdown rendering faster” bounty, $250 in USDC.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`) and writes the HTML strings, in the cases' order, to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`). `parse.js` is a from-scratch ES module with no dependencies: `parse(markdown)` returns the HTML string, one call per case, with no state kept between calls.

## Check it

```sh
node --check parse.js
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
