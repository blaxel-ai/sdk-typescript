import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createOrGetSandbox } from '@/lib/sandboxes';
import { SandboxInstance } from '@blaxel/core';
import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

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

// GET - List all sandboxes for the authenticated user (from Blaxel)
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    // List all sandboxes from Blaxel
    const sandboxesInstances = await SandboxInstance.list();
    const sandboxes = sandboxesInstances.map((sandbox) => ({
      metadata: {
        name: sandbox.metadata?.name,
      },
      status: sandbox.status,
    }));
    // Optionally filter by user if Blaxel supports user association
    // For now, return all sandboxes
    return NextResponse.json({
      sandboxes
    });
  } catch (error) {
    console.error("Error listing sandboxes:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// POST - Create a new sandbox (via Blaxel)
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Get request data
    const data = await request.json();
    const { name } = data;

    if (!name) {
      return NextResponse.json({ error: 'Sandbox name is required' }, { status: 400 });
    }

    // Create sandbox instance using Blaxel SDK
    const sandboxName = getName(`${user.email.split('@')[0]}-${name}`);
    const sandboxCreated = await createOrGetSandbox(sandboxName, false);

    return NextResponse.json({
      sandbox: sandboxCreated,
      sandboxName
    });
  } catch (error) {
    console.error("Error creating sandbox:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

