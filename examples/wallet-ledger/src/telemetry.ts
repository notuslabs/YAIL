/**
 * Optional: export metrics and traces over OTLP. Import this module first in
 * the process (or run with `node --import`), before the indexer starts.
 */
import { startTelemetry } from "yail/otel";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const telemetry = startTelemetry({ serviceName: "wallet-ledger" });
  process.on("SIGTERM", () => void telemetry.shutdown());
}
