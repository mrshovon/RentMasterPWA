// =============================================================================
// The brand colour, for the backend.
//
// SOURCE OF TRUTH is rent-master-pwa-ui/brand.config.json. This repo is deployed separately
// and cannot import from the frontend, so the hex is mirrored here — in exactly ONE place,
// rather than being typed into the FCM sender and the email templates independently the way
// it was before (both said #136aba long after the web app had moved off it).
//
// Two consumers, and neither can use a CSS token:
//   - lib/fcm-send.ts      Android tints the status-bar notification icon with this. It also
//                          overrides android/app/src/main/res/values/colors.xml, so a push
//                          sent from here wins over whatever the installed APK was built with —
//                          which is why the colour can change without an app release.
//   - lib/email/templates.ts  Mail clients get inline CSS only; no variables, no stylesheet.
//
// BRAND_PRIMARY_COLOR is env-overridable so the colour can be changed from the Vercel
// dashboard without a code edit. Leave it unset to use the value below.
// =============================================================================

export const BRAND_PRIMARY = process.env.BRAND_PRIMARY_COLOR || '#E0473B';
