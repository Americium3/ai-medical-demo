import { mkdirSync, writeFileSync } from "node:fs";

/** Write `<prefix>results-<tag>.json` (meta + raw results) and `<prefix>summary-<tag>.md` into `dir`. */
export function writeEvalOutput(opts: {
  dir: string;
  tag: string;
  prefix?: string;
  meta: Record<string, unknown>;
  results: unknown;
  summary: string;
}): { json: string; md: string } {
  const p = opts.prefix ?? "";
  mkdirSync(opts.dir, { recursive: true });
  const json = `${opts.dir}/${p}results-${opts.tag}.json`;
  const md = `${opts.dir}/${p}summary-${opts.tag}.md`;
  writeFileSync(json, JSON.stringify({ meta: opts.meta, results: opts.results }, null, 2) + "\n");
  writeFileSync(md, opts.summary);
  return { json, md };
}
