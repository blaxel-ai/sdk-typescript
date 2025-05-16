import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '../../../../lib/db';
import { users } from '../../../../lib/db/schema';

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    // Simple validation for email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
    }

    // Check if user exists
    let user = await db.select().from(users).where(eq(users.email, email)).get();

    // If user doesn't exist, create one
    if (!user) {
      // Create a unique sandbox name for the user based on email

      const newUser = await db.insert(users).values({
        email,
      }).returning().get();

      user = newUser;
    }

    // Create a response
    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
      }
    });

    // Set a cookie for the authenticated user
    response.cookies.set('user_email', email, {
      httpOnly: true,
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 1 week
      sameSite: 'strict',
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}