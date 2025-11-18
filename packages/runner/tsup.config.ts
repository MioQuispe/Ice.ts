// tsup.config.ts in @ice.ts/runner
import { defineConfig } from "tsup"

export default defineConfig([
	// normal runtime build
	{
		entry: {
			index: "src/index.ts",
		},
		outDir: "dist",
		format: ["esm"],
		bundle: true,
		splitting: true,
		sourcemap: true,
		clean: true,
		dts: true, // normal API d.ts
		esbuildOptions(options) {
			options.loader = {
				...options.loader,
				".wasm": "file",
			}
		},
	},

	// types-only bundle for Identity
	//   {
	//     entry: {
	//       identity: "src/identity-entry.ts",
	//     },
	//     outDir: "dist/types",
	//     format: ["esm"],
	//     bundle: false, // doesn’t matter much, but we only care about d.ts here
	//     dts: {
	//       entry: "src/identity-entry.ts",
	//       // tsup will emit dist/types/identity.d.ts as a flattened definition
	//     },
	//     clean: false,
	//     sourcemap: false,
	//     // no js output needed; tsup will still create a tiny .js, you can ignore it
	//   },
])
