import { SandboxInstance, logger } from "@blaxel/core";

logger.setLogger(console)

async function main() {
  try {
    const sandbox = await SandboxInstance.create({
      name: "lightpanda-2",
      image: "sandbox/lightpanda:b4na9mq3adh6",
      memory: 1024,
    })
    await sandbox.wait()
  } catch (e) {
    console.error("There was an error => ", e);
  }
}

main()
  .catch((err) => {
    console.error("There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  })
