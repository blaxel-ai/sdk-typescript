import { blaxel } from "@blaxel/eve-sandbox";
import { defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: blaxel({
    image: "blaxel/ts-app:latest",
    labels: { application: "eve" },
    memory: 4096,
  }),
  async onSession({ use }) {
    const sandbox = await use({
      networkPolicy: {
        allow: ["api.github.com", "github.com", "registry.npmjs.org"],
      },
    });
    const result = await sandbox.run({ command: "mkdir -p /workspace/project" });
    if (result.exitCode !== 0) {
      throw new Error(`Blaxel session setup failed: ${result.stderr}`);
    }
  },
});
