/**
 * Tests for src/app/api/admin/users/route.ts and src/app/api/admin/users/[id]/route.ts
 * Mocks Prisma and next/server to test route handlers in isolation
 */

const mockFindMany = jest.fn();
const mockCreate = jest.fn();
const mockDelete = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findMany: (...args: any[]) => mockFindMany(...args),
      create: (...args: any[]) => mockCreate(...args),
      delete: (...args: any[]) => mockDelete(...args),
      update: (...args: any[]) => mockUpdate(...args),
    },
  },
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    })),
  },
  NextRequest: jest.fn(),
}));

const mockRequireAdmin = jest.fn();
jest.mock('@/lib/session', () => ({
  requireAdmin: (...args: any[]) => mockRequireAdmin(...args),
}));

import { GET, POST } from '@/app/api/admin/users/route';
import { DELETE, PATCH } from '@/app/api/admin/users/[id]/route';

const ADMIN_OK = { ok: true, session: { userId: 'admin', role: 'ADMIN', isLegacyAdmin: false } };

beforeEach(() => {
  // Default: an authenticated admin. Individual tests override to exercise 401/403.
  mockRequireAdmin.mockResolvedValue(ADMIN_OK);
});

function makeRequest(body?: object): any {
  return {
    json: async () => body,
  };
}

describe('GET /api/admin/users', () => {
  beforeEach(() => {
    mockFindMany.mockClear();
    const { NextResponse } = jest.requireMock('next/server');
    NextResponse.json.mockClear();
  });

  it('GET returns user list', async () => {
    const mockUsers = [{ id: '1', name: 'Alice', moxfieldCollectionId: 'abc' }];
    mockFindMany.mockResolvedValue(mockUsers);

    const result = await GET();

    expect(mockFindMany).toHaveBeenCalledWith({
      select: { id: true, name: true, moxfieldCollectionId: true, moxfieldUsername: true, username: true, role: true },
      orderBy: { name: 'asc' },
    });
    expect((result as any).status).toBe(200);
    expect((result as any).body).toEqual(mockUsers);
  });

  it('GET returns 401 with no session and 403 for a non-admin, without querying', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ ok: false, response: { status: 401 } });
    expect(((await GET()) as any).status).toBe(401);
    mockRequireAdmin.mockResolvedValueOnce({ ok: false, response: { status: 403 } });
    expect(((await GET()) as any).status).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    const { NextResponse } = jest.requireMock('next/server');
    NextResponse.json.mockClear();
  });

  it('POST creates user and returns 201', async () => {
    const newUser = { id: '2', name: 'Bob', moxfieldCollectionId: 'def' };
    mockCreate.mockResolvedValue(newUser);

    const req = makeRequest({ name: 'Bob', moxfieldCollectionId: 'def' });
    const result = await POST(req);

    expect(mockCreate).toHaveBeenCalledWith({
      data: { name: 'Bob', moxfieldCollectionId: 'def' },
    });
    expect((result as any).status).toBe(201);
    expect((result as any).body).toEqual(newUser);
  });

  it('POST returns 400 when name is empty', async () => {
    const req = makeRequest({ name: '', moxfieldCollectionId: 'def' });
    const result = await POST(req);

    expect(mockCreate).not.toHaveBeenCalled();
    expect((result as any).status).toBe(400);
    expect((result as any).body).toEqual({ error: 'Name is required' });
  });

  it('POST returns 400 when moxfieldCollectionId is empty', async () => {
    const req = makeRequest({ name: 'Bob', moxfieldCollectionId: '' });
    const result = await POST(req);

    expect(mockCreate).not.toHaveBeenCalled();
    expect((result as any).status).toBe(400);
    expect((result as any).body).toEqual({ error: 'Moxfield Collection ID is required' });
  });

  it('POST returns 409 on duplicate moxfieldCollectionId', async () => {
    mockCreate.mockRejectedValue({ code: 'P2002' });

    const req = makeRequest({ name: 'Bob', moxfieldCollectionId: 'abc' });
    const result = await POST(req);

    expect((result as any).status).toBe(409);
    expect((result as any).body.error).toMatch(/already exists/);
  });

  it('POST returns 403 for a non-admin without creating', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ ok: false, response: { status: 403 } });
    const result = await POST(makeRequest({ name: 'Bob', moxfieldCollectionId: 'def' }));
    expect((result as any).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('POST stores a valid Moxfield username when provided', async () => {
    mockCreate.mockResolvedValue({ id: '3', name: 'Carol', moxfieldCollectionId: 'ghi', moxfieldUsername: 'carol_mtg' });

    const result = await POST(makeRequest({ name: 'Carol', moxfieldCollectionId: 'ghi', moxfieldUsername: ' carol_mtg ' }));

    expect(mockCreate).toHaveBeenCalledWith({
      data: { name: 'Carol', moxfieldCollectionId: 'ghi', moxfieldUsername: 'carol_mtg' },
    });
    expect((result as any).status).toBe(201);
  });

  it('POST omits the username field when left blank', async () => {
    mockCreate.mockResolvedValue({ id: '4', name: 'Dan', moxfieldCollectionId: 'jkl' });

    await POST(makeRequest({ name: 'Dan', moxfieldCollectionId: 'jkl', moxfieldUsername: '  ' }));

    expect(mockCreate).toHaveBeenCalledWith({
      data: { name: 'Dan', moxfieldCollectionId: 'jkl' },
    });
  });

  it('POST rejects a malformed Moxfield username (400)', async () => {
    const result = await POST(makeRequest({ name: 'Bob', moxfieldCollectionId: 'def', moxfieldUsername: 'no spaces!' }));
    expect((result as any).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('POST maps a username unique violation to a specific 409 message', async () => {
    mockCreate.mockRejectedValue({ code: 'P2002', meta: { target: ['moxfieldUsername'] } });

    const result = await POST(makeRequest({ name: 'Bob', moxfieldCollectionId: 'def', moxfieldUsername: 'taken' }));

    expect((result as any).status).toBe(409);
    expect((result as any).body.error).toMatch(/Moxfield username/);
  });
});

describe('DELETE /api/admin/users/[id]', () => {
  beforeEach(() => {
    mockDelete.mockClear();
    const { NextResponse } = jest.requireMock('next/server');
    NextResponse.json.mockClear();
  });

  it('DELETE returns 204 on success', async () => {
    mockDelete.mockResolvedValue({});

    const result = await DELETE(makeRequest(), { params: Promise.resolve({ id: '1' }) });

    expect(mockDelete).toHaveBeenCalledWith({ where: { id: '1' } });
    expect(result.status).toBe(204);
  });

  it('DELETE returns 404 when user not found', async () => {
    mockDelete.mockRejectedValue({ code: 'P2025' });

    const result = await DELETE(makeRequest(), { params: Promise.resolve({ id: '999' }) });

    expect((result as any).status).toBe(404);
    expect((result as any).body).toEqual({ error: 'User not found' });
  });

  it('DELETE returns 403 for a non-admin without deleting', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ ok: false, response: { status: 403 } });
    const result = await DELETE(makeRequest(), { params: Promise.resolve({ id: '1' }) });
    expect((result as any).status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/users/[id]', () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    const { NextResponse } = jest.requireMock('next/server');
    NextResponse.json.mockClear();
  });

  it('PATCH returns 200 with updated user on valid moxfieldCollectionId', async () => {
    const updatedUser = { id: '1', name: 'Alice', moxfieldCollectionId: 'new-id-123' };
    mockUpdate.mockResolvedValue(updatedUser);

    const result = await PATCH(makeRequest({ moxfieldCollectionId: 'new-id-123' }), {
      params: Promise.resolve({ id: '1' }),
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { moxfieldCollectionId: 'new-id-123' },
      select: { id: true, name: true, moxfieldCollectionId: true, moxfieldUsername: true },
    });
    expect((result as any).status).toBe(200);
    expect((result as any).body).toEqual(updatedUser);
  });

  it('PATCH sets a Moxfield username on its own', async () => {
    mockUpdate.mockResolvedValue({ id: '1', name: 'Alice', moxfieldCollectionId: 'abc', moxfieldUsername: 'alice' });

    const result = await PATCH(makeRequest({ moxfieldUsername: ' alice ' }), {
      params: Promise.resolve({ id: '1' }),
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { moxfieldUsername: 'alice' },
      select: { id: true, name: true, moxfieldCollectionId: true, moxfieldUsername: true },
    });
    expect((result as any).status).toBe(200);
  });

  it('PATCH clears the Moxfield username on null', async () => {
    mockUpdate.mockResolvedValue({ id: '1', name: 'Alice', moxfieldCollectionId: 'abc', moxfieldUsername: null });

    const result = await PATCH(makeRequest({ moxfieldUsername: null }), {
      params: Promise.resolve({ id: '1' }),
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { moxfieldUsername: null },
      select: { id: true, name: true, moxfieldCollectionId: true, moxfieldUsername: true },
    });
    expect((result as any).status).toBe(200);
  });

  it('PATCH rejects a malformed Moxfield username (400)', async () => {
    const result = await PATCH(makeRequest({ moxfieldUsername: 'x' }), {
      params: Promise.resolve({ id: '1' }),
    });
    expect((result as any).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('PATCH returns 400 when moxfieldCollectionId is empty', async () => {
    const result = await PATCH(makeRequest({ moxfieldCollectionId: '' }), {
      params: Promise.resolve({ id: '1' }),
    });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect((result as any).status).toBe(400);
    expect((result as any).body).toEqual({ error: 'Collection ID is required' });
  });

  it('PATCH returns 400 when no updatable field is provided', async () => {
    const result = await PATCH(makeRequest({}), {
      params: Promise.resolve({ id: '1' }),
    });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect((result as any).status).toBe(400);
    expect((result as any).body).toEqual({ error: 'Provide moxfieldCollectionId and/or moxfieldUsername to update' });
  });

  it('PATCH returns 409 when collection ID is already in use', async () => {
    mockUpdate.mockRejectedValue({ code: 'P2002' });

    const result = await PATCH(makeRequest({ moxfieldCollectionId: 'duplicate-id' }), {
      params: Promise.resolve({ id: '1' }),
    });

    expect((result as any).status).toBe(409);
    expect((result as any).body).toEqual({ error: 'Collection ID already in use' });
  });

  it('PATCH returns 404 when user does not exist', async () => {
    mockUpdate.mockRejectedValue({ code: 'P2025' });

    const result = await PATCH(makeRequest({ moxfieldCollectionId: 'some-id' }), {
      params: Promise.resolve({ id: '999' }),
    });

    expect((result as any).status).toBe(404);
    expect((result as any).body).toEqual({ error: 'User not found' });
  });
});
