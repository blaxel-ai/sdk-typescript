import { SandboxInstance } from "@blaxel/core"
import { createOrGetSandbox } from "../utils"

const sandboxName = `sandbox-test-stream-logs`

async function main() {
    const sandbox = await createOrGetSandbox({ sandboxName })

    const resultExpected = `Hello, world!
Hello, world!
`
    
    // Start the long-running process
    await sandbox.process.exec({
        name: "test",
        command: "i=1; while [ $i -le 2 ]; do echo \"Hello, world!\"; sleep 31; i=$((i+1)); done",
    })

    let result = ""
    // Use the auto-reconnecting wrapper
    const { close } = await sandbox.process.streamLogs("test", {
        onLog(log) {
            result += log + "\n"
        }
    })
    // Wait for process to finish
    await new Promise(resolve => setTimeout(resolve, 80000))

    console.log("result => ", result)
    console.log("resultExpected => ", resultExpected)
    console.log("result === resultExpected => ", result === resultExpected)
    if (result !== resultExpected) {
        throw new Error("Result does not match expected result")
    }
    
    // Stop the streaming
    close()

    await SandboxInstance.delete(sandboxName)
}

main().catch(console.error)