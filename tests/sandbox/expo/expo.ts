import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../../utils";

const sandboxName = "sandbox-test-expo"
const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Blaxel-Workspace, X-Blaxel-Preview-Token, X-Blaxel-Authorization",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Expose-Headers": "Content-Length, X-Request-Id",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

async function addRouterOriginToAppJson(sandbox: SandboxInstance, previewUrl: string) {
  const appJsonPath =  "/blaxel/app/app.json";

  try {
      // Read the current app.json file
      const appJsonContent = await sandbox.fs.read(appJsonPath);

      // Parse the JSON
      const appJson = JSON.parse(appJsonContent);

      // Add the router origin configuration
      appJson.expo = {
          ...appJson.expo,
          extra: {
              ...(appJson.expo.extra || {}),
              router: {
                  ...(appJson.expo.extra?.router || {}),
                  origin: previewUrl,
              },
          },
      };

      // Write the updated app.json back to the file
      await sandbox.fs.write(appJsonPath, JSON.stringify(appJson, null, 2));
  } catch (error) {
      console.error(`Failed to update app.json: ${error}`);
      throw error;
  }
}

async function main() {
  try {
    // Test with controlplane
    const sandbox = await createOrGetSandbox({sandboxName, image: 'blaxel/prod-expo:latest'})

    await sandbox.fs.ls("/")

    const previews = await sandbox.previews.list()
    let preview = previews.find(preview => preview.metadata?.name === "preview")
    if (!preview) {
      preview = await sandbox.previews.create({
        metadata: {
          name: "preview",
        },
        spec: {
          responseHeaders,
          prefixUrl: "sandbox-expo-test",
          public: false,
          port: 8081,
        }
      })
    }
    let token
    const tokens = await preview.tokens.list()
    if (tokens.length === 0) {
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24) // 1 day from now
      token = await preview.tokens.create(expiresAt)
      console.log(`created token name=${token.name} token=${token.token} expiresAt=${token.expiresAt}`)
    } else {
      token = tokens[0]
    }
    await addRouterOriginToAppJson(sandbox, preview.spec?.url!)

    const processes = await sandbox.process.list()
    let process = processes.find(process => process.name === "expo")
    if (!process) {
      process = await sandbox.process.exec({
        name: "expo",
        command: "npx expo start --web --port 8081 --scheme exp --clear",
        workingDir: "/blaxel/app",
        waitForPorts: [8081],
      })
    }
    const handleLogs = sandbox.process.streamLogs(process.name!, {
      onLog: (log) => {
        console.log(log)
      }
    })

    console.log(token)
    console.log(`Preview URL: ${preview.spec?.url}?bl_preview_token=${token.previewToken.spec?.token}`)
    handleLogs.close()
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
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
