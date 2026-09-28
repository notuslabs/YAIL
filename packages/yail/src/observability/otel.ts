import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TelemetryOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** OTLP HTTP base endpoint, e.g. http://localhost:4318. Falls back to OTEL_EXPORTER_OTLP_ENDPOINT. */
  endpoint?: string;
  headers?: Record<string, string>;
  /** Metric export interval in ms. Default 15000. */
  metricsIntervalMs?: number;
  /** Extra metric readers (e.g. a Prometheus exporter). */
  metricReaders?: MetricReader[];
  /** Extra resource attributes (deployment.environment, ...). */
  resourceAttributes?: Record<string, string>;
}

/**
 * Register the OpenTelemetry SDK so `yail` metrics and traces are exported over
 * OTLP/HTTP. Call this once at process start (before `indexer.start()`).
 * Logs go through evlog's OTLP drain, configured by `observability.otlpEndpoint`.
 *
 * @example
 * import { startTelemetry } from "yail/otel";
 * const telemetry = startTelemetry({ serviceName: "wallet-ledger", endpoint: "http://otel-collector:4318" });
 * process.on("SIGTERM", () => telemetry.shutdown());
 */
export function startTelemetry(options: TelemetryOptions = {}): { shutdown(): Promise<void> } {
  const endpoint = (options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318").replace(/\/$/, "");
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "yail";
  const headers = options.headers ?? parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
      ...(options.resourceAttributes ?? {}),
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers }),
        exportIntervalMillis: options.metricsIntervalMs ?? 15_000,
      }),
      ...(options.metricReaders ?? []),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

function parseHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (k && rest.length) out[k.trim()] = decodeURIComponent(rest.join("=").trim());
  }
  return out;
}
