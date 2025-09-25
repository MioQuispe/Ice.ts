// packages/runner/src/services/logger.ts
import { HashMap, List, Logger, LogLevel, Layer, Cause } from "effect"
import * as Inspectable from "effect/Inspectable"
import { log as clog } from "@clack/prompts"
import * as p from "@clack/prompts"
import * as util from "node:util"
import { prettyLogger } from "effect/Logger"
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
                : v instanceof Error
                    ? (v.stack || `${v.name}: ${v.message}`)
                    : util.inspect(v, { colors: false, depth: 10, breakLength: Infinity })
        const piece = `${k}=${val}`
        out += first ? piece : " " + piece
        first = false
    })
    return out
}

const normalizeMessage = (message: unknown): string => {
    if (typeof message === "string") return message
    if (message instanceof Error) {
        return message.stack || `${message.name}: ${message.message}`
    }
    if (Array.isArray(message)) {
        const parts = message.map((m) =>
            typeof m === "string"
                ? m
                : m instanceof Error
                    ? (m.stack || `${m.name}: ${m.message}`)
                    : util.inspect(m, { colors: false, depth: 10, breakLength: Infinity }),
        )
        return parts.length === 1 ? parts[0]! : parts.join(" ")
    }
    return util.inspect(message, { colors: false, depth: 10, breakLength: Infinity })
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

const getShared = (): SharedUIState => {
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

// Pretty logger formatting (copied from Effect's prettyLogger), but render via our queue
const colors = {
    bold: "1",
    red: "31",
    green: "32",
    yellow: "33",
    blue: "34",
    cyan: "36",
    white: "37",
    gray: "90",
    black: "30",
    bgBrightRed: "101",
} as const

const logLevelColors: Record<LogLevel.LogLevel["_tag"], ReadonlyArray<string>> = {
    None: [],
    All: [],
    Trace: [colors.gray],
    Debug: [colors.blue],
    Info: [colors.green],
    Warning: [colors.yellow],
    Error: [colors.red],
    Fatal: [colors.bgBrightRed, colors.black],
}

const withColor = (text: string, ...codes: ReadonlyArray<string>) => {
    if (codes.length === 0) return text
    let out = ""
    for (let i = 0; i < codes.length; i++) out += `\x1b[${codes[i]}m`
    return out + text + "\x1b[0m"
}

const defaultDateFormat = (date: Date): string =>
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
        date.getSeconds(),
    ).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`

const hasProcessStdout = typeof process === "object" && process !== null && typeof process.stdout === "object" && process.stdout !== null
const processStdoutIsTTY = hasProcessStdout && process.stdout.isTTY === true
const hasProcessStdoutOrDeno = hasProcessStdout || "Deno" in globalThis

export const ClackLoggingLive: Layer.Layer<never> = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ annotations, cause, context, date, fiberId, logLevel, message: message_, spans }) => {
        const mode_ = "auto"
        const mode = mode_ === "auto" ? (hasProcessStdoutOrDeno ? "tty" : "browser") : mode_
        const isBrowser = mode === "browser"
        const showColors = processStdoutIsTTY || isBrowser
        const formatDate = defaultDateFormat
        const method = levelToClack(logLevel)

        const message = Array.isArray(message_) ? message_ : [message_]
        const color = showColors ? withColor : (s: string) => s

        const ts = formatDate(date ?? new Date())
        let firstLine = color(`[${ts}]`, colors.white) + ` ${color((logLevel as any).label, ...logLevelColors[logLevel._tag])}`
        const fiberName = (fiberId as any)?.id != null ? String((fiberId as any).id) : ""
        firstLine += fiberName ? ` (${fiberName})` : ""

        if (List.isCons(spans)) {
            const now = (date ?? new Date()).getTime()
            List.forEach(spans, (span) => {
                const label = (span as any).label
                const start = (span as any).startTime ?? now
                const dur = Math.max(0, now - start)
                firstLine += ` ${label}=${dur}ms`
            })
        }

        firstLine += ":"

        let messageIndex = 0
        if (message.length > 0) {
            const firstMaybeString = structuredMessage(message[0])
            if (typeof firstMaybeString === "string") {
                firstLine += " " + color(firstMaybeString, colors.bold, colors.cyan)
                messageIndex++
            }
        }

        // Render via queue
        emit(method, firstLine)

        // Cause
        if (cause && !(Cause as any).isEmpty?.(cause)) {
            try {
                emit(method, String(Cause.pretty(cause as any, { renderErrorCause: true })))
            } catch {
                emit(method, util.inspect(cause, { colors: false, depth: 10, breakLength: Infinity }))
            }
        }

        // Remaining messages
        for (; messageIndex < message.length; messageIndex++) {
            const m = Inspectable.redact(message[messageIndex])
            const line = typeof m === "string" ? m : Inspectable.stringifyCircular(m)
            emit(method, line)
        }

        // Annotations
        if (HashMap.size(annotations) > 0) {
            HashMap.forEach(annotations, (v, k) => {
                const redacted = Inspectable.redact(v)
                const text = typeof redacted === "string" ? redacted : Inspectable.stringifyCircular(redacted)
                emit(method, color(`${k}:`, colors.bold, colors.white) + " " + text)
            })
        }
    }),
)

const structuredMessage = (u: unknown): unknown => {
    switch (typeof u) {
        case "bigint":
        case "function":
        case "symbol":
            return String(u)
        default:
            return Inspectable.toJSON(u)
    }
}

// Note: global helpers removed; logging coordination is scoped to ClackLoggingLive layer.
