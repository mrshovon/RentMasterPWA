// =====================================================================================
// ✉️ EMAIL TEMPLATES — bilingual by construction.
//
// WHY BOTH LANGUAGES IN ONE MESSAGE: the app's language lives in the browser's localStorage
// (`rentmaster-lang`, see rent-master-pwa-ui/lib/i18n.tsx) and is never sent to the server or
// stored against the account. So at the moment an email is composed, there is genuinely no way to
// know whether this person reads English or Bangla.
//
// The alternatives were: guess (wrong for half the users, on the exact message — a reset link —
// where being unreadable is worst), or add a stored per-user preference (a schema change, a sync
// path, and a migration for every existing account). Sending both is neither, costs a few extra
// lines of markup, and is what Bangladeshi banks and utilities already do.
//
// English first because that is what the rest of the product defaults to; the Bangla block is
// visually equal, not a footnote.
//
// Plain inline CSS, no external assets. Every mail client blocks remote images by default, so a
// logo would be a broken-image icon at the top of a password-reset email.
// =====================================================================================

export interface EmailBody {
  subject: string;
  html: string;
  text: string;
}

const BRAND = '#136aba'; // matches the Android notification colour and the light-theme primary

/** Shell shared by every template, so all mail from the app looks like it came from one place. */
function wrap(inner: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f8fb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;">
      <div style="font-size:20px;font-weight:700;color:${BRAND};margin-bottom:24px;">Bari360</div>
      ${inner}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px;" />
      <p style="font-size:12px;color:#64748b;margin:0;">
        Bari360 — property management, made simple.<br />
        Bari360 — সহজ সম্পত্তি ব্যবস্থাপনা।
      </p>
    </div>
  </body>
</html>`;
}

const p = (text: string) =>
  `<p style="font-size:14px;line-height:1.7;color:#334155;margin:0 0 14px;">${text}</p>`;

const h = (text: string) =>
  `<h1 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 12px;">${text}</h1>`;

/** The visual break between the English and Bangla halves. */
const divider = `<div style="border-top:1px dashed #cbd5e1;margin:24px 0;"></div>`;

const button = (href: string, label: string) =>
  `<p style="margin:0 0 20px;">
     <a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:12px;">${label}</a>
   </p>`;

/** Escape anything that came from a user before it goes into markup. */
function esc(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// -------------------------------------------------------------------------------------
// 1. Account created
// -------------------------------------------------------------------------------------
export function accountCreated(args: { name: string; email: string; appUrl: string }): EmailBody {
  const name = esc(args.name || 'there');
  const email = esc(args.email);
  const url = esc(args.appUrl);

  return {
    subject: 'Your Bari360 account is ready / আপনার Bari360 অ্যাকাউন্ট প্রস্তুত',
    html: wrap(`
      ${h('Welcome to Bari360')}
      ${p(`Hi ${name}, your owner account is set up and ready to use.`)}
      ${p(`Sign in with <strong>${email}</strong> and the password you chose.`)}
      ${button(url, 'Open Bari360')}
      ${p('You can add your first property straight away — the free plan covers 2 properties and 2 tenants, with no time limit.')}
      ${divider}
      ${h('Bari360-এ স্বাগতম')}
      ${p(`প্রিয় ${name}, আপনার মালিক অ্যাকাউন্ট তৈরি হয়ে গেছে।`)}
      ${p(`<strong>${email}</strong> এবং আপনার পাসওয়ার্ড দিয়ে সাইন ইন করুন।`)}
      ${button(url, 'Bari360 খুলুন')}
      ${p('এখনই আপনার প্রথম সম্পত্তি যোগ করতে পারেন — ফ্রি প্ল্যানে ২টি সম্পত্তি ও ২ জন ভাড়াটিয়া, কোনো সময়সীমা ছাড়াই।')}
    `),
    text: [
      `Welcome to Bari360`,
      ``,
      `Hi ${args.name || 'there'}, your owner account is set up and ready to use.`,
      `Sign in with ${args.email} and the password you chose: ${args.appUrl}`,
      ``,
      `---`,
      ``,
      `Bari360-এ স্বাগতম`,
      ``,
      `প্রিয় ${args.name || ''}, আপনার মালিক অ্যাকাউন্ট তৈরি হয়ে গেছে।`,
      `${args.email} এবং আপনার পাসওয়ার্ড দিয়ে সাইন ইন করুন: ${args.appUrl}`,
    ].join('\n'),
  };
}

// -------------------------------------------------------------------------------------
// 2. Password changed — a security notice, not a receipt
// -------------------------------------------------------------------------------------
export function passwordChanged(args: {
  name: string;
  at: string;             // already-formatted, human-readable
  ip?: string | null;
  byAdmin?: boolean;      // a super admin reset it, rather than the owner changing it
}): EmailBody {
  const name = esc(args.name || 'there');
  const at = esc(args.at);
  const where = args.ip ? ` (from ${esc(args.ip)})` : '';

  // The point of this email is the LAST line — someone who did not do this needs to act. So it
  // says who changed it, when, and what to do, and never buries that under a confirmation tone.
  const who = args.byAdmin
    ? 'A Bari360 administrator reset the password on your account'
    : 'The password on your Bari360 account was changed';
  const whoBn = args.byAdmin
    ? 'একজন Bari360 প্রশাসক আপনার অ্যাকাউন্টের পাসওয়ার্ড রিসেট করেছেন'
    : 'আপনার Bari360 অ্যাকাউন্টের পাসওয়ার্ড পরিবর্তন করা হয়েছে';

  return {
    subject: 'Your Bari360 password was changed / আপনার পাসওয়ার্ড পরিবর্তিত হয়েছে',
    html: wrap(`
      ${h('Password changed')}
      ${p(`Hi ${name}, ${who} on ${at}${where}.`)}
      ${p('<strong>If this was you, nothing more is needed.</strong>')}
      ${p('If it was not, reset your password immediately using "Forgot password?" on the sign-in screen, and contact support.')}
      ${divider}
      ${h('পাসওয়ার্ড পরিবর্তিত হয়েছে')}
      ${p(`প্রিয় ${name}, ${at}${where} তারিখে ${whoBn}।`)}
      ${p('<strong>আপনি নিজে করে থাকলে আর কিছু করার দরকার নেই।</strong>')}
      ${p('আপনি না করে থাকলে সাইন-ইন পাতায় "পাসওয়ার্ড ভুলে গেছেন?" দিয়ে এখনই পাসওয়ার্ড বদলান এবং সহায়তা কেন্দ্রে জানান।')}
    `),
    text: [
      `Password changed`,
      ``,
      `Hi ${args.name || 'there'}, ${who} on ${args.at}${args.ip ? ` (from ${args.ip})` : ''}.`,
      `If this was you, nothing more is needed.`,
      `If it was not, reset your password immediately from the sign-in screen and contact support.`,
      ``,
      `---`,
      ``,
      `পাসওয়ার্ড পরিবর্তিত হয়েছে`,
      ``,
      `আপনি না করে থাকলে এখনই পাসওয়ার্ড বদলান এবং সহায়তা কেন্দ্রে জানান।`,
    ].join('\n'),
  };
}

// -------------------------------------------------------------------------------------
// 3. Password reset link
// -------------------------------------------------------------------------------------
export function passwordReset(args: {
  name: string;
  actionLink: string;
  expiresMinutes: number;
}): EmailBody {
  const name = esc(args.name || 'there');
  const link = esc(args.actionLink);
  const mins = args.expiresMinutes;

  return {
    subject: 'Reset your Bari360 password / পাসওয়ার্ড রিসেট করুন',
    html: wrap(`
      ${h('Reset your password')}
      ${p(`Hi ${name}, use the button below to choose a new password. The link works once and expires in ${mins} minutes.`)}
      ${button(link, 'Choose a new password')}
      ${p(`If the button does not work, copy this link into your browser:<br /><span style="word-break:break-all;font-size:12px;color:#64748b;">${link}</span>`)}
      ${p('<strong>If you did not ask for this, ignore this email.</strong> Your password stays as it is.')}
      ${divider}
      ${h('পাসওয়ার্ড রিসেট করুন')}
      ${p(`প্রিয় ${name}, নতুন পাসওয়ার্ড দিতে নিচের বোতামে চাপ দিন। লিংকটি একবারই কাজ করবে এবং ${mins} মিনিট পরে মেয়াদ শেষ হবে।`)}
      ${button(link, 'নতুন পাসওয়ার্ড দিন')}
      ${p('<strong>আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন।</strong> আপনার পাসওয়ার্ড অপরিবর্তিত থাকবে।')}
    `),
    text: [
      `Reset your password`,
      ``,
      `Hi ${args.name || 'there'}, open this link to choose a new password.`,
      `It works once and expires in ${mins} minutes:`,
      args.actionLink,
      ``,
      `If you did not ask for this, ignore this email — your password stays as it is.`,
      ``,
      `---`,
      ``,
      `পাসওয়ার্ড রিসেট করুন`,
      ``,
      `নতুন পাসওয়ার্ড দিতে উপরের লিংকটি খুলুন। লিংকটি ${mins} মিনিট পরে মেয়াদোত্তীর্ণ হবে।`,
      `আপনি অনুরোধ না করে থাকলে ইমেইলটি উপেক্ষা করুন।`,
    ].join('\n'),
  };
}

// -------------------------------------------------------------------------------------
// 4. Plan lifecycle — used by the subscriptions cron (Phase 3)
// -------------------------------------------------------------------------------------
export function planEvent(args: {
  name: string;
  event: 'expiring_soon' | 'grace_started' | 'downgraded';
  tierName: string;
  days?: number;
  appUrl: string;
  freeLimits: { properties: number; tenants: number };
}): EmailBody {
  const name = esc(args.name || 'there');
  const tier = esc(args.tierName);
  const url = esc(args.appUrl);
  const days = args.days ?? 0;
  const { properties, tenants } = args.freeLimits;

  const copy = {
    expiring_soon: {
      subject: `Your ${args.tierName} plan expires in ${days} days / আপনার প্ল্যানের মেয়াদ শেষ হচ্ছে`,
      enHead: 'Your plan expires soon',
      enBody: `Hi ${name}, your <strong>${tier}</strong> plan expires in ${days} day${days === 1 ? '' : 's'}. Renew now to keep everything exactly as it is.`,
      bnHead: 'আপনার প্ল্যানের মেয়াদ শেষ হতে চলেছে',
      bnBody: `প্রিয় ${name}, আপনার <strong>${tier}</strong> প্ল্যানের মেয়াদ ${days} দিনে শেষ হবে। সবকিছু আগের মতো রাখতে এখনই নবায়ন করুন।`,
      cta: 'Renew my plan',
      ctaBn: 'প্ল্যান নবায়ন করুন',
    },
    grace_started: {
      subject: `Your ${args.tierName} plan has expired / আপনার প্ল্যানের মেয়াদ শেষ`,
      enHead: 'Your plan has expired',
      enBody: `Hi ${name}, your <strong>${tier}</strong> plan has expired. You have ${days} day${days === 1 ? '' : 's'} left to renew before your account drops to the free plan.`,
      bnHead: 'আপনার প্ল্যানের মেয়াদ শেষ হয়েছে',
      bnBody: `প্রিয় ${name}, আপনার <strong>${tier}</strong> প্ল্যানের মেয়াদ শেষ হয়েছে। ফ্রি প্ল্যানে নেমে যাওয়ার আগে নবায়নের জন্য আর ${days} দিন সময় আছে।`,
      cta: 'Renew my plan',
      ctaBn: 'প্ল্যান নবায়ন করুন',
    },
    downgraded: {
      subject: `You're now on the Bari360 free plan / আপনি এখন ফ্রি প্ল্যানে`,
      enHead: 'Your plan has ended',
      enBody: `Hi ${name}, your <strong>${tier}</strong> plan has ended and your account is now on the <strong>free plan</strong> — ${properties} propert${properties === 1 ? 'y' : 'ies'} and ${tenants} tenant${tenants === 1 ? '' : 's'}.<br /><br />Nothing has been deleted. Anything beyond those limits is still there, just read-only until you choose a plan again.`,
      bnHead: 'আপনার প্ল্যান শেষ হয়েছে',
      bnBody: `প্রিয় ${name}, আপনার <strong>${tier}</strong> প্ল্যান শেষ হয়েছে এবং আপনার অ্যাকাউন্ট এখন <strong>ফ্রি প্ল্যানে</strong> — ${properties}টি সম্পত্তি ও ${tenants} জন ভাড়াটিয়া।<br /><br />কোনো তথ্য মুছে ফেলা হয়নি। সীমার বাইরের সবকিছু রয়ে গেছে, শুধু নতুন প্ল্যান না নেওয়া পর্যন্ত সেগুলো শুধু দেখা যাবে।`,
      cta: 'Choose a plan',
      ctaBn: 'প্ল্যান বেছে নিন',
    },
  }[args.event];

  const planUrl = `${url.replace(/\/$/, '')}/owner#plan`;

  return {
    subject: copy.subject,
    html: wrap(`
      ${h(copy.enHead)}
      ${p(copy.enBody)}
      ${button(planUrl, copy.cta)}
      ${divider}
      ${h(copy.bnHead)}
      ${p(copy.bnBody)}
      ${button(planUrl, copy.ctaBn)}
    `),
    text: [
      copy.enHead,
      '',
      copy.enBody.replace(/<[^>]+>/g, ''),
      planUrl,
      '',
      '---',
      '',
      copy.bnHead,
      '',
      copy.bnBody.replace(/<[^>]+>/g, ''),
    ].join('\n'),
  };
}
