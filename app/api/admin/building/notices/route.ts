import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { sendPushToUsers } from '@/lib/push-send';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin, ownerInBuilding, buildingOwnerIds } from '@/lib/building';

// =====================================================================================
// 🏢 BUILDING ADMIN — NOTICES
// GET  -> the building's notice record, newest first.
// POST -> issue one: store the canonical printable row, then fan it out into the EXISTING
//         notices table so it lands in the right people's in-app feed, then push.
//
// ⚠️ THE FAN-OUT IS THE REASON THIS ROUTE EXISTS. `individual_owner` is in ADMIN_ONLY_SCOPES on
// /api/admin/notices, and it must stay there — relaxing it would let ANY owner address ANY other
// owner by uid. Here the target list comes from this building's own roster and is never taken
// from the request, so the same rows can be written safely.
// =====================================================================================

const AUDIENCES = ['all_owners', 'all_tenants', 'individual_owner'] as const;

const NOTICE_SELECT =
  'id, notice_no, building_id, title, content, audience, target_owner_id, issued_on, reference_no, delivered_count, created_at';

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data, error } = await supabaseAdminEngine
      .from('building_notices')
      .select(NOTICE_SELECT)
      .eq('building_id', gate.building!.id)
      .order('issued_on', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();

    const title = String(body.title || '').trim().slice(0, 300);
    const content = String(body.content || '').trim().slice(0, 20000);
    if (!title || !content) {
      return NextResponse.json(
        { success: false, error: 'A notice needs a title and some text.' },
        { status: 400 }
      );
    }

    const audience = String(body.audience || 'all_owners');
    if (!AUDIENCES.includes(audience as any)) {
      return NextResponse.json({ success: false, error: 'Unknown audience.' }, { status: 400 });
    }

    let targetOwnerId: string | null = null;
    if (audience === 'individual_owner') {
      targetOwnerId = String(body.targetOwnerId || '').trim() || null;
      if (!targetOwnerId) {
        return NextResponse.json({ success: false, error: 'Choose which owner this is for.' }, { status: 400 });
      }
      if (!(await ownerInBuilding(gate.building!.id, targetOwnerId))) {
        return NextResponse.json(
          { success: false, error: 'That owner is not in your building.' },
          { status: 404 }
        );
      }
    }

    const issuedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.issuedOn || ''))
      ? String(body.issuedOn)
      : new Date().toISOString().slice(0, 10);

    const noticeId = crypto.randomUUID();
    const { data: record, error: insertErr } = await supabaseAdminEngine
      .from('building_notices')
      .insert({
        id: noticeId,
        building_id: gate.building!.id,
        title,
        content,
        audience,
        target_owner_id: targetOwnerId,
        issued_on: issuedOn,
        reference_no: body.referenceNo ? String(body.referenceNo).trim().slice(0, 60) : null,
      })
      .select(NOTICE_SELECT)
      .single();
    if (insertErr) throw insertErr;

    // ---- Fan out into the in-app feed ---------------------------------------------------
    // Best-effort: the printable record is the deliverable, and losing the push must never lose
    // the notice. Anything that fails here is reported as a warning, not a 500.
    const warnings: string[] = [];
    let delivered = 0;

    try {
      if (audience === 'all_tenants') {
        // ONE row, not a fan-out: the tenant feed already queries for
        // `all_tenants` + `sender_id = <their owner>`, and this building admin IS their owner.
        const { error } = await supabaseAdminEngine.from('notices').insert({
          id: crypto.randomUUID(),
          sender_type: 'owner',
          sender_id: gate.uid!,
          target_scope: 'all_tenants',
          title,
          content,
        });
        if (error) throw error;
        delivered = 1;

        const { data: tenants } = await supabaseAdminEngine
          .from('tenants').select('id').eq('owner_id', gate.uid!);
        void pushTo((tenants || []).map((t: { id: string }) => String(t.id)), title, '/tenant', noticeId);
      } else {
        const targets = targetOwnerId
          ? [targetOwnerId]
          : await buildingOwnerIds(gate.building!.id);

        if (targets.length) {
          // ONE batched insert, not a loop — a per-owner round trip on a 40-flat building is
          // 40 sequential writes for something that is a single statement.
          const rows = targets.map((ownerId) => ({
            id: crypto.randomUUID(),
            sender_type: 'owner',
            sender_id: gate.uid!,
            target_scope: 'individual_owner',
            target_owner_id: ownerId,
            title,
            content,
          }));
          const { error } = await supabaseAdminEngine.from('notices').insert(rows);
          if (error) throw error;
          delivered = rows.length;

          void pushTo(targets, title, '/owner#notices', noticeId);
        }
      }

      if (delivered) {
        await supabaseAdminEngine
          .from('building_notices')
          .update({ delivered_count: delivered })
          .eq('id', noticeId);
      }
    } catch (fanErr: any) {
      console.error('[building-notices] fan-out failed (non-fatal):', fanErr);
      warnings.push(
        `The notice was saved and can be printed, but the in-app copy could not be delivered (${fanErr?.message || fanErr}).`
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: { ...record, delivered_count: delivered },
        warnings: warnings.length ? warnings : undefined,
      },
      { status: 201 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}

/** Fire-and-forget. A failed push must never fail the notice. */
async function pushTo(userIds: string[], title: string, url: string, tagId: string): Promise<void> {
  if (!userIds.length) return;
  try {
    await sendPushToUsers(userIds, {
      title: 'Notice from your building',
      body: title,
      url,
      tag: `building-notice-${tagId}`,
    });
  } catch (pushErr) {
    console.error('[building-notices] push dispatch failed (non-fatal):', pushErr);
  }
}
