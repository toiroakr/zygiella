import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  platform: "node",
  // the implementation comments explain the source, not the package; the types keep their docs in index.d.mts
  outputOptions: { comments: false },
});
