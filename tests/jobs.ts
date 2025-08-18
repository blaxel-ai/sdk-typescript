async function execJob() {
  console.log("Executing job");
  const WORKSPACE = "YOUR_WORKSPACE_NAME"; // ex : my-workspace (not the display name)
  const JOB_NAME = "YOUR_JOB_NAME"; // ex : my-job (not the display name)
  const response = await fetch(`https://run.blaxel.ai/${WORKSPACE}/jobs/${JOB_NAME}/executions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Blaxel-Authorization': `Bearer ${process.env.BL_API_KEY}`, // You can go to ApiKey from UI to generate one
      'X-Blaxel-Workspace': WORKSPACE
    },
    body: JSON.stringify({
      tasks: [
        { name: "John" },
        { name: "Jane" }
      ]
    })
  });
  if(response.status !== 200) {
    console.error(`Failed to execute job : ${response.statusText}`);
    return;
  }
  const result = await response.json();
  console.log(result);
}

execJob().catch(console.error);
