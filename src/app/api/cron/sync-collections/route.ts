import type { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { updateAllCollections } from '@/lib/updateCollections'
import { syncAllMoxfieldDecks } from '@/lib/moxfieldDeckSync'
import { sendDiscordAlert } from '@/lib/discord'

export const maxDuration = 300

// Constant-time Bearer check. An unset CRON_SECRET must fail closed — a naive
// template-literal compare would accept the literal "Bearer undefined".
function isAuthorizedCron(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret || !authHeader) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(authHeader)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')

  if (!isAuthorizedCron(authHeader)) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Automatic sync is production-only. On preview/staging (e.g. the `develop`
  // deployment) this short-circuits so we never burn scraper tokens or ping
  // Discord automatically — staging is manual-sync only via the admin panel.
  // VERCEL_ENV is unset locally, so local `npm run dev` testing is unaffected.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return Response.json(
      { skipped: true, reason: `automatic sync disabled in ${process.env.VERCEL_ENV} environment` },
      { status: 200 }
    )
  }

  try {
    const { succeeded, failed } = await updateAllCollections('cron')

    // Deck auto-sync is best-effort: a failure here must not fail the cron
    // run or mask the collection-sync result above.
    let decksImported = 0
    let deckSyncFailedUsers = 0
    try {
      const deckSync = await syncAllMoxfieldDecks()
      decksImported = deckSync.results.reduce((n, r) => n + r.imported.length, 0)
      deckSyncFailedUsers = deckSync.failedUsers.length
    } catch (error) {
      console.error('Moxfield deck sync failed:', error)
    }

    const deckNote = decksImported > 0 ? ` (+${decksImported} new Moxfield deck${decksImported !== 1 ? 's' : ''})` : ''
    if (failed.length > 0 || deckSyncFailedUsers > 0) {
      const lines = failed.map(f => `- ${f.name}: ${f.error}`)
      if (deckSyncFailedUsers > 0) lines.push(`- ${deckSyncFailedUsers} user(s) failed Moxfield deck sync`)
      await sendDiscordAlert({
        content: `⚠️ Sync completed with ${failed.length} failure(s) (${succeeded.length} succeeded):\n${lines.join('\n')}${deckNote}`,
      })
    } else {
      await sendDiscordAlert({
        content: `✅ Sync complete: ${succeeded.length} user(s) synced successfully${deckNote}`,
      })
    }
    return Response.json({
      success: true,
      succeeded: succeeded.length,
      failed: failed.length,
      decksImported,
      deckSyncFailedUsers,
    })
  } catch (error) {
    console.error('Cron sync failed:', error)
    // Hard failure (e.g. DB unreachable) throws before the per-user loop, so no
    // ⚠️/✅ summary is sent. Alert explicitly so a total failure is never silent.
    await sendDiscordAlert({
      content: `❌ Sync crashed before completing: ${String(error)}`,
    }).catch((alertError) => {
      console.error('Failed to post cron-failure alert to Discord:', alertError)
    })
    return Response.json({ success: false, error: String(error) }, { status: 500 })
  }
}
