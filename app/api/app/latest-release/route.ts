import { NextResponse } from 'next/server';

// =====================================================================================
// 📦 LATEST APP RELEASE (public)
// Proxies the newest GitHub release for the Android app, cached server-side.
//
// WHY THIS EXISTS: the app used to call api.github.com directly from every device. That API
// allows 60 requests/hour PER IP for unauthenticated callers, and users behind carrier-grade
// NAT all share one address — so the update check would start returning 403 for everybody on
// that IP and the client, which treats any failure as "no update", would go silent with no
// trace. Routing it through here means one upstream call is shared by all users.
//
// Public on purpose: `middleware.ts` only gates /api/admin, /api/super-admin and
// /api/notifications. Release metadata is already public, and the update check has to work on
// the login screen, before any session token exists.
// =====================================================================================

const GITHUB_OWNER = 'mrshovon';
const GITHUB_REPO = 'RentMasterPWAUI';
const UPSTREAM = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// Cache upstream for 10 minutes. A release the user sees 10 minutes late is fine; being
// rate-limited into permanent silence is not.
const REVALIDATE_SECONDS = 600;

export async function GET() {
  try {
    const res = await fetch(UPSTREAM, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'RentMaster-Update-Check',
      },
      next: { revalidate: REVALIDATE_SECONDS },
    });

    if (!res.ok) {
      // 403 here is almost always the rate limit; surface it rather than pretending
      // there is no release.
      console.error('[latest-release] upstream failed:', res.status);
      return NextResponse.json(
        { success: false, error: `GitHub returned ${res.status}`, status: res.status },
        { status: 502 }
      );
    }

    const json = await res.json();
    const asset = (json.assets || []).find((a: any) => /\.apk$/i.test(a.name));

    // Only the fields the client needs — no need to relay GitHub's full payload.
    return NextResponse.json(
      {
        success: true,
        version: String(json.tag_name || '').replace(/^v/i, ''),
        notes: json.body || '',
        apkUrl: asset?.browser_download_url || null,
        apkSize: typeof asset?.size === 'number' ? asset.size : null,
        htmlUrl: json.html_url || null,
      },
      {
        status: 200,
        headers: { 'Cache-Control': `public, max-age=60, s-maxage=${REVALIDATE_SECONDS}` },
      }
    );
  } catch (err: any) {
    console.error('[latest-release] error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
