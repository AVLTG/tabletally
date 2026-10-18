import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/session';
import { checkRateLimit, routeKey } from '@/lib/rateLimit';
import { searchMoxfieldUsers } from '@/lib/moxfieldApi';

// Moxfield's own user search rejects filters shorter than 3 characters.
const filterSchema = z.string().trim().min(3, 'filter must be at least 3 characters').max(50, 'filter too long');

export async function GET(request: Request) {
  const rl = checkRateLimit(routeKey(request, 'moxfield-user-search:get'), 15, 60000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
    );
  }
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const raw = new URL(request.url).searchParams.get('filter') ?? '';
    const parsed = filterSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid filter' },
        { status: 400 }
      );
    }

    try {
      const users = await searchMoxfieldUsers(parsed.data);
      return NextResponse.json({ users });
    } catch (error) {
      console.error('Moxfield user search failed:', error);
      return NextResponse.json({ error: 'Moxfield lookup failed — try again' }, { status: 502 });
    }
  } catch (error) {
    console.error('GET /api/moxfield/user-search error:', error);
    return NextResponse.json({ error: 'Failed to search Moxfield users' }, { status: 500 });
  }
}
