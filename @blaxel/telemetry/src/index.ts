import { originalLogger } from "./logger";
import blaxelTelemetry from "./telemetry";
blaxelTelemetry.init();

export { blaxelTelemetry, originalLogger };

