import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/run-bin.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  sourcemap: false,
  clean: true,
  minify: false
});