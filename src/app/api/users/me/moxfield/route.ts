import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { checkRateLimit, routeKey } from '@/lib/rateLimit';
import { searchMoxfieldUsers } from '@/lib/moxfieldApi';

const usernameSchema = z.string().trim().regex(
  /^[A-Za-z0-9_-]{3,30}$/,
  'Moxfield usernames are 3-30 characters (letters, digits, _ or -)'
);

const connectSchema = z.object({ moxfieldUsername: usernameSchema });

export async function GET(request: Request) {
  const rl = checkRateLimit(routeKey(request, 'users-me-moxfield:get'), 30, 60000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
    );
  }
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { moxfieldUsername: true },
    });
    if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    return NextResponse.json({ moxfieldUsername: user.moxfieldUsername });
  } catch (error) {
    console.error('GET /api/users/me/moxfield error:', error);
    return NextResponse.json({ error: 'Failed to load Moxfield connection' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const rl = checkRateLimit(routeKey(request, 'users-me-moxfield:put'), 10, 60000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
    );
  }
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.isLegacyAdmin) {
      return NextResponse.json(
        { error: 'Create your account via an invite to connect Moxfield' },
        { status: 403 }
      );
    }

    const { moxfieldUsername } = connectSchema.parse(await request.json());

    // Verify the account exists and store Moxfield's canonical casing.
    let matches;
    try {
      matches = await searchMoxfieldUsers(moxfieldUsername);
    } catch (error) {
      console.error('Moxfield user lookup failed:', error);
      return NextResponse.json({ error: 'Moxfield lookup failed — try again' }, { status: 502 });
    }
    const canonical = matches.find(
      (u) => u.userName.toLowerCase() === moxfieldUsername.toLowerCase()
    );
    if (!canonical) {
      return NextResponse.json(
        { error: `No Moxfield user named "${moxfieldUsername}" was found — check the spelling` },
        { status: 404 }
      );
    }

    try {
      const user = await prisma.user.update({
        where: { id: session.userId },
        data: { moxfieldUsername: canonical.userName },
        select: { moxfieldUsername: true },
      });
      return NextResponse.json({ moxfieldUsername: user.moxfieldUsername });
    } catch (error) {
      const prismaError = error as { code?: string };
      if (prismaError.code === 'P2025') {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
      }
      if (prismaError.code === 'P2002') {
        return NextResponse.json(
          { error: 'That Moxfield username is already connected to another user' },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    console.error('PUT /api/users/me/moxfield error:', error);
    return NextResponse.json({ error: 'Failed to connect Moxfield account' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const rl = checkRateLimit(routeKey(request, 'users-me-moxfield:delete'), 10, 60000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
    );
  }
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
      await prisma.user.update({
        where: { id: session.userId },
        data: { moxfieldUsername: null },
      });
    } catch (error) {
      const prismaError = error as { code?: string };
      if (prismaError.code === 'P2025') {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
      }
      throw error;
    }
    return NextResponse.json({ moxfieldUsername: null });
  } catch (error) {
    console.error('DELETE /api/users/me/moxfield error:', error);
    return NextResponse.json({ error: 'Failed to disconnect Moxfield account' }, { status: 500 });
  }
}
