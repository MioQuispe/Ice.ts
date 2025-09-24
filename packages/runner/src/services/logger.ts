// packages/runner/src/services/logger.ts
import { HashMap, List, Logger, LogLevel, Layer } from "effect"
import { log as clog } from "@clack/prompts"
import * as p from "@clack/prompts"
import * as util from "node:util"
// keep logger free of Effect services/fibers

const levelToClack = (level: LogLevel.LogLevel): "info" | "warn" | "error" => {
	switch (level._tag) {
		case "All":
		case "Trace":
		case "Debug":
		case "Info":
			return "info"
		case "Warning":
			return "warn"
		case "Error":
		case "Fatal":
			return "error"
		case "None":
			return "info"
	}
}

const formatSpans = (spans: List.List<{ label: string }>): string => {
	let out = ""
	let first = true
	List.forEach(spans, (s) => {
		out += first ? s.label : " > " + s.label
		first = false
	})
	return out
}

const formatAnnotations = (ann: HashMap.HashMap<string, unknown>): string => {
	let out = ""
	let first = true
	HashMap.forEach(ann, (v, k) => {
		const val =
			typeof v === "string"
				? v
				: util.inspect(v, { colors: false, depth: 2 })
		const piece = `${k}=${val}`
		out += first ? piece : " " + piece
		first = false
	})
	return out
}

const normalizeMessage = (message: unknown): string => {
    if (typeof message === "string") return message
    if (Array.isArray(message)) {
        const parts = message.map((m) =>
            typeof m === "string"
                ? m
                : util.inspect(m, { colors: false, depth: 6, breakLength: Infinity }),
        )
        // If callers passed a single large string in an array, preserve exact content
        return parts.join("")
    }
    // For objects and others, render compactly without '+\n' concatenations
    return util.inspect(message, { colors: false, depth: 6, breakLength: Infinity })
}

// Single-writer UI queue: logs and spinner events share one pipeline
type LogEvent = { kind: "log"; method: "info" | "warn" | "error"; line: string }
type SpinnerStart = { kind: "spinner_start"; msg: string }
type SpinnerMessage = { kind: "spinner_message"; msg: string }
type SpinnerStop = { kind: "spinner_stop"; msg: string; code: number }
type UIEvent = LogEvent | SpinnerStart | SpinnerMessage | SpinnerStop

// Single-writer queue with prompt-aware priority (pause while prompt is active)
// Use a global singleton so multiple layers/instances share the exact same state.
type SharedUIState = {
    queue: UIEvent[]
    draining: boolean
    promptActive: boolean
    spinner: ReturnType<typeof p.spinner> | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getShared = (): SharedUIState => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any
    if (!g.__ICE_UI_STATE) {
        g.__ICE_UI_STATE = {
            queue: [],
            draining: false,
            promptActive: false,
            spinner: null,
        } as SharedUIState
    }
    return g.__ICE_UI_STATE as SharedUIState
}

const drain = () => {
    const shared = getShared()
    if (shared.draining) return
    if (shared.promptActive) return
    shared.draining = true
    queueMicrotask(() => {
        try {
            // process at most a handful of events per tick to reduce starvation
            let processed = 0
            while (shared.queue.length > 0 && processed < 8) {
                if (shared.promptActive) break
                const ev = shared.queue.shift()!
                switch (ev.kind) {
                    case "log": {
                        if (ev.method === "info") clog.info(ev.line)
                        else if (ev.method === "warn") clog.warn(ev.line)
                        else clog.error(ev.line)
                        break
                    }
                    case "spinner_start": {
                        if (shared.spinner) {
                            try { shared.spinner.stop() } catch {}
                        }
                        shared.spinner = p.spinner()
                        shared.spinner.start(ev.msg)
                        break
                    }
                    case "spinner_message": {
                        if (shared.spinner) shared.spinner.message(ev.msg)
                        break
                    }
                    case "spinner_stop": {
                        if (shared.spinner) {
                            try { shared.spinner.stop(ev.msg, ev.code) } catch {}
                            shared.spinner = null
                        }
                        break
                    }
                }
                processed++
            }
        } finally {
            const s = getShared()
            s.draining = false
            if (!s.promptActive && s.queue.length > 0) drain()
        }
    })
}

export const setPromptActive = (active: boolean) => {
    const shared = getShared()
    shared.promptActive = active
    if (!active) drain()
}

const emit = (method: "info" | "warn" | "error", line: string): void => {
    const shared = getShared()
    shared.queue.push({ kind: "log", method, line })
    drain()
}

// Spinner enqueue helpers used by PromptsService to unify UI writes
export const uiSpinnerStart = (msg?: string) => {
    const shared = getShared()
    shared.queue.push({ kind: "spinner_start", msg: msg ?? "" })
    drain()
}
export const uiSpinnerMessage = (msg?: string) => {
    const shared = getShared()
    shared.queue.push({ kind: "spinner_message", msg: msg ?? "" })
    drain()
}
export const uiSpinnerStop = (msg?: string, code?: number) => {
    const shared = getShared()
    shared.queue.push({ kind: "spinner_stop", msg: msg ?? "", code: code ?? 0 })
    drain()
}

export const ClackLoggingLive: Layer.Layer<never> = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message, annotations, spans, date }) => {
        const method = levelToClack(logLevel)
        const ts = date?.toISOString?.() ?? new Date().toISOString()
        const spanPath = formatSpans(spans)
        const ann = formatAnnotations(annotations)
        const msg = normalizeMessage(message)

        const line =
            (spanPath ? `[${ts}] ${spanPath} ${msg}` : `[${ts}] ${msg}`) +
            (ann ? " " + ann : "")

        emit(method, line)
    }),
)

// Note: global helpers removed; logging coordination is scoped to ClackLoggingLive layer.
