import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "orcid/index": "src/orcid/index.ts",
      "semantic-scholar/index": "src/semantic-scholar/index.ts",
      "github/index": "src/github/index.ts",
      "linkedin-pdf/index": "src/linkedin-pdf/index.ts",
    },
    format: ["esm", "cjs"],
    // DTS is generated separately via `tsc --emitDeclarationOnly`
    // because tsup's DTS worker doesn't respect composite project file lists
    dts: false,
    clean: true,
    sourcemap: true,
  },
]);
