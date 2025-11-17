import { SandboxInstance, VolumeInstance } from '@blaxel/core';
import { NextRequest, NextResponse } from 'next/server';

// GET - Get a single sandbox by name (from Blaxel)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = performance.now();
  console.log('[Sandbox GET] Starting request');

  try {
    // Await params before accessing
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Invalid app name' }, { status: 400 });
    }

    // Get actual sandbox instance from Blaxel
    const sandboxName = id;
    const volumeStartTime = performance.now();
    const volume = await VolumeInstance.createIfNotExists({
      name: `${sandboxName}-volume`,
      displayName: `${sandboxName} Volume`,
      size: 1024,
    });
    console.log('[Sandbox GET] Volume created:', (performance.now() - volumeStartTime).toFixed(2), 'ms');
    const sandboxStartTime = performance.now();
    console.log('[Sandbox GET] Fetching sandbox instance:', sandboxName);
    const sandboxInstance = await SandboxInstance.createIfNotExists({
      name: sandboxName,
      volumes: [{ name: volume.name, mountPath: "/app", readOnly: false }],
      image: "blaxel/nextjs:latest",
      memory: 4096,
      ports: [
        { name: "sandbox-api", target: 8080, protocol: "HTTP" },
        { name: "preview", target: 3000, protocol: "HTTP" },
      ],
      envs: [
        { name: "MORPH_API_KEY", value: process.env.MORPH_API_KEY || "" },
        { name: "MORPH_MODEL", value: process.env.MORPH_MODEL || "morph-v2" },
      ],
    });
    console.log('[Sandbox GET] Sandbox instance fetched:', (performance.now() - sandboxStartTime).toFixed(2), 'ms');

    // Get a session for this sandbox
    const responseHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Blaxel-Workspace, X-Blaxel-Preview-Token, X-Blaxel-Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "Content-Length, X-Request-Id",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    // Handle preview with token and session creation in parallel
    console.log('[Sandbox GET] Starting parallel operations: preview+token and session');
    const parallelStartTime = performance.now();

    const [{ preview, token }, session] = await Promise.all([
      (async () => {
        const previewStartTime = performance.now();
        console.log('[Sandbox GET] Creating preview');

        const preview = await sandboxInstance.previews.createIfNotExists({
          metadata: {
            name: "preview",
          },
          spec: {
            port: 3000,
            public: false,
            responseHeaders,
          }
        });
        console.log('[Sandbox GET] Preview created:', (performance.now() - previewStartTime).toFixed(2), 'ms');

        // Get or create token
        const tokenStartTime = performance.now();
        console.log('[Sandbox GET] Fetching tokens');
        const tokens = await preview.tokens.list();
        const tokenNotExpired = tokens.find((token) => !token.expired);

        if (tokenNotExpired) {
          console.log('[Sandbox GET] Using existing token:', (performance.now() - tokenStartTime).toFixed(2), 'ms');
          return { preview, token: tokenNotExpired };
        }

        console.log('[Sandbox GET] Creating new token');
        const token = await preview.tokens.create(new Date(Date.now() + 1000 * 60 * 60 * 24));
        console.log('[Sandbox GET] Token created:', (performance.now() - tokenStartTime).toFixed(2), 'ms');

        return { preview, token };
      })(),
      (async () => {
        const sessionStartTime = performance.now();
        console.log('[Sandbox GET] Creating session');
        const session = await sandboxInstance.sessions.createIfExpired({
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours
          responseHeaders,
        });
        console.log('[Sandbox GET] Session created:', (performance.now() - sessionStartTime).toFixed(2), 'ms');
        return session;
      })()
    ]);

    console.log('[Sandbox GET] Parallel operations completed:', (performance.now() - parallelStartTime).toFixed(2), 'ms');

    const totalTime = performance.now() - startTime;
    console.log('[Sandbox GET] Request completed successfully. Total time:', totalTime.toFixed(2), 'ms');

    return NextResponse.json({
      metadata: sandboxInstance.metadata,
      status: sandboxInstance.status,
      session: session,
      preview_url: `${preview.spec?.url}?bl_preview_token=${token.value}`
    });
  } catch (error) {
    const totalTime = performance.now() - startTime;
    console.error('[Sandbox GET] Request failed after', totalTime.toFixed(2), 'ms:', error, new Error().stack?.split("\n")[1]);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// DELETE - Delete a sandbox by name (via Blaxel)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Optionally, verify the sandbox belongs to the user if possible
    // For now, just attempt to delete
    try {

      // Await params before accessing
      const { id } = await params;
      if (!id) {
        return NextResponse.json({ error: 'Invalid app name' }, { status: 400 });
      }
      await SandboxInstance.delete(id);
    } catch {
      return NextResponse.json({ error: 'Failed to delete sandbox' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: 'App deleted successfully'
    });
  } catch (error) {
    console.error("Error deleting app:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
