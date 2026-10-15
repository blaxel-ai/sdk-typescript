import { blaxel } from "@blaxel/eve-sandbox";
import { defineSandbox } from "eve/sandbox";

const namePrefix = process.env.BL_EVE_TEST_NAME_PREFIX;
if (!namePrefix) {
  throw new Error("BL_EVE_TEST_NAME_PREFIX is required for the live eve test fixture.");
}

export default defineSandbox({
  backend: blaxel({
    image: "blaxel/ts-app:latest",
    labels: {
      env: "integration-test",
      "created-by": "eve-eval",
    },
    lifecycle: {
      expirationPolicies: [{ type: "ttl-max-age", value: "1h", action: "delete" }],
    },
    namePrefix,
    region: process.env.BL_REGION ?? "us-was-1",
  }),
});
