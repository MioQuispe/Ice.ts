import { Context, Effect, Layer } from "effect"
import { NodeSdk as OpenTelemetryNodeSdk } from "@effect/opentelemetry"
import {
	BatchSpanProcessor,
	InMemorySpanExporter,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import * as OtelLogger from "@effect/opentelemetry/Logger"
import * as OtelResource from "@effect/opentelemetry/Resource"
import * as OtelMetrics from "@effect/opentelemetry/Metrics"
// import Otel from "@opentelemetry"
export { Opt } from "../types/types.js"
import * as OtelLogs from "@opentelemetry/sdk-logs"

export const makeTelemetryLayer = (config: TelemetryConfigShape) => {
	const ResourceLive = OtelResource.layerFromEnv(
		config.resource && OtelResource.configToAttributes(config.resource),
	)
	const TracerLive = Layer.provide(
		OtelTracer.layer,
		OpenTelemetryNodeSdk.layerTracerProvider(config.spanProcessor, {
			shutdownTimeout: config.shutdownTimeout,
		}),
	)
	const MetricsLive = Layer.empty
	const LoggerLive = config.logRecordProcessor
		? Layer.provide(
				OtelLogger.layerLoggerAdd,
				OtelLogger.layerLoggerProvider(config.logRecordProcessor, {
					// ...loggerProviderConfig,
					shutdownTimeout: config.shutdownTimeout,
				}),
			)
		: Layer.empty
	const telemetryLayer = Layer.mergeAll(
		TracerLive,
		MetricsLive,
		LoggerLive,
	).pipe(Layer.provideMerge(ResourceLive))

	return telemetryLayer
}

export type TelemetryConfigShape = {
	resource: {
		serviceName: string
	}
	spanProcessor: SpanProcessor
	shutdownTimeout: number | undefined
	// metricReader: OtelMetrics.MetricReader
	logRecordProcessor: OtelLogs.LogRecordProcessor | undefined
}
export class TelemetryConfig extends Context.Tag("TelemetryConfig")<
	TelemetryConfig,
	TelemetryConfigShape
>() {
	static Live = ({
		resource = { serviceName: "ice" },
		spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter()),
		shutdownTimeout = undefined,
		// metricReader = undefined,
		logRecordProcessor = undefined,
	}) =>
		Layer.succeed(TelemetryConfig, {
			resource,
			spanProcessor,
			shutdownTimeout,
			// metricReader,
			logRecordProcessor,
		})

	static Test = ({
		resource = { serviceName: "ice" },
		spanProcessor = new BatchSpanProcessor(new InMemorySpanExporter()),
		shutdownTimeout = undefined,
		// metricReader = undefined,
		logRecordProcessor = undefined,
	}) =>
		Layer.succeed(TelemetryConfig, {
			resource,
			spanProcessor,
			shutdownTimeout,
			// metricReader,
			logRecordProcessor,
		})
}
