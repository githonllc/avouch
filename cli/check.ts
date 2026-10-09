import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { check } from "../src/checker.js";
import type { Report, SourceFacts } from "../src/contract.js";
import { markdownFacts, parseMarkdownConfig, type MarkdownDoc } from "../src/markdown.js";

/** The configuration of the built-in Markdown adapter that `avouch check` reads next to the ontology when no adapter is given. */
export const CONFIG_FILE = "avouch.json";

// Built-in Markdown adapter: reads the configuration and its documents (paths relative to the configuration file).
function markdownAdapter(configFile: string): SourceFacts {
  const configPath = resolve(configFile);
  const cfg = parseMarkdownConfig(readFileSync(configPath, "utf8"), configFile);
  const docError = (i: number, error: unknown) => new Error(`${configFile}: docs[${i}]: ${(error as Error).message}`);
  const paths = cfg.docs.map((doc) => resolve(dirname(configPath), doc));
  // file identity (device and inode), so a case variant on a case-insensitive file system or a link is a duplicate too
  const ids = paths.map((path, i) => {
    try {
      const st = statSync(path);
      return `${st.dev}:${st.ino}`;
    } catch (error) {
      throw docError(i, error);
    }
  });
  ids.forEach((id, j) => {
    const i = ids.indexOf(id);
    if (i !== j) throw new Error(`${configFile}: docs[${j}]: duplicate of docs[${i}]`);
  });
  const docs: MarkdownDoc[] = paths.map((path, i) => {
    try {
      return { path: cfg.docs[i], text: readFileSync(path, "utf8") };
    } catch (error) {
      throw docError(i, error);
    }
  });
  return markdownFacts(docs, cfg);
}

// Runs the JSON Schema validator and the checker on one ontology file with one adapter: a module that exports `facts`, or a
// `.json` configuration of the built-in Markdown adapter. adapterFile null: the `avouch.json` next to the ontology.
// Shared by `avouch check` and `avouch query --adapter`, so both report the same counts.
export async function runCheck(ontologyFile: string, adapterFile: string | null): Promise<{ schemaErrors: ErrorObject[]; report: Report }> {
  const ontologyPath = resolve(ontologyFile);
  const schema = JSON.parse(readFileSync(new URL("../../ontology.schema.json", import.meta.url), "utf8"));
  const ontology: unknown = parse(readFileSync(ontologyPath, "utf8"));
  const adapter = adapterFile ?? join(dirname(ontologyPath), CONFIG_FILE);
  let facts: SourceFacts;
  if (adapter.endsWith(".json")) facts = markdownAdapter(adapter);
  else {
    const mod = await import(pathToFileURL(resolve(adapter)).href);
    if (typeof mod.facts !== "function") throw new Error("adapter must export a named facts function");
    facts = await mod.facts(ontologyPath);
  }
  const validate = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(schema);
  validate(ontology);
  const schemaErrors = validate.errors ?? [];
  const report = check(ontology, facts);
  return { schemaErrors, report };
}
