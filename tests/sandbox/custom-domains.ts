import { createOrGetSandbox } from "../utils";

const sandboxName = "next-js-2"

async function main() {
  try {
    // Test with controlplane
    const sandbox = await createOrGetSandbox({ sandboxName })
    // Verify the files were copied by listing the directory in the sandbox
    console.log('Sandbox directory contents:');
    console.log(await sandbox.fs.ls('/blaxel'));
    const preview = await sandbox.previews.createIfNotExists({
      metadata: {
        name: "preview-test-public"
      },
      spec: {
        port: 443,
        public: true
      }
    })
    console.log(`Preview without custom domain: ${preview.spec?.url}`)
    const previewWithCustomDomain = await sandbox.previews.createIfNotExists({
      metadata: {
        name: "preview-test-custom-domain"
      },
      spec: {
        port: 443,
        customDomain: 'prod-3.mathis.beamlit.dev',
        public: true
      }
    })
    console.log(`Preview with custom domain: ${previewWithCustomDomain.spec?.url}`)
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
