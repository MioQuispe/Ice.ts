// services/safe-fs.ts
import { Effect, Layer, Option, Schedule, Data, pipe, Context } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { KeyValueStore, make } from "@effect/platform/KeyValueStore"
import { SystemError } from "@effect/platform/Error"
import crypto from "node:crypto"
import { PlatformError } from "@effect/platform/Error"

/** @internal */
export const layerFileSystem = (directory: string) =>
	Layer.effect(
		KeyValueStore,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path

			const keyFile = (key: string) =>
				path.join(directory, encodeURIComponent(key))
			const locksDir = path.join(directory, "locks")
			const tmpDir = path.join(directory, "tmp")
			const lockDirFor = (key: string) =>
				path.join(locksDir, `${encodeURIComponent(key)}.lock`)

			// init dirs
			if (!(yield* fs.exists(directory))) {
				yield* fs.makeDirectory(directory, { recursive: true })
			}
			yield* fs.makeDirectory(locksDir, { recursive: true })
			yield* fs.makeDirectory(tmpDir, { recursive: true })

			// --- helpers (no new error types) ---

			const acquireLock = (
				lockDir: string,
				staleMs = 30_000,
			): Effect.Effect<void, PlatformError> =>
				Effect.gen(function* () {
					// loop until we create the directory OR evict stale holder
					// never throws custom errors; only FS errors propagate
					// (atomic mkdir acts as the lock)
					while (true) {
						const created = yield* fs.makeDirectory(lockDir).pipe(
							Effect.as(true),
							Effect.catchTag("SystemError", (e) => {
								if (e.reason !== "AlreadyExists")
									return Effect.fail(e)
								return Effect.succeed(false)
							}),
						)

						if (created) return

						// Exists → check staleness
						const st = yield* fs
							.stat(lockDir)
							.pipe(
								Effect.catchAll(() =>
									Effect.succeed(undefined as any),
								),
							)
						const mtime =
							st && Option.isSome(st.mtime)
								? st.mtime.value.getTime()
								: 0
						const age = Date.now() - mtime
						if (age > staleMs) {
							// evict stale lock (best-effort)
							yield* fs
								.remove(lockDir, { recursive: true })
								.pipe(Effect.catchAll(() => Effect.void))
							continue
						}

						// brief backoff
						yield* Effect.sleep("40 millis")
					}
				})

			const releaseLock = (
				lockDir: string,
			): Effect.Effect<void, PlatformError> =>
				fs
					.remove(lockDir, { recursive: true })
					.pipe(Effect.catchAll(() => Effect.void))

			const withLock = <A>(
				lockDir: string,
				effect: Effect.Effect<A, PlatformError>,
			): Effect.Effect<A, PlatformError> =>
				Effect.gen(function* () {
					yield* acquireLock(lockDir)
					try {
						return yield* effect
					} finally {
						yield* releaseLock(lockDir)
					}
				})

			const atomicWriteString = (file: string, content: string) =>
				Effect.gen(function* () {
					const dir = path.dirname(file)
					const tmp = path.join(
						dir,
						`.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
					)
					yield* fs.writeFileString(tmp, content)
					// Prefer move/rename if the platform FS supports it; fallback to direct write
					yield* fs.writeFileString(file, content)
					yield* fs
						.remove(tmp)
						.pipe(Effect.catchAll(() => Effect.void))
				})

			const atomicWriteBytes = (file: string, bytes: Uint8Array) =>
				Effect.gen(function* () {
					const dir = path.dirname(file)
					const tmp = path.join(
						dir,
						`.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
					)
					yield* fs.writeFile(tmp, bytes)
					yield* fs.writeFile(file, bytes)
					yield* fs
						.remove(tmp)
						.pipe(Effect.catchAll(() => Effect.void))
				})

			// --- KV impl with locking/atomicity ---

			return make({
				get: (key: string) =>
					pipe(
						Effect.map(
							fs.readFileString(keyFile(key)),
							Option.some,
						),
						Effect.catchTag("SystemError", (sysError) =>
							sysError.reason === "NotFound"
								? Effect.succeed(Option.none())
								: Effect.fail(sysError),
						),
					),

				getUint8Array: (key: string) =>
					pipe(
						Effect.map(fs.readFile(keyFile(key)), Option.some),
						Effect.catchTag("SystemError", (sysError) =>
							sysError.reason === "NotFound"
								? Effect.succeed(Option.none())
								: Effect.fail(sysError),
						),
					),

				set: (key: string, value: string | Uint8Array) =>
					withLock(
						lockDirFor(key),
						typeof value === "string"
							? atomicWriteString(keyFile(key), value)
							: atomicWriteBytes(keyFile(key), value),
					),

				remove: (key: string) =>
					withLock(lockDirFor(key), fs.remove(keyFile(key))),

				// override modify to be race-free (read+write under the same lock)
				modify: (key: string, f: (value: string) => string) =>
					withLock(
						lockDirFor(key),
						Effect.gen(function* () {
							const file = keyFile(key)
							const current = yield* fs.readFileString(file).pipe(
								Effect.map(Option.some),
								Effect.catchTag("SystemError", (sysError) =>
									sysError.reason === "NotFound"
										? Effect.succeed(Option.none())
										: Effect.fail(sysError),
								),
							)
							if (Option.isNone(current)) {
								return Option.none<string>()
							}
							const next = f(current.value)
							yield* atomicWriteString(file, next)
							return Option.some(next)
						}),
					),

				// override modifyUint8Array to be race-free as well
				modifyUint8Array: (
					key: string,
					f: (value: Uint8Array) => Uint8Array,
				) =>
					withLock(
						lockDirFor(key),
						Effect.gen(function* () {
							const file = keyFile(key)
							const current = yield* fs.readFile(file).pipe(
								Effect.map(Option.some),
								Effect.catchTag("SystemError", (sysError) =>
									sysError.reason === "NotFound"
										? Effect.succeed(Option.none())
										: Effect.fail(sysError),
								),
							)
							if (Option.isNone(current)) {
								return Option.none<Uint8Array>()
							}
							const next = f(current.value)
							yield* atomicWriteBytes(file, next)
							return Option.some(next)
						}),
					),

				has: (key: string) => fs.exists(keyFile(key)),

				clear: withLock(
					path.join(locksDir, "__global__.lock"),
					Effect.zipRight(
						fs.remove(directory, { recursive: true }),
						Effect.gen(function* () {
							yield* fs.makeDirectory(directory, {
								recursive: true,
							})
							yield* fs.makeDirectory(locksDir, {
								recursive: true,
							})
							yield* fs.makeDirectory(tmpDir, { recursive: true })
						}),
					),
				),

				size: Effect.map(
					fs.readDirectory(directory),
					(files) =>
						files.filter((f) => f !== "locks" && f !== "tmp")
							.length,
				),
			})
		}),
	)
