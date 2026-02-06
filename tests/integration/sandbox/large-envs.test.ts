import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion, waitForVolumeDeletion } from './helpers.js'

describe('Sandbox Large Environment Variables', () => {
  const createdSandboxes: string[] = []
  const createdVolumes: string[] = []

  afterAll(async () => {
    // Clean up sandboxes first and wait for full deletion
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
          await waitForSandboxDeletion(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )

    // Clean up volumes (now safe since sandboxes are fully deleted)
    await Promise.all(
      createdVolumes.map(async (name) => {
        try {
          await VolumeInstance.delete(name)
          await waitForVolumeDeletion(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  // Generate test cases for each 100 char increment from 1000 to 3000
  const charTargets = Array.from({ length: 21 }, (_, i) => 1000 + i * 100)

  // Helper function to generate env vars that reach a target character count
  function generateEnvsForTargetChars(targetChars: number): { name: string; value: string }[] {
    const envs: { name: string; value: string }[] = []
    let currentChars = 0
    let index = 1

    while (currentChars < targetChars) {
      const paddedIndex = String(index).padStart(3, '0')
      const name = `TEST_ENV_VAR_${paddedIndex}`
      const value = `value_${paddedIndex}_padding`

      currentChars += name.length + value.length
      envs.push({ name, value })
      index++
    }

    return envs
  }

  it('creates sandboxes with increasing environment variable sizes (1000-3000 chars, stops on first failure)', async () => {
    const passedTargets: number[] = []

    for (const targetChars of charTargets) {
      const name = uniqueName(`envs-${targetChars}`)
      const envs = generateEnvsForTargetChars(targetChars)

      // Calculate actual total characters
      const totalChars = envs.reduce((sum, env) => sum + env.name.length + env.value.length, 0)
      console.log(`Testing target: ${targetChars}, Actual: ${totalChars}, Env count: ${envs.length}`)

      try {
        const sandbox = await SandboxInstance.create({
          name,
          image: defaultImage,
          envs,
          labels: defaultLabels,
        })
        createdSandboxes.push(name)

        // Verify the sandbox was created with all environment variables
        const retrieved = await SandboxInstance.get(name)
        expect(retrieved.spec.runtime?.envs?.length).toBe(envs.length)

        // Verify first and last environment variables are actually set in the sandbox
        const firstEnv = envs[0]
        const checkFirst = await sandbox.process.exec({
          command: `echo $${firstEnv.name}`,
          waitForCompletion: true
        })
        expect(checkFirst.logs?.trim()).toBe(firstEnv.value)

        const lastEnv = envs[envs.length - 1]
        const checkLast = await sandbox.process.exec({
          command: `echo $${lastEnv.name}`,
          waitForCompletion: true
        })
        expect(checkLast.logs?.trim()).toBe(lastEnv.value)

        // Verify total count of TEST_ENV_VAR_ variables in the environment
        const countResult = await sandbox.process.exec({
          command: "printenv | grep -c TEST_ENV_VAR_",
          waitForCompletion: true
        })
        expect(parseInt(countResult.logs?.trim() || "0")).toBe(envs.length)

        passedTargets.push(targetChars)
        console.log(`✓ Passed: ${targetChars} chars (${envs.length} env vars)`)
      } catch (error) {
        console.log(`✗ Failed at ${targetChars} chars (${envs.length} env vars)`)
        console.log(`Passed targets before failure: ${passedTargets.join(', ') || 'none'}`)
        throw error
      }
    }

    console.log(`All ${charTargets.length} targets passed: ${passedTargets.join(', ')}`)
  })

  it('creates a sandbox with large environment variables (4000 chars) and a volume, then verifies persistence', async () => {
    const sandboxName1 = uniqueName("envs-volume-1")
    const sandboxName2 = uniqueName("envs-volume-2")
    const volumeName = uniqueName("volume-envs")
    const targetChars = 4000
    const envs = generateEnvsForTargetChars(targetChars)

    // Calculate actual total characters
    const totalChars = envs.reduce((sum, env) => sum + env.name.length + env.value.length, 0)
    console.log(`Target: ${targetChars}, Actual: ${totalChars}, Env count: ${envs.length}`)
    expect(totalChars).toBeGreaterThanOrEqual(targetChars)

    // Create a volume first
    const volume = await VolumeInstance.create({
      name: volumeName,
      size: 1024, // 1GB
      region: defaultRegion,
      labels: defaultLabels,
    })
    createdVolumes.push(volumeName)
    expect(volume.name).toBe(volumeName)

    // Create first sandbox with large envs and volume attached
    const sandbox1 = await SandboxInstance.create({
      name: sandboxName1,
      image: defaultImage,
      region: defaultRegion,
      envs,
      volumes: [
        {
          name: volumeName,
          mountPath: "/data",
          readOnly: false
        }
      ],
      labels: defaultLabels,
    })

    // Verify the sandbox was created with all environment variables
    const retrieved = await SandboxInstance.get(sandboxName1)
    expect(retrieved.spec.runtime?.envs?.length).toBe(envs.length)

    // Verify environment variables are set in the sandbox
    const firstEnv = envs[0]
    const checkFirst = await sandbox1.process.exec({
      command: `echo $${firstEnv.name}`,
      waitForCompletion: true
    })
    expect(checkFirst.logs?.trim()).toBe(firstEnv.value)

    const lastEnv = envs[envs.length - 1]
    const checkLast = await sandbox1.process.exec({
      command: `echo $${lastEnv.name}`,
      waitForCompletion: true
    })
    expect(checkLast.logs?.trim()).toBe(lastEnv.value)

    // Verify total count of TEST_ENV_VAR_ variables
    const countResult = await sandbox1.process.exec({
      command: "printenv | grep -c TEST_ENV_VAR_",
      waitForCompletion: true
    })
    expect(parseInt(countResult.logs?.trim() || "0")).toBe(envs.length)

    // Write persistent data to the volume
    const persistentData = "persistent_data_from_first_sandbox_12345"
    const writeResult = await sandbox1.process.exec({
      command: `echo '${persistentData}' > /data/persistent.txt && cat /data/persistent.txt`,
      waitForCompletion: true
    })
    expect(writeResult.logs?.trim()).toBe(persistentData)

    // Verify volume mount point exists
    const mountCheck = await sandbox1.process.exec({
      command: "df -h /data | tail -1 | awk '{print $6}'",
      waitForCompletion: true
    })
    expect(mountCheck.logs?.trim()).toBe("/data")

    // Delete the first sandbox and wait for full deletion
    await SandboxInstance.delete(sandboxName1)
    await waitForSandboxDeletion(sandboxName1)
    console.log(`First sandbox ${sandboxName1} deleted, creating second sandbox to verify volume persistence`)

    // Create second sandbox with the same volume (also with large envs)
    const sandbox2 = await SandboxInstance.create({
      name: sandboxName2,
      image: defaultImage,
      region: defaultRegion,
      envs,
      volumes: [
        {
          name: volumeName,
          mountPath: "/data",
          readOnly: false
        }
      ],
      labels: defaultLabels,
    })
    createdSandboxes.push(sandboxName2)

    // Verify the second sandbox also has all environment variables
    const retrieved2 = await SandboxInstance.get(sandboxName2)
    expect(retrieved2.spec.runtime?.envs?.length).toBe(envs.length)

    // Verify environment variables are set in the second sandbox
    const checkFirst2 = await sandbox2.process.exec({
      command: `echo $${firstEnv.name}`,
      waitForCompletion: true
    })
    expect(checkFirst2.logs?.trim()).toBe(firstEnv.value)

    // Verify the persistent data from the first sandbox is still there
    const readResult = await sandbox2.process.exec({
      command: "cat /data/persistent.txt",
      waitForCompletion: true
    })
    expect(readResult.logs?.trim()).toBe(persistentData)
    console.log(`Volume persistence verified: data written by first sandbox is readable in second sandbox`)
  })

  it('fails to write a 2MB file to /var/secrets/bl-env (limit is 1MB)', async () => {
    const name = uniqueName("secrets-limit")

    // Create sandbox with large environment variables so /var/secrets/bl-env is created
    const targetChars = 4000
    const envs = generateEnvsForTargetChars(targetChars)
    const totalChars = envs.reduce((sum, env) => sum + env.name.length + env.value.length, 0)
    console.log(`Creating sandbox with ${envs.length} env vars (${totalChars} chars) to trigger /var/secrets/bl-env creation`)

    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      envs,
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    // Check that /var/secrets/bl-env exists (should be created due to large envs)
    const secretsCheck = await sandbox.process.exec({
      command: "ls -la /var/secrets 2>&1",
      waitForCompletion: true
    })
    console.log(`/var/secrets contents: ${secretsCheck.logs}`)

    const blEnvCheck = await sandbox.process.exec({
      command: "ls -la /var/secrets/bl-env 2>&1",
      waitForCompletion: true
    })
    console.log(`/var/secrets/bl-env contents: ${blEnvCheck.logs}`)

    // Check disk usage before writing - this should show the secrets volume
    const diskUsageBefore = await sandbox.process.exec({
      command: "df -h /var/secrets/bl-env 2>&1",
      waitForCompletion: true
    })
    console.log(`Disk usage of /var/secrets/bl-env before write: ${diskUsageBefore.logs}`)

    // Try to write a 2MB file (2 * 1024 * 1024 = 2097152 bytes) - should fail due to 1MB limit
    const twoMBInBytes = 2 * 1024 * 1024
    const writeResult = await sandbox.process.exec({
      command: `dd if=/dev/zero of=/var/secrets/bl-env/large-file.bin bs=1024 count=2048 2>&1; echo "Exit code: $?"`,
      waitForCompletion: true
    })
    console.log(`Write 2MB file result: ${writeResult.logs}`)

    // Check the actual size of what was written (should be limited to ~1MB or fail)
    const sizeCheck = await sandbox.process.exec({
      command: "ls -l /var/secrets/bl-env/large-file.bin 2>&1 || echo 'File does not exist'",
      waitForCompletion: true
    })
    console.log(`File size check: ${sizeCheck.logs}`)

    // Check disk usage after writing
    const diskUsageAfter = await sandbox.process.exec({
      command: "df -h /var/secrets/bl-env 2>&1",
      waitForCompletion: true
    })
    console.log(`Disk usage of /var/secrets/bl-env after write: ${diskUsageAfter.logs}`)

    // The write should either fail or be truncated - we expect the file to not be 2MB
    // Parse the file size from ls -l output (format: -rw-r--r-- 1 root root SIZE date filename)
    const sizeMatch = sizeCheck.logs?.match(/-[\w-]+\s+\d+\s+\w+\s+\w+\s+(\d+)/)
    if (sizeMatch) {
      const fileSize = parseInt(sizeMatch[1])
      console.log(`Actual file size: ${fileSize} bytes`)
      // File should be less than 2MB due to the 1MB limit
      expect(fileSize).toBeLessThan(twoMBInBytes)
    } else {
      // If file doesn't exist or write failed completely, that's also acceptable
      console.log(`Write was rejected or file was not created`)
      expect(sizeCheck.logs).toMatch(/No such file|does not exist|No space|cannot/i)
    }
  })
})
