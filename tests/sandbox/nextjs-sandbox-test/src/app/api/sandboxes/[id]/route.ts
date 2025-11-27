import { createOrGetSandbox } from '@/lib/sandboxes';
import { SandboxInstance } from '@blaxel/core';
import { NextRequest, NextResponse } from 'next/server';

// GET - Get a single sandbox by name (from Blaxel)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Await params before accessing
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Invalid app name' }, { status: 400 });
    }
    // Get actual sandbox instance from Blaxel
    const sandboxName = id;
    const sandboxInstance = await createOrGetSandbox({sandboxName});

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

    // Handle preview
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
    const token = await preview.tokens.create(new Date(Date.now() + 1000 * 60 * 60 * 24))

    // First, list all sessions
    const session = await sandboxInstance.sessions.createIfExpired({
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours
      responseHeaders,
    });

    return NextResponse.json({
      metadata: sandboxInstance.metadata,
      status: sandboxInstance.status,
      session: session,
      preview_url: `${preview.spec?.url}?bl_preview_token=${token.value}`
    });
  } catch (error) {
    console.error("Error getting sandbox:", error, new Error().stack?.split("\n")[1]);
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
