import { getGlobalUniqueHash } from "@blaxel/core";

const hash = await getGlobalUniqueHash("charlou-dev","function","blaxel-search");
console.log(hash);
if (hash !== "594d9322779f4a07a55a7bf1050360c6") {
  throw new Error("Hash is not correct");
}