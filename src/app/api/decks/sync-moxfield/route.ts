import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { checkRateLimit, routeKey } from '@/lib/rateLimit';
import { syncUserMoxfieldDecks } from '@/lib/moxfieldDeckSync';

// Each sync fans out into several Moxfield requests — keep the limit tight.
export async function POST(request: Request) {
  const rl = checkRateLimit(routeKey(request, 'decks-sync-moxfield:post'), 3, 60000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded — wait a moment before syncing again' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
    );
  }
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.isLegacyAdmin) {
      return NextResponse.json(
        { error: 'Create your account via an invite to sync Moxfield decks' },
        { status: 403 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { moxfieldUsername: true },
    });
    if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    if (!user.moxfieldUsername) {
      return NextResponse.json(
        { error: 'Connect your Moxfield account first' },
        { status: 400 }
      );
    }

    try {
      const result = await syncUserMoxfieldDecks(session.userId);
      return NextResponse.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      console.error('Moxfield deck sync failed:', error);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (error) {
    console.error('POST /api/decks/sync-moxfield error:', error);
    return NextResponse.json({ error: 'Failed to sync Moxfield decks' }, { status: 500 });
  }
}
