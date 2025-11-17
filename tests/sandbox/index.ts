import { Directory, SandboxInstance, settings } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-3"

async function testFilesystem(sandbox: SandboxInstance) {
  const user = process.env.USER;
  await sandbox.fs.write(`/Users/${user}/Downloads/test`, "Hello world");
  const content = await sandbox.fs.read(`/Users/${user}/Downloads/test`);
  if (content !== "Hello world") {
    throw new Error("File content is not correct");
  }
  const dir = await sandbox.fs.ls(`/Users/${user}/Downloads`);
  if (dir.files?.length && dir.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  if (!dir.files?.find((f) => f.path === `/Users/${user}/Downloads/test`)) {
    throw new Error("File not found in directory");
  }

  await sandbox.fs.mkdir(`/Users/${user}/Downloads/test2`);
  const afterMkdir = await sandbox.fs.ls(`/Users/${user}/Downloads/test2`) as Directory;
  if (afterMkdir.files?.length && afterMkdir.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  await sandbox.fs.cp(`/Users/${user}/Downloads/test`, `/Users/${user}/Downloads/test2/test`);
  const afterCpLs = await sandbox.fs.ls(`/Users/${user}/Downloads/test2`);
  if (afterCpLs.files?.length && afterCpLs.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  if (!afterCpLs.files?.find((f) => f.path === `/Users/${user}/Downloads/test2/test`)) {
    throw new Error("File not found in directory");
  }
  await sandbox.fs.read(`/Users/${user}/Downloads/test2/test`)
  if (content !== "Hello world") {
    throw new Error("File content is not correct");
  }
  await sandbox.fs.cp(`/blaxel`, `/blaxel2`);
  const afterCpLs2 = await sandbox.fs.ls(`/blaxel2`);
  if (afterCpLs2.files?.length && afterCpLs2.files?.length < 1) {
    throw new Error("Directory is empty");
  }

  await sandbox.fs.rm(`/Users/${user}/Downloads/test`);
  try {
    await sandbox.fs.rm(`/Users/${user}/Downloads/test2`);
  } catch (e) {
    console.log("That is expected => ", e.error);
  }
  await sandbox.fs.rm(`/Users/${user}/Downloads/test2`, true);
}

async function testProcess(sandbox: SandboxInstance) {
  const process = await sandbox.process.exec({
    name: "test",
    command: "echo 'Hello world'",
  });
  if (process.status === "completed") {
    throw new Error("Process did complete without waiting");
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const completedProcess = await sandbox.process.get("test");
  if (completedProcess.status !== "completed") {
    throw new Error("Process did not complete");
  }
  const logs = await sandbox.process.logs("test");
  if (logs != 'Hello world\n') {
    throw new Error("Logs are not correct");
  }
  try {
    await sandbox.process.kill("test");
  } catch (e) {
    console.log("That is expected => ", e.error);
  }
}

async function testPreviewPublic(sandbox: SandboxInstance) {
  try {
    await sandbox.previews.create({
      metadata: {
        name: "preview-test-public"
      },
      spec: {
        port: 443,
        prefixUrl: "small-prefix",
        public: true
      }
    })
    const previews = await sandbox.previews.list()
    if (previews.length < 1) {
      throw new Error("No previews found");
    }
    const preview = await sandbox.previews.get("preview-test-public")
    if (preview.name !== "preview-test-public") {
      throw new Error("Preview name is not correct");
    }
    const url = preview.spec?.url
    if (!url) {
      throw new Error("Preview URL is not correct");
    }
    if (settings.env === "dev") {
      if (url !== `https://small-prefix-${settings.workspace}.preview.blaxel.dev`) {
        throw new Error(`Preview URL is not correct => ${url}`);
      }
    } else {
      if (url !== `https://small-prefix-${settings.workspace}.preview.bl.run`) {
        throw new Error(`Preview URL is not correct => ${url}`);
      }
    }
    const response = await fetch(`${url}/health`)
    if (response.status !== 200) {
      throw new Error(`Preview is not working => ${response.status}:${await response.text()}`);
    }
    console.log("Preview is healthy :)")
  } catch (e) {
    console.log("ERROR IN PREVIEWS NOT EXPECTED => ", e);
  } finally {
    // await sandbox.previews.delete("preview-test-public")
  }
  }

async function testPreviewToken(sandbox: SandboxInstance) {
  try {
    const preview = await sandbox.previews.create({
      metadata: {
        name: "preview-test-private"
      },
      spec: {
        port: 443,
        public: false
      }
    })
    const url = preview.spec?.url
    if (!url) {
      throw new Error("Preview URL is not correct");
    }
    const retrievedPreview = await sandbox.previews.get("preview-test-private")
    console.log(`Retrieved preview => url = ${retrievedPreview.spec?.url}`)
    const token = await preview.tokens.create(new Date(Date.now() + 1000 * 60 * 10)) // 10 minutes expiration
    console.log("Token created => ", token.value)
    const tokens = await preview.tokens.list()
    if (tokens.length < 1) {
      throw new Error("No tokens found");
    }
    console.log("Tokens =>")
    console.log(JSON.stringify(tokens, null, 2))
    console.log("Token value => ", token.value)
    if (!tokens.find((t) => t.value === token.value)) {
      throw new Error("Token not found in list");
    }
    console.log("Token created => ", token.value)
    const response = await fetch(`${url}/health`)
    if (response.status !== 401) {
      throw new Error(`Preview is not protected by token, response => ${response.status}`);
    }

    const responseWithToken = await fetch(`${url}/health?bl_preview_token=${token.value}`)
    if (responseWithToken.status !== 200) {
      throw new Error(`Preview is not working with token, response => ${responseWithToken.status}`);
    }
    console.log("Preview is healthy with token :)")
    // await preview.tokens.delete(token.value)
  } catch (e) {
    console.log("ERROR IN PREVIEWS NOT EXPECTED => ", e);
  } finally {
    // await sandbox.previews.delete("preview-test-private")
  }
}

async function testPreviews(sandbox: SandboxInstance) {
  await testPreviewPublic(sandbox)
  await testPreviewToken(sandbox)
}

// Test process.exec with onLog, onStdout, and onStderr handlers
async function testProcessLogs(sandbox: SandboxInstance) {
  let logCalled = false;
  let stdoutCalled = false;
  let stderrCalled = false;
  let logOutput = '';
  let stdoutOutput = '';
  let stderrOutput = '';

  // This command will output to both stdout and stderr 5 times with a 5 second sleep between each
  const command = `sh -c 'for i in $(seq 1 5); do echo "Hello from stdout $i"; echo "Hello from stderr $i" 1>&2; sleep 1; done'`;

  const name = "test-2"
  await sandbox.process.exec(
    {
      command,
      name,
    },
  );
  const stream = sandbox.process.streamLogs(name, {
    onLog: (log) => {
      logCalled = true;
      console.log("onLog", log);

      logOutput += log + '\n';
    },
    onStdout: (stdout) => {
      stdoutCalled = true;
      console.log("onStdout", stdout);
      stdoutOutput += stdout + '\n';
    },
    onStderr: (stderr) => {
      stderrCalled = true;
      console.log("onStderr", stderr);
      stderrOutput += stderr + '\n';
    },
  })

  await sandbox.process.wait(name)

  stream.close();

  // Check that all handlers were called and received the expected output
  if (!logCalled) throw new Error("onLog was not called");
  if (!stdoutCalled) throw new Error("onStdout was not called");
  if (!stderrCalled) throw new Error("onStderr was not called");
  if (!logOutput.includes("Hello from stdout") || !logOutput.includes("Hello from stderr")) {
    throw new Error(`onLog did not receive expected output: ${logOutput}`);
  }
  if (!stdoutOutput.includes("Hello from stdout")) {
    throw new Error(`onStdout did not receive expected output: ${stdoutOutput}`);
  }
  if (!stderrOutput.includes("Hello from stderr")) {
    throw new Error(`onStderr did not receive expected output: ${stderrOutput}`);
  }
  console.log("testProcessLogs passed");
}

// Test the watch functionality of SandboxFileSystem
async function testWatch(sandbox: SandboxInstance) {
  try {
    const user = process.env.USER;
    const testDir = `/Users/${user}/Downloads/watchtest`;
    const testFile = `${testDir}/file.txt`;

    // Ensure correct type for fs
    const fs = sandbox.fs;

    // Clean up before test
    try { await fs.rm(testDir, true); } catch {}
    await fs.mkdir(testDir);

    let callbackCalled = false;
    let callbackWithContentCalled = false;

    // Watch without content
    const handle = fs.watch(testDir, (fileEvent) => {
      if (fileEvent.name === "file.txt") {
        callbackCalled = true;
      }
    });

    // Watch with content
    const handleWithContent = fs.watch(
      testDir,
      (fileEvent) => {
        if (fileEvent.name === "file.txt" && fileEvent.content === "new content") {
          callbackWithContentCalled = true;
        }
      },
      {
        onError: (error) => {
          console.error(error);
        },
        withContent: true
      }
    );

    // Trigger a file change
    await fs.write(testFile, "new content");

    // Wait for callbacks to be called
    await new Promise((resolve) => setTimeout(resolve, 2000));

    handle.close();
    handleWithContent.close();

    // Clean up after test
    await fs.rm(testDir, true);

    if (!callbackCalled) {
      throw new Error("Watch callback (without content) was not called");
    }
    if (!callbackWithContentCalled) {
      throw new Error("Watch callback (with content) was not called or content was incorrect");
    }
    console.log("testWatch passed");
  } catch (e) {
    console.error("There was an error => ", e);
  }
}

async function main() {
  try {
    // Test with controlplane
    const sandbox = await createOrGetSandbox({sandboxName, memory: 8096})

    await testFilesystem(sandbox);
    await testProcess(sandbox);
    await testPreviews(sandbox);
    await testWatch(sandbox);
    await testProcessLogs(sandbox);
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
    console.log("Deleting sandbox");
    // await SandboxInstance.delete(sandboxName)
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
