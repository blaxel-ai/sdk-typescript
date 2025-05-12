import { settings } from "@blaxel/core";
import { setJsonLogger } from "./json_logger";
import { setLegacyLogger } from "./legacy_logger";
import { blaxelTelemetry } from "./telemetry";
blaxelTelemetry.initialize();
if (settings.loggerType === "http") {
setLegacyLogger();
} else if (settings.loggerType === "json") {
  setJsonLogger();
}
export { blaxelTelemetry };

