import { readFileSync } from "node:fs";

// One JSON value per line, with its line number (from 1). Lines that are empty or only white space are skipped; the
// line numbers count them.
export function jsonLines(file: string): { line: number; value: unknown }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((text, i) => {
      if (text.trim() === "") return [];
      try {
        return [{ line: i + 1, value: JSON.parse(text) as unknown }];
      } catch (error) {
        throw new Error(`${file}:${i + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export function readJsonLines(file: string): unknown[] {
  return jsonLines(file).map((x) => x.value);
}
