import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '../../../../lib/db';
import { users } from '../../../../lib/db/schema';

export async function GET(request: NextRequest) {
  try {
    // Get the email from the cookie
    const userEmail = request.cookies.get('user_email')?.value;

    if (!userEmail) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    // Fetch user from the database
    const user = await db.select().from(users).where(eq(users.email, userEmail)).get();

    if (!user) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
      }
    });
  } catch (error) {
    console.error('Auth check error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}