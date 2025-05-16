import { blJob } from "@blaxel/core";

async function main() {
  const job = blJob("myjob");
  let res = await job.run([{
    name: "test"
  }]);
  console.log(res)
}

main().catch(console.error)
