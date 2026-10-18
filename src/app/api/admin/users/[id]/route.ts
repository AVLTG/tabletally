import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/session';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    await prisma.user.delete({ where: { id } });
    return new Response(null, { status: 204 });
  } catch (error) {
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2025') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    console.error('Failed to delete user:', error);
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}

const MOXFIELD_USERNAME_RE = /^[A-Za-z0-9_-]{3,30}$/;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const body = await request.json();

    const data: { moxfieldCollectionId?: string; moxfieldUsername?: string | null } = {};

    if (body?.moxfieldCollectionId !== undefined) {
      const moxfieldCollectionId = String(body.moxfieldCollectionId).trim();
      if (!moxfieldCollectionId) {
        return NextResponse.json({ error: 'Collection ID is required' }, { status: 400 });
      }
      data.moxfieldCollectionId = moxfieldCollectionId;
    }

    if (body?.moxfieldUsername !== undefined) {
      const username = body.moxfieldUsername === null ? '' : String(body.moxfieldUsername).trim();
      if (username && !MOXFIELD_USERNAME_RE.test(username)) {
        return NextResponse.json(
          { error: 'Moxfield username must be 3-30 characters (letters, digits, _ or -)' },
          { status: 400 }
        );
      }
      // Empty string clears the connection
      data.moxfieldUsername = username || null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'Provide moxfieldCollectionId and/or moxfieldUsername to update' },
        { status: 400 }
      );
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, moxfieldCollectionId: true, moxfieldUsername: true },
    });
    return NextResponse.json(user);
  } catch (error) {
    const prismaError = error as { code?: string; meta?: { target?: string[] } };
    if (prismaError.code === 'P2025') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (prismaError.code === 'P2002') {
      const target = Array.isArray(prismaError.meta?.target) ? prismaError.meta.target.join(',') : String(prismaError.meta?.target ?? '');
      return NextResponse.json(
        {
          error: target.includes('moxfieldUsername')
            ? 'That Moxfield username is already connected to another user'
            : 'Collection ID already in use',
        },
        { status: 409 }
      );
    }
    console.error('Failed to update user:', error);
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
  }
}
