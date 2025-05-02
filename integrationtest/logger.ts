import { logger, onLoad } from "../src/index.js";


async function main() {
  await onLoad();
  logger.debug("Hello, world!");
  logger.log("Hello, world!");
  logger.info("Hello, world!");
  logger.warn("Hello, world!");
  logger.error("Hello, world!");
  console.debug("Hello, world!");
  console.log("Hello, world!");
  console.info("Hello, world!");
  console.warn("Hello, world!")
  console.error("Hello, world!");
}

main().catch(console.error);