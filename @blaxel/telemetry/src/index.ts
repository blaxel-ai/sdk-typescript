import { settings } from "@blaxel/core";
import { setJsonLogger } from "./json_logger";
import { blaxelTelemetry } from "./telemetry";
blaxelTelemetry.initialize();
if (settings.loggerType === "json") {
  setJsonLogger();
}
export { setJsonLogger } from "./json_logger";
export { blaxelTelemetry };

