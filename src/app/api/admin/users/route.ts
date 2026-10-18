import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/session';

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, moxfieldCollectionId: true, moxfieldUsername: true, username: true, role: true },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json(users);
  } catch (error) {
    console.error('Failed to list users:', error);
    return NextResponse.json({ error: 'Failed to list users' }, { status: 500 });
  }
}

// Moxfield usernames: letters, digits, underscore, hyphen (3-30). Optional on
// create — the admin may connect it later, or the user connects it themselves
// from the Decks page.
const MOXFIELD_USERNAME_RE = /^[A-Za-z0-9_-]{3,30}$/;

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  try {
    const { name, moxfieldCollectionId, moxfieldUsername } = await request.json();

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    if (!moxfieldCollectionId || !moxfieldCollectionId.trim()) {
      return NextResponse.json({ error: 'Moxfield Collection ID is required' }, { status: 400 });
    }

    const username = typeof moxfieldUsername === 'string' ? moxfieldUsername.trim() : '';
    if (username && !MOXFIELD_USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: 'Moxfield username must be 3-30 characters (letters, digits, _ or -)' },
        { status: 400 }
      );
    }

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        moxfieldCollectionId: moxfieldCollectionId.trim(),
        ...(username ? { moxfieldUsername: username } : {}),
      },
    });

    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    const prismaError = error as { code?: string; meta?: { target?: string[] } };
    if (prismaError.code === 'P2002') {
      const target = Array.isArray(prismaError.meta?.target) ? prismaError.meta.target.join(',') : String(prismaError.meta?.target ?? '');
      return NextResponse.json(
        {
          error: target.includes('moxfieldUsername')
            ? 'That Moxfield username is already connected to another user'
            : 'A user with this Moxfield Collection ID already exists',
        },
        { status: 409 }
      );
    }
    console.error('Failed to add user:', error);
    return NextResponse.json({ error: 'Failed to add user' }, { status: 500 });
  }
}
