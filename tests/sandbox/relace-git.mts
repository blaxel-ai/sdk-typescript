import { SandboxInstance } from "@blaxel/core";
import { Relace } from '@relace-ai/relace';
import { env } from "process";
import dotenv from 'dotenv';

dotenv.config();

const scriptAlreadyExecuted = async (sandbox: SandboxInstance, processName: string) => {
  try {
    await sandbox.process.get(processName)
    return true
  } catch (e) {
    return false
  }
}

const client = new Relace({ apiKey: env.RELACE_API_KEY! });
const sandbox = await SandboxInstance.createIfNotExists({ name: 'relace-git', envs: [{ name: 'RELACE_API_KEY', value: env.RELACE_API_KEY! }] })


const repoExist = await client.repo.list({
  filter_metadata: `{"sandbox": "${sandbox.metadata?.name!}"`
})
console.log(repoExist)

if (!repoExist) {
  const repo = await client.repo.create({
    source: {
      type: 'files',
      files: [
        {
          filename: 'README.md',
          content: '# Vite Template',
        },
      ],
    },
    auto_index: true, // Required for semantic search
    metadata: {
      "sandbox": sandbox.metadata?.name!
    }, // Optional: add any custom properties
  });
  console.log(`Repository created with ID: ${repo.repo_id}`);
} else {
  console.log('Repository already exists')
}

// const tsScript = await sandbox.process.exec({
//   name: 'create-repo'
//   command: 'node script.mts',
//   workingDir: '/blaxel',
//   waitForCompletion: true,
// })
// console.log(tsScript.logs)
// const createNextJsApp = `
// `
