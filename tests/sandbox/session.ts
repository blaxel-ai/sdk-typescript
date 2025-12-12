import { SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    // Test with controlplane
    const sandbox = await SandboxInstance.create()

    const sessions = await sandbox.sessions.list()
    for (const session of sessions) {
      console.log("removing session", session.name)
      await sandbox.sessions.delete(session.name)
    }
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24) // 1 day from now
    const session = await sandbox.sessions.create({ expiresAt })
    console.log(`created session name=${session.name} url=${session.url} token=${session.token} expiresAt=${session.expiresAt}`)
    console.log(`URL=${session.url}?bl_preview_token=${session.token}`)

    const sandboxWithSession = await SandboxInstance.fromSession(session)

    // Simple LS
    const result = await sandboxWithSession.fs.ls("/")
    console.log("LS", result.subdirectories?.map((subdir) => subdir.path))

    // Follow the logs of a command
    // This command will output to both stdout and stderr 5 times with a 5 second sleep between each
    const command = `sh -c 'for i in $(seq 1 3); do echo "Hello from stdout $i"; echo "Hello from stderr $i" 1>&2; sleep 1; done'`;
    const name = "test-2"
    await sandboxWithSession.process.exec(
      {
        command,
        name,
      },
    );
    const stream = sandboxWithSession.process.streamLogs(name, {
      onLog: (log) => {
        console.log("onLog", log);
      },
    })
    await sandboxWithSession.process.wait(name)
    stream.close()

    // Watch directory
    const handle = sandboxWithSession.fs.watch("/", (filePath) => {
      console.log("File changed", filePath)
    });
    // Trigger a file change
    await sandboxWithSession.fs.write("test.txt", "new content");

    // Wait for callbacks to be called
    await new Promise((resolve) => setTimeout(resolve, 2000));
    handle.close();
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
