import { logger, onLoad } from "../src/index.js";

const deepObject = {
  a: {
    b: {
      c: {
        d: {
          e: 5,
        },
      },
    },
  },
  b: 2,
  c: 3,
  d: 4,
  e: 5,
};

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
  logger.debug(deepObject);
  logger.log(deepObject);
  logger.info(deepObject);
  logger.warn(deepObject);
  logger.error(deepObject);
}

main().catch(console.error);