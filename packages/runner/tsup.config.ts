// tsup.config.ts in @ice.ts/runner
import { defineConfig } from "tsup"

export default defineConfig([
	// normal runtime build
	{
		entry: {
			index: "src/index.ts",
		},
		// entry: ["src/index.ts", "src/**/*.ts"],
        // {
		// 	index: "src/index.ts",
		// },
		outDir: "tsup",
		format: ["esm"],
		bundle: true,
		splitting: false,
        target: "esnext",
        tsconfig: "tsconfig.json",
        platform: "node",
		sourcemap: true,
		clean: true,
		dts: true,
		esbuildOptions(options) {
			options.loader = {
				...options.loader,
				".wasm": "file",
			}
		},
	},
])
