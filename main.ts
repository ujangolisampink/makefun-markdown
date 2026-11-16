// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` on Node 22 (type stripping,
// erasable syntax only). It expects this program to read the whole
// case set from /input/cases.json — a JSON array of objects with an
// `id` and a `markdown` string — render every case with parse()
// from parse.js, and write /output/html.json: a JSON array of HTML
// strings, one per case, in the same order as the input.
//
// Outside the container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output. Each case is rendered on its
// own: parse() keeps nothing between calls, and this driver keeps
// nothing between cases either.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const cases = JSON.parse(
    readFileSync(join(inDir, 'cases.json'), 'utf8'),
  ) as Array<{ id: string; markdown: string }>;

  const html: string[] = [];
  for (const c of cases) html.push(parse(c.markdown));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
}

main();
