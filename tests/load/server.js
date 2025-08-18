import { SandboxInstance, createAgent, deleteAgent, listAgents } from '@blaxel/core';
import express from 'express';
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;

// Create sandbox endpoint
app.post('/sandboxes', async (req, res) => {
  const startTime = Date.now();

  try {
    const sandbox = await SandboxInstance.create({ image: 'blaxel/dev-base:latest'});
    const duration = Date.now() - startTime;

    res.json({
      success: true,
      sandboxName: sandbox.metadata.name,
      duration
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    });
  }
});

app.delete('/sandboxes', async (req, res) => {
  try {
    const sandboxes = await SandboxInstance.list();
    const batchSize = 20;
    for (let i = 0; i < sandboxes.length; i += batchSize) {
      const batch = sandboxes.slice(i, i + batchSize);
      console.log(`Deleting batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(sandboxes.length/batchSize)} (${batch.length} sandboxes)`);
      // Process batch synchronously
      await Promise.all(batch.map(async (sandbox) => {
        await SandboxInstance.delete(sandbox.metadata.name);
      }));
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/agents', async (req, res) => {
  const startTime = Date.now();

  try {
    const response = await createAgent({
      body: {
        metadata: {
          name: `agent-${uuidv4().replace(/-/g, '').substring(0, 8)}`
        },
        spec: {
          runtime: {
            image: 'agent/agent-test:sz6st9v2cp51',
            generation: 'mk3',
            memory: 4096,
          }
        }
      }
    });
    const duration = Date.now() - startTime;
    const agent = response.data
    if (!agent) {
      console.error(`Failed to create agent: ${response.response.status} ->`)
      console.error(response.error)
      throw new Error(`Failed to create agent: ${response.response.status}`);
    }
    res.json({
      success: true,
      agentName: agent.metadata.name,
      duration
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    });
  }
});
app.delete('/agents', async (req, res) => {
  const response = await listAgents();
  await Promise.all(response.data.map(async (agent) => {
    await deleteAgent({ path: { agentName: agent.metadata.name } });
  }));
  res.json({ success: true });
});
app.listen(PORT, async () => {
  await SandboxInstance.list()
  console.log("Health check: OK")
  console.log(`Sandbox API server running on http://localhost:${PORT}`);
});