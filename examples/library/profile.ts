import type { FormatConfig } from "../../src/contract.js";

export const config: FormatConfig = {
  actionIdPattern: /^[A-Z][A-Z_]*$/,
  linkFieldPattern: /_id$/,
  stateProperty: "state",
  crossContextMechanisms: ["same_transaction"],
  requiredSource: { R10: "L10" },
  rules: { R1: true, R2: true, R3: true, R4: true, R5: true, R6: true, R7: true, R8: true, R9: true, R10: true, R11: true, R12: true },
};
