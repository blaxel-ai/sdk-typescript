import { getAlphanumericLimitedHash } from "@blaxel/core";

const hash = await getAlphanumericLimitedHash("myws-function-blaxel-search",48);
console.log(hash);
if (hash !== "1329b024814bbed3083f020681366a37") {
  throw new Error("Hash is not correct");
}