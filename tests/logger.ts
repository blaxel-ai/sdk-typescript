import { logger } from "@blaxel/core";

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
  logger.debug("Hello, world!");
  logger.info("Hello, world!");
  logger.warn("Hello, world!");
  logger.error("Hello, world!");
  console.debug("Hello, world!");
  console.log("Hello, world!");
  console.info("Hello, world!");
  console.warn("Hello, world!")
  console.error("Hello, world!");
  logger.debug(deepObject);
  logger.info(deepObject);
  logger.warn(deepObject);
  logger.error(deepObject);
}

main().catch(console.error);