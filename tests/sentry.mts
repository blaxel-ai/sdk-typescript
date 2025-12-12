import { settings } from "@blaxel/core";

console.log("Sentry DSN:", settings.sentryDsn);

// Wait a moment for Sentry to fully initialize
await new Promise(resolve => setTimeout(resolve, 100));

console.log("Testing error capture...");

try {
  // This will throw the error you intentionally added
  console.log(settings.headers);
} catch (error) {
  // SDK errors logged to console.error are automatically captured
  console.error(error);
}

await new Promise(resolve => setTimeout(resolve, 1000));
