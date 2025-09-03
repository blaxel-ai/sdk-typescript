import { SandboxInstance } from "@blaxel/core"

async function main() {
    const sandbox = await SandboxInstance.create()
    console.log("sandbox created => ", sandbox.metadata!.name)

    const resultExpected = `Hello, world!
Hello, world!
Hello, world!
Hello, world!
Hello, world!
Hello, world!
`

    // Start the long-running process
    await sandbox.process.exec({
        name: "test",
        command: `i=1; while [ $i -le 3 ]; do echo "Hello, world!"; sleep 31; echo "Hello, world!"; i=$((i+1)); done`,
    })

    let result = ""
    // Use the auto-reconnecting wrapper
    const { close } = await sandbox.process.streamLogs("test", {
        onLog(log) {
            console.log(`received log => ${log}`)
            result += log + "\n"
        }
    })
    // Wait for process to finish
    await sandbox.process.wait("test", { maxWait: 1000000 })

    console.log("\nresult => ", result)
    console.log("resultExpected => ", resultExpected)
    console.log("result === resultExpected => ", result === resultExpected)
    if (result !== resultExpected) {
        throw new Error("Result does not match expected result")
    }

    // Stop the streaming
    close()

    await SandboxInstance.delete(sandbox.metadata!.name!)
}

main().catch(console.error)