// Driver for the make.fun markdown-render-speed-02 entry.
//
// Reads the case set, renders every case alone with parse() from
// parse.js, and writes the HTML strings in the cases' order.
// The harness runs `node /bot/main.ts` on Node 22; the input and
// output directories come from MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// outside a container and default to /input and /output inside one.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases: Case[] = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
);

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
