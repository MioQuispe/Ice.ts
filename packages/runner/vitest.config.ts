import wasm from "vite-plugin-wasm"
import { defineConfig } from "vitest/config"
import * as os from "node:os"

// const cpu = os.cpus().length
// const workers = Math.max(2, Math.min(8, Math.floor(cpu / 2)))

export default defineConfig({
	test: {
		testTimeout: 300000,
		coverage: {
			provider: "v8",
            enabled: false,
		},
        // pool: "forks",
        // maxConcurrency: 8,
		// maxConcurrency: 20,
        // poolOptions: {
        //     // forks: {
        //     //     isolate: false,
        //     // },
        //     // threads: {
        //     //     useAtomics: true,
        //     //     isolate: false,
        //     // },
        // },
		// poolOptions: {
		// 	threads: {
		// 		useAtomics: true,
		// 		isolate: true,
		// 	},
		// },
		// minWorkers: 20,
		// maxWorkers: 20,
	},
	plugins: [wasm()],
})
