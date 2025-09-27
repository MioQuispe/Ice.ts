import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** The version of the bundled PocketIC server. */
export const pocketIcVersion = "10.0.0"

/** Absolute path to the bundled PocketIC binary. */
export const pocketIcPath = path.resolve(
	__dirname,
	"..",
	pocketIcVersion,
	"pocket-ic",
)

export default pocketIcPath
