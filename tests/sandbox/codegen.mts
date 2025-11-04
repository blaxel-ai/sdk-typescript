import { SandboxInstance } from "@blaxel/core";
import dotenv from "dotenv";

dotenv.config();

const sandbox = await SandboxInstance.create({
  envs: [
    { name: "RELACE_API_KEY", value: process.env.RELACE_API_KEY! },
  ]
})

console.log("Applying code edit...")
await sandbox.codegen.fastapply("/tmp/test.txt", "// ... existing code ...\nconsole.log('Hello, world!');")
await sandbox.codegen.fastapply("/tmp/test.txt", "// ... keep existing code\nconsole.log('The meaning of life is 42');")
console.log(await sandbox.fs.read("/tmp/test.txt"))

console.log("Reranking...")
const result = await sandbox.codegen.reranking("/tmp", "What is the meaning of life?", 0.5, 1000, ".*\\.txt$")
console.log(result)
