import { readFileSync } from "node:fs";
import { buildLibraryFacts } from "../../dist/examples/library/adapter.js";
import { libraryEvidence } from "../../dist/examples/library/evidence.js";
import { config } from "../../dist/examples/library/profile.js";

export const facts = () => buildLibraryFacts(readFileSync(new URL("../../examples/library/library.md", import.meta.url), "utf8"), libraryEvidence(), config);
