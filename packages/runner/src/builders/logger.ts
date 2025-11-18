// Simple logger implementation for builders
// Uses console.log internally - will be replaced with proper implementation later

export const logger = {
	logInfo: (...args: unknown[]) => {
		console.log("[INFO]", ...args)
	},
	logDebug: (...args: unknown[]) => {
		console.log("[DEBUG]", ...args)
	},
	logError: (...args: unknown[]) => {
		console.error("[ERROR]", ...args)
	},
	logWarning: (...args: unknown[]) => {
		console.warn("[WARN]", ...args)
	},
}
