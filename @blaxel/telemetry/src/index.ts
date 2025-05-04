import { originalLogger } from "./logger";
import { blaxelTelemetry } from "./telemetry";
blaxelTelemetry.initialize();

export { blaxelTelemetry, originalLogger };

