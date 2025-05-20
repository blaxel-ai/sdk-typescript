import { SandboxInstance } from '@blaxel/core';
import { and, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { createOrGetSandbox } from '../../../../../../utils';
import { db } from '../../../lib/db';
import { sandboxes, users } from '../../../lib/db/schema';

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

// GET - List all sandboxes for the authenticated user
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const userSandboxes = await db.select().from(sandboxes).where(eq(sandboxes.userId, user.id)).all();

    return NextResponse.json({
      sandboxes: userSandboxes
    });
  } catch (error) {
    console.error("Error listing sandboxes:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// POST - Create a new sandbox
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Get request data
    const data = await request.json();
    const { name, description } = data;

    if (!name) {
      return NextResponse.json({ error: 'Sandbox name is required' }, { status: 400 });
    }

    // Check if sandbox with this name already exists for this user
    const existingSandbox = await db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.userId, user.id), eq(sandboxes.name, name)))
      .get();

    if (existingSandbox) {
      return NextResponse.json({ error: 'Sandbox with this name already exists' }, { status: 400 });
    }

    // Create sandbox instance using Blaxel SDK
    const sandboxName = getName(`${user.email.split('@')[0]}-${name}`);
    const sandboxCreated = await createOrGetSandbox(sandboxName);

    // Create sandbox in database
    const newSandbox = await db
      .insert(sandboxes)
      .values({
        name: sandboxCreated.metadata?.name || '',
        description,
        userId: user.id,
      })
      .returning()
      .get();


    return NextResponse.json({
      sandbox: newSandbox,
      sandboxName
    });
  } catch (error) {
    console.error("Error creating sandbox:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// DELETE - Delete a sandbox by ID
export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Get sandbox ID from URL
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

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

    try {
      const sandboxName = getName(`${existingSandbox.name}`);
      console.log(sandboxName);
      await SandboxInstance.delete(sandboxName);
    } catch {
    }

    // Delete from database
    await db
      .delete(sandboxes)
      .where(eq(sandboxes.id, parseInt(id)))
      .run();

    // Note: We're not deleting the actual sandbox instance from Blaxel
    // as it might need special cleanup that we don't have access to

    return NextResponse.json({
      success: true,
      message: 'Sandbox deleted successfully'
    });
  } catch (error) {
    console.error("Error deleting sandbox:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}