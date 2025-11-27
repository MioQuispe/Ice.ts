import {
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Stream,
  SubscriptionRef
} from "effect"
import {
  Box,
  render,
  Text,
  useApp,
  useFocus,
  useFocusManager,
  useInput,
  useStdout,
} from "ink"
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react"
// import { TUILayer } from "../../index.js"
import { filterNodes } from "../../tasks/lib.js"
import { runTaskByPath } from "../../tasks/run.js"
import type { ICEConfig, Scope, Task, TaskTree } from "../../types/types.js"
import { TaskList, TaskListItem, type StateOthers } from "./components/Task.js"
import { FlatScrollableTaskTreeList } from "./components/scrollable-task-tree-list.js"
// export const TUILayer = Layer.mergeAll(
// 	DefaultsLayer,
// 	ICEConfigService.Live.pipe(
// 		Layer.provide(NodeContext.layer),
// 	),
// 	Layer.succeed(TaskArgsService, {
// 		taskArgs: {},
// 	}),
// 	Logger.minimumLogLevel(LogLevel.Debug),
// )


export function useSynchronizedState<T>(defaultState: T) {
	const [subscriptionRef] = useState(() =>
		Effect.runSync(SubscriptionRef.make<T>(defaultState)),
	)

	const value = useSyncExternalStore(
		(callback) =>
			Stream.runForEach(subscriptionRef.changes, () =>
				Effect.sync(callback),
			).pipe(Effect.runCallback),
		() => {
			return Effect.runSync(SubscriptionRef.get(subscriptionRef))
		},
	)

	return [value, subscriptionRef] as const
}

export const StaticLogs: React.FC<{ logs: string[]; maxHeight?: number }> = ({
	logs,
	maxHeight,
}) => {
	const { stdout } = useStdout()
	// Use the provided maxHeight if available; if not, use stdout.rows minus a margin.
	const viewHeight: number =
		maxHeight ?? (stdout ? Math.max(stdout.rows - 5, 1) : 10)
	// Slice to only show the last `viewHeight` lines of logs.
	const visibleLogs: string[] = logs.slice(-viewHeight)

	return (
		<Box flexDirection="column" height={viewHeight}>
			{visibleLogs.map((log, index) => (
				<Text key={index}>{log}</Text>
			))}
		</Box>
	)
}

export const TaskTreeListItem = <A, E, R>({
	label,
	task,
	path,
	...props
}: {
	label: string
	task: Task<A, Record<string, Task>, Record<string, Task>, E, R>
	path: string[]
}) => {
	const { isFocused } = useFocus()
	// TODO: get state
	const [state, setState] = useState<StateOthers>("pending")
	const [logs, setLogs] = useState<string[]>([])
	// TODO: should logs be separate for each task?
	const { runTask } = useICE()
	useInput(
		async (input, key) => {
			if (!isFocused) {
				return
			}
			if (key.return || input === " ") {
				setState((currentState) =>
					currentState === "loading" ? "pending" : "loading",
				)
				try {
					await runTask(path)
					setState("success")
				} catch (e) {
					console.log(e)
					setState("error")
				}
			}
		},
		{ isActive: isFocused },
	)
	return (
		<>
			<TaskListItem
				state={isFocused ? "selected" : state}
				label={label}
				{...props}
			/>
			<Text>{logs.join("\n")}</Text>
		</>
	)
}
const ICEContext = createContext<{
	logs: string[]
	runTask: (path: string[]) => Promise<void>
} | null>(null)

/**
 * ICEProvider initializes the runtime environment, including a custom logger.
 * It also overrides console.log so that any calls to it are captured into the logs state,
 * allowing StaticLogs to render them.
 */
const ICEProvider: React.FC<{
	children: React.ReactNode
}> = ({ children }) => {
	const [logs, setLogs] = useState<string[]>([])

	// Override console.log so that log output is captured into our logs state.
	useEffect(() => {
		const originalConsoleLog = console.log

		const formatArg = (arg: unknown): string => {
			if (typeof arg === "bigint") {
				return arg.toString()
			}
			// Try to stringify the argument, handling BigInts gracefully.
			try {
				return typeof arg === "string"
					? arg
					: JSON.stringify(arg, (_, value) =>
							typeof value === "bigint" ? value.toString() : value,
						)
			} catch (err) {
				return String(arg)
			}
		}

		console.log = (...args: unknown[]) => {
			const message = args.map(formatArg).join(" ")
			setLogs((prevLogs) => [...prevLogs, message])
		}
		return () => {
			console.log = originalConsoleLog
		}
	}, [])

	const [runtime] = useState(() => {
		// Create a logger that additionally pushes its messages into our logs.
		const logger = Logger.make(({ logLevel, message }) => {
			setLogs((prevLogs) => [...prevLogs, `${message}`])
		})
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				TUILayer,
				// Replace the default logger with our custom logger.
				Logger.replace(Logger.defaultLogger, logger),
			),
		)
		return runtime
	})

	const runTask = async (path: string[]) => {
		// TODO: pass in cli args
		await runtime.runPromise(runTaskByPath(path.join(":")))
	}

	return (
		<ICEContext.Provider value={{ logs, runTask }}>
			{children}
		</ICEContext.Provider>
	)
}

export const useICE = () => {
	const ice = useContext(ICEContext)
	if (!ice) {
		throw new Error("useICE must be used within a ICEProvider")
	}
	return ice
}

const TaskTreeList = ({
	taskTree,
	title,
	path = [],
}: {
	taskTree: TaskTree | Scope | Task
	title: string
	path?: string[]
}) => {
	const keys =
		taskTree._tag === "scope"
			? Object.keys(taskTree.children)
			: Object.keys(taskTree)
	return (
		<TaskList>
			{keys.map((key) => {
				const node =
					taskTree._tag === "scope"
						? (taskTree as Scope).children[key]
						: (taskTree as TaskTree)[key]
				const fullPath = [...path, key]
				// const state = fullPath.includes("cap") ? "loading" : "pending"
				// TODO: get task state and allow running tasks
				const state = "pending"
				if (node?._tag === "task") {
					return (
						<>
							<TaskTreeListItem
								key={fullPath.join(":")}
								label={fullPath[fullPath.length - 1]!}
								task={node}
								path={fullPath}
							/>
							{/* <Text>
                {node.description}
            </Text> */}
						</>
					)
				}
				if (node?._tag === "scope") {
					return (
						<>
							<TaskListItem
								key={fullPath.join(":")}
								isExpanded
								label={fullPath[fullPath.length - 1]!}
							>
								<TaskTreeList
									key={fullPath.join(":")}
									taskTree={node.children}
									title={fullPath.join(":")}
									path={fullPath}
								/>
							</TaskListItem>
						</>
					)
				}
				return null
			})}
		</TaskList>
	)
}

function useStdoutDimensions(): [number, number] {
	const { stdout } = useStdout()
	const [dimensions, setDimensions] = useState<[number, number]>([
		stdout.columns,
		stdout.rows,
	])

	useEffect(() => {
		const handler = () => setDimensions([stdout.columns, stdout.rows])
		stdout.on("resize", handler)
		return () => {
			stdout.off("resize", handler)
		}
	}, [stdout])

	return dimensions
}

const Logs = () => {
	const { logs } = useICE()
	const [columns, rows] = useStdoutDimensions()
	const offset = columns * rows * 0.25
	// const offset = 40
	const start = logs.length - offset > 0 ? logs.length - offset : 0
	const end = logs.length - 1

	return (
		<Box>
			<Text>{logs.slice(start, end).join("\n")}</Text>
		</Box>
	)
}

const UI = ({
	config,
	taskTree,
}: {
	config: ICEConfig
	taskTree: TaskTree
}) => {
	const { logs } = useICE()
	// Determine the available height for the logs panel.
	// For example, if you want the logs panel to be 10 rows high:
	const containerHeight = 35
	return (
		<Box margin={2} rowGap={2} flexDirection="row">
			<Box width="50%">
				<FlatScrollableTaskTreeList
					key="tasks"
					taskTree={taskTree}
					title="Available tasks"
				/>
			</Box>
			<Box width="50%" height="100%" flexDirection="column">
				<Text color="blue">Logs</Text>
				<Box borderStyle="single" width="100%" height={containerHeight}>
					<StaticLogs logs={logs} maxHeight={containerHeight - 2} />
				</Box>
			</Box>
		</Box>
	)
}

const CliApp = ({
	config,
	taskTree,
}: {
	config: ICEConfig
	taskTree: TaskTree
}) => {
	const focusManager = useFocusManager()
	const [editingField, setEditingField] = useState<string>()
	const { exit } = useApp()

	useEffect(() => {
		focusManager.enableFocus()
	}, [focusManager])

	useEffect(() => {
		focusManager.focusNext()
	}, [])

	useInput(
		(input, key) => {
			if (key.upArrow || input === "k") {
				focusManager.focusPrevious()
			} else if (key.downArrow || input === "j") {
				focusManager.focusNext()
			} else if (key.escape || input === "q") {
				exit()
			}
		},
		{ isActive: !editingField },
	)

	return (
		<ICEProvider>
			<UI config={config} taskTree={taskTree} />
		</ICEProvider>
	)
}

// export const uiTask = () => {
export const uiTask = ({
	config,
	taskTree,
}: {
	config: ICEConfig
	taskTree: TaskTree
}) =>
	Effect.gen(function* () {
		//   yield* Console.log("Coming soon...")
		// TODO: react-ink
		//   render(<App />)
		const allTasks = yield* filterNodes(
			taskTree,
			(task) => task._tag === "task",
		)
		render(<CliApp config={config} taskTree={taskTree} />)
		//   void render(
		//     React.createElement(Text, {}, "Hello world")
		//   )
	})
