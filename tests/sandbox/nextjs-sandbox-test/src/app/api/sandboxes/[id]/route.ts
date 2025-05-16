import { db } from '@/lib/db';
import { sandboxes, users } from '@/lib/db/schema';
import { and, eq, not } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { createOrGetSandbox } from '../../../../../../../utils';

// Helper function to get authenticated user
async function getAuthenticatedUser(request: NextRequest) {
  const userEmail = request.cookies.get('user_email')?.value;

  if (!userEmail) {
    return null;
  }

  const user = await db.select().from(users).where(eq(users.email, userEmail)).get();
  return user;
}

function getName(name: string) {
  if (name.length > 32) {
    return name.slice(0, 32);
  }
  return name;
}

// GET - Get a single sandbox by ID
export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ error: 'Invalid sandbox ID' }, { status: 400 });
    }

    // Verify the sandbox belongs to the user
    const sandbox = await db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.userId, user.id), eq(sandboxes.id, parseInt(id))))
      .get();

    if (!sandbox) {
      return NextResponse.json({ error: 'Sandbox not found or you do not have permission' }, { status: 404 });
    }

    // Update last accessed timestamp
    await db
      .update(sandboxes)
      .set({ lastAccessedAt: new Date() })
      .where(eq(sandboxes.id, sandbox.id))
      .run();

    // Get actual sandbox instance from Blaxel
    const sandboxName = getName(`${sandbox.name}`);
    const sandboxInstance = await createOrGetSandbox(sandboxName);

    // Get a session for this sandbox
    const responseHeaders = {
      "Access-Control-Allow-Origin": "http://localhost:3000",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Blaxel-Workspace, X-Blaxel-Preview-Token, X-Blaxel-Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "Content-Length, X-Request-Id",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };


    // Handle preview
    const previews = await sandboxInstance.previews.list();
    let preview;

    if (previews.length > 0) {
      preview = previews[0];
    } else {
      preview = await sandboxInstance.previews.create({
        metadata: {
          name: "preview",
        },
        spec: {
          port: 3000,
          public: true,
          responseHeaders,
        }
      });
    }

    // First, list all sessions
    const allSessions = await sandboxInstance.sessions.list();
    // Variable to hold our final session
    let sessionData;

    // If no valid session exists, create a new one
    if (allSessions.length > 0) {
      sessionData = allSessions[0]
    } else {
      // Create a new session
      sessionData = await sandboxInstance.sessions.create({
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours
        responseHeaders,
      });
    }

    return NextResponse.json({
      sandbox,
      session: sessionData,
      preview_url: preview.spec?.url
    });
  } catch (error) {
    console.error("Error getting sandbox:", error, new Error().stack?.split("\n")[1]);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// PUT - Update a sandbox
export async function PUT(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id } = context.params;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ error: 'Invalid sandbox ID' }, { status: 400 });
    }

    // Verify the sandbox belongs to the user
    const existingSandbox = await db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.userId, user.id), eq(sandboxes.id, parseInt(id))))
      .get();

    if (!existingSandbox) {
      return NextResponse.json({ error: 'Sandbox not found or you do not have permission' }, { status: 404 });
    }

    // Get updated data
    const data = await request.json();
    const { name, description } = data;

    if (name && name !== existingSandbox.name) {
      // Check if a sandbox with the new name already exists for this user
      const nameExists = await db
        .select()
        .from(sandboxes)
        .where(and(
          eq(sandboxes.userId, user.id),
          eq(sandboxes.name, name),
          not(eq(sandboxes.id, parseInt(id)))
        ))
        .get();

      if (nameExists) {
        return NextResponse.json({ error: 'Sandbox with this name already exists' }, { status: 400 });
      }
    }

    // Update sandbox
    const updatedSandbox = await db
      .update(sandboxes)
      .set({
        name: name || existingSandbox.name,
        description: description !== undefined ? description : existingSandbox.description,
        lastAccessedAt: new Date()
      })
      .where(eq(sandboxes.id, parseInt(id)))
      .returning()
      .get();

    return NextResponse.json({
      sandbox: updatedSandbox
    });
  } catch (error) {
    console.error("Error getting sandbox:", error, new Error().stack?.split("\n")[1]);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}