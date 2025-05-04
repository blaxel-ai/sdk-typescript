import { authenticate } from "@blaxel/core";
import { blaxelTelemetry } from '@blaxel/telemetry';
import { SeverityNumber } from "@opentelemetry/api-logs";
async function main() {
  await authenticate()
  setInterval(async () => {
    const loggerInstance = await blaxelTelemetry.getLogger()
    loggerInstance.emit({
      severityNumber: SeverityNumber.INFO,
      body: 'hello',
    });
    console.log('emitted')
  }, 1000)
}

main();