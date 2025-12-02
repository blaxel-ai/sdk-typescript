import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-private"


async function runProcess(sandbox: SandboxInstance) {

  try {
    const pr = await sandbox.process.get("run");
    if(pr.status === "running") {
      await sandbox.process.kill("run");
    }
  } catch (e) {
    console.log("That is expected => ", e.error);
  }

  await sandbox.process.exec({
    name: "run",
    command: "npm run dev",
    workingDir: "/blaxel/app",
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  const process = await sandbox.process.get("run");
  if (process.status !== "running") {
    throw new Error("Process did not start");
  }
}

async function testPreviewToken(sandbox: SandboxInstance) {
  try {
    try {
      await sandbox.previews.delete("preview-test-private");
    } catch (e) {
      console.log("That is expected => ", e.error);
    }

    const preview = await sandbox.previews.create({
      metadata: {
        name: "preview-test-private"
      },
      spec: {
        port: 443,
        public: false
      }
    })
    const token = await preview.tokens.create(new Date(Date.now() + 1000 * 30)) // 30s expiration

    const response = await fetch(`${preview.spec?.url}/health`)
    if (response.status !== 401) {
      throw new Error(`Preview is not protected by token, response => ${response.status}`);
    }
    const responseWithToken = await fetch(`${preview.spec?.url}/health?bl_preview_token=${token.value}`)
    if (responseWithToken.status !== 200) {
      throw new Error(`Preview is not working with token, response => ${responseWithToken.status}`);
    }

    // Extract the cookie from the response to use in the next request
    const cookie = responseWithToken.headers.get('set-cookie');
    if (!cookie) {
      throw new Error('No cookie was set by the preview token endpoint');
    }

    const responseWithTokenProvidedBefore = await fetch(`${preview.spec?.url}/health`, {
      headers: {
        'Cookie': cookie
      }
    })
    if (responseWithTokenProvidedBefore.status !== 200) {
      throw new Error(`Preview is not working with token already provided, response => ${responseWithTokenProvidedBefore.status}`);
    }

  } catch (e) {
    console.log("ERROR IN PREVIEWS NOT EXPECTED => ", e);
  } finally {
    await sandbox.previews.delete("preview-test-private")
  }
}

async function main() {
  try {
    // Test with controlplane
    const sandbox = await createOrGetSandbox({
      sandboxName
    })

    await runProcess(sandbox);
    await testPreviewToken(sandbox);
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
    console.log("Deleting sandbox");
    await SandboxInstance.delete(sandboxName)
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
