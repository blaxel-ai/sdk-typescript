import { NextResponse } from 'next/server';
import { createOrGetSandbox } from '../../../../../../utils';

const SANDBOX_NAME = 'sandbox-test-3';

const responseHeaders = {
  "Access-Control-Allow-Origin": "http://localhost:3000",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Blaxel-Workspace, X-Blaxel-Preview-Token, X-Blaxel-Authorization",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Expose-Headers": "Content-Length, X-Request-Id",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
}
export async function GET() {
  try {
    const sandbox = await createOrGetSandbox(SANDBOX_NAME);

    // Here we clean all sessions and previews to test from the begining
    const sessions = await sandbox.sessions.list();
    for (const session of sessions) {
      await sandbox.sessions.delete(session.name);
    }
    const previews = await sandbox.previews.list();
    for (const preview of previews) {
      await sandbox.previews.delete(preview.name);
    }


    const session = await sandbox.sessions.create({
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      responseHeaders,
    });

    const preview = await sandbox.previews.create({
      metadata: {
        name: "preview",
      },
      spec: {
        port: 3000,
        public: true,
        responseHeaders,
      }
    });
    return NextResponse.json({session, preview_url: preview.spec?.url });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}