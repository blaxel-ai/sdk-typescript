import { SandboxInstance } from "@blaxel/core";

const BL_ENV = process.env.BL_ENV || "prod";
const BL_REGION = process.env.BL_REGION || (BL_ENV === "dev" ? "eu-dub-1" : "us-pdx-1");

async function main() {
  try {
    const startTime = Date.now();
    const randomSandboxName = `sandbox-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const sandboxStartTime = Date.now();
    const sandbox = await SandboxInstance.create({
      name: randomSandboxName,
      image: "blaxel/node:latest",
      memory: 4096,
      region: BL_REGION,
      ports: [{ target: 3000, protocol: "HTTP" }],   // ports to expose
    });
    const sandboxTime = Date.now() - sandboxStartTime;
    console.log(`Sandbox creation: ${sandboxTime}ms`);

    const previewStartTime = Date.now();
    const preview = await sandbox.previews.create({
      metadata: {
        name: "preview-test"
      },
      spec: {
        port: 3000,
        public: false,
        responseHeaders: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Blaxel-Workspace, X-Blaxel-Preview-Token, X-Blaxel-Authorization",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Expose-Headers": "Content-Length, X-Request-Id",
          "Access-Control-Max-Age": "86400",
        }
      }
    });
    const previewTime = Date.now() - previewStartTime;
    console.log(`Preview creation: ${previewTime}ms`);

    const tokenStartTime = Date.now();
    const token = await preview.tokens.create(new Date(Date.now() + 1000 * 60 * 60 * 24));
    const tokenTime = Date.now() - tokenStartTime;
    console.log(`Token creation: ${tokenTime}ms`);

    const lsStartTime = Date.now();
    await sandbox.fs.ls("/");
    const lsTime = Date.now() - lsStartTime;
    console.log(`LS: ${lsTime}ms`);

    const fileWriteStartTime = Date.now();
    await sandbox.fs.write("/tmp/server.js", `const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hello world');
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Server running on port 3000');
});
`);
    const fileWriteTime = Date.now() - fileWriteStartTime;
    console.log(`File write: ${fileWriteTime}ms`);

    const serverStartTime = Date.now();
    await sandbox.process.exec({
      name: "hello-server",
      command: "node /tmp/server.js",
      waitForPorts: [3000],
    });
    const serverTime = Date.now() - serverStartTime;
    console.log(`Server start: ${serverTime}ms`);

    const previewUrl = preview.spec?.url;
    const urlWithToken = `${previewUrl}?bl_preview_token=${token.value}`;
    const totalTime = Date.now() - startTime;
    console.log(`Total time: ${totalTime}ms`);
    console.log(urlWithToken);
  } catch (e) {
    console.error("There was an error => ", e);
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

