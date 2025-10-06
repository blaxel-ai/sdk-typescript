import { createOrGetSandbox } from '@/lib/sandboxes';
import { SandboxInstance } from '@blaxel/core';
import { NextRequest, NextResponse } from 'next/server';

function getName(name: string) {
  if (name.length > 32) {
    return name.slice(0, 32);
  }
  return name;
}

// GET - List all sandboxes (from Blaxel)
export async function GET(request: NextRequest) {
  try {
    const sandboxesInstances = await SandboxInstance.list();
    const sandboxes = sandboxesInstances.map((sandbox) => ({
      metadata: {
        name: sandbox.metadata?.name,
      },
      status: sandbox.status,
    }));
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
    // Get request data
    const data = await request.json();
    const { name } = data;

    if (!name) {
      return NextResponse.json({ error: 'App name is required' }, { status: 400 });
    }

    // Create sandbox instance using Blaxel SDK
    const sandboxName = getName(`${name}`);
    const sandboxCreated = await createOrGetSandbox({sandboxName});

    return NextResponse.json({
      sandbox: sandboxCreated,
      sandboxName
    });
  } catch (error) {
    console.error("Error creating sandbox:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

