import { settings } from "@blaxel/core";
import { setJsonLogger } from "./json_logger";
import { blaxelTelemetry } from "./telemetry";
blaxelTelemetry.initialize();
if (settings.loggerType === "json") {
  setJsonLogger();
}
export {
  AuthRefreshingMetricExporter, AuthRefreshingSpanExporter, createMetricExporter, createTraceExporter
} from "./auth_refresh_exporters";
export { setJsonLogger } from "./json_logger";
export { blaxelTelemetry };

