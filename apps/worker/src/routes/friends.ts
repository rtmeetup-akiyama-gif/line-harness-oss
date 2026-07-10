import { Hono } from 'hono';
import {
  getFriends,
  getFriendById,
  getFriendCount,
  addTagToFriend,
  removeTagFromFriend,
  getFriendTags,
  getScenarios,
  enrollFriendInScenario,
  upsertFriend,
  jstNow,
} from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage } from '../services/step-delivery.js';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

const friends = new Hono<Env>();

/**
 * POST /api/friends/import-csv — bulk-register existing friends from a CSV
 * export (e.g. migrating off another tool like エルメ/L Message).
 *
 * WHY THIS EXISTS: the webhook only creates a friend row on a `follow` event
 * (see routes/webhook.ts). Anyone who was already following before the
 * webhook was connected is invisible to L Harness — their future messages
 * are silently dropped (`if (!friend) return;`) because there's no row to
 * match against. This endpoint backfills those rows ahead of time so their
 * messages resolve correctly once Webhook is switched over.
 *
 * Body: { lineAccountId: string, csv: string, tagNames?: string[] }
 * CSV must have a header row and a `line_user_id` column (U... LINE user
 * id). Optional columns: `display_name`. Optional `tagNames` (applied to
 * every imported row) must reference existing tag names — this endpoint
 * does not create tags.
 *
 * Idempotent: re-running with the same rows just upserts (no duplicates),
 * since friends.line_user_id is UNIQUE.
 *
 * requireRole('owner', 'admin') — this writes production friend data in
 * bulk, so it's gated the same way as other account-admin operations.
 */
friends.post('/api/friends/import-csv', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string; csv?: string; tagNames?: string[] }>();
    if (!body.lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    if (!body.csv || typeof body.csv !== 'string' || body.csv.trim().length === 0) {
      return c.json({ success: false, error: 'csv is required' }, 400);
    }

    // Minimal RFC4180-ish CSV parser: handles quoted fields with embedded
    // commas, but not embedded newlines inside quotes (not needed for a
    // simple line_user_id/display_name export).
    function parseCsvLine(line: string): string[] {
      const out: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
          } else {
            cur += ch;
          }
        } else if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
      out.push(cur);
      return out.map((s) => s.trim());
    }

    const lines = body.csv.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
    if (lines.length < 2) {
      return c.json({ success: false, error: 'csv must have a header row plus at least one data row' }, 400);
    }
    const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const idIdx = header.indexOf('line_user_id');
    if (idIdx === -1) {
      return c.json({ success: false, error: 'csv header must include a "line_user_id" column' }, 400);
    }
    const nameIdx = header.indexOf('display_name');

    // Resolve tagNames -> tag ids up front (fail fast on unknown tag names
    // rather than partway through a 900-row import).
    let tagIds: string[] = [];
    if (body.tagNames && body.tagNames.length > 0) {
      for (const name of body.tagNames) {
        const row = await c.env.DB.prepare(`SELECT id FROM tags WHERE name = ?`).bind(name).first<{ id: string }>();
        if (!row) return c.json({ success: false, error: `tag "${name}" does not exist — create it first` }, 400);
        tagIds.push(row.id);
      }
    }

    let created = 0;
    let updated = 0;
    const errors: { row: number; error: string }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const lineUserId = cols[idIdx];
      if (!lineUserId || !lineUserId.startsWith('U')) {
        errors.push({ row: i + 1, error: `missing/invalid line_user_id: "${lineUserId ?? ''}"` });
        continue;
      }
      try {
        const before = await c.env.DB.prepare(`SELECT id FROM friends WHERE line_user_id = ?`).bind(lineUserId).first<{ id: string }>();
        const friend = await upsertFriend(c.env.DB, {
          lineUserId,
          displayName: nameIdx !== -1 ? (cols[nameIdx] || null) : null,
        });
        // upsertFriend doesn't touch line_account_id — set it only on first
        // insert so we don't clobber an account assignment on re-import.
        if (!before) {
          await c.env.DB.prepare(`UPDATE friends SET line_account_id = ? WHERE id = ?`).bind(body.lineAccountId, friend.id).run();
          created++;
        } else {
          updated++;
        }
        for (const tagId of tagIds) {
          await addTagToFriend(c.env.DB, friend.id, tagId);
        }
      } catch (err) {
        errors.push({ row: i + 1, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return c.json({ success: true, data: { created, updated, errorCount: errors.length, errors: errors.slice(0, 20) } });
  } catch (err) {
    console.error('POST /api/friends/import-csv error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * Convert a D1 snake_case Friend row to the shared camelCase shape.
 *
 * Bare-row variant — emits ONLY columns that exist on the friends table.
 * Used by GET /api/friends/:id and metadata-update responses where we read
 * via plain `getFriendById()` and have no JOINed columns. The list endpoint
 * uses `serializeFriendListRow` instead, which adds firstTrackedLinkName +
 * chatStatus from the JOINed query.
 */
function serializeFriend(row: DbFriend) {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    statusMessage: row.status_message,
    isFollowing: Boolean(row.is_following),
    metadata: JSON.parse(row.metadata || '{}'),
    refCode: (row as unknown as Record<string, unknown>).ref_code as string | null,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Friend serializer for the list endpoint. Adds firstTrackedLinkName +
 * chatStatus from the JOINed query, present only when the caller opted into
 * the chat-status path (?includeChatStatus=true). When absent, the fields
 * default to nullish so the response shape stays consistent for clients that
 * don't request them.
 */
function serializeFriendListRow(
  row: DbFriend & { first_tracked_link_name?: string | null; chat_status?: string | null },
  includeChatStatus: boolean,
) {
  const base = serializeFriend(row);
  if (!includeChatStatus) return base;
  return {
    ...base,
    // L-step style "ASP_LP名" — the campaign/landing-page name the friend
    // entered through, attributed once at friend-add time and never
    // overwritten (see migration 022). LEFT JOINed in the list query.
    firstTrackedLinkName: row.first_tracked_link_name ?? null,
    // chats.status defaulted to 'resolved' for friends without a chats row
    // (matches /api/chats listing). Friend-list and chats-list now agree on
    // 未対応/対応中/対応済み state.
    chatStatus: (row.chat_status ?? 'resolved') as 'unread' | 'in_progress' | 'resolved',
  };
}

/** Convert a D1 snake_case Tag row to the shared camelCase shape */
function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

// GET /api/friends - list with pagination
friends.get('/api/friends', async (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    const tagId = c.req.query('tagId');
    const lineAccountId = c.req.query('lineAccountId');
    const search = c.req.query('search');
    const includeTags = c.req.query('includeTags') !== 'false';
    const includeChatStatus = c.req.query('includeChatStatus') === 'true';
    const sort: 'recent' | 'oldest' = c.req.query('sort') === 'oldest' ? 'oldest' : 'recent';
    const handledFilter: 'unhandled' | null =
      c.req.query('handled') === 'unhandled' ? 'unhandled' : null;

    const db = c.env.DB;

    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (tagId) {
      conditions.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(tagId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId);
    }
    if (search) {
      conditions.push('f.display_name LIKE ?');
      binds.push(`%${search}%`);
    }
    if (handledFilter === 'unhandled') {
      conditions.push(
        `COALESCE(
           (SELECT status FROM chats c
            WHERE c.friend_id = f.id
            ORDER BY c.created_at DESC LIMIT 1),
           'resolved'
         ) = 'unread'`,
      );
    }
    const url = new URL(c.req.url);
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('metadata.')) {
        const metaKey = key.slice('metadata.'.length);
        conditions.push(`json_extract(f.metadata, '$.' || ?) = ?`);
        binds.push(metaKey, value);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM friends f ${where}`);
    const totalRow = await (binds.length > 0 ? countStmt.bind(...binds) : countStmt).first<{ count: number }>();
    const total = totalRow?.count ?? 0;

    const baseSelect = includeChatStatus
      ? `f.*, tl.name AS first_tracked_link_name,
         COALESCE(
           (SELECT status FROM chats c
            WHERE c.friend_id = f.id
            ORDER BY c.created_at DESC LIMIT 1),
           'resolved'
         ) AS chat_status`
      : `f.*`;
    const baseFrom = includeChatStatus
      ? `FROM friends f LEFT JOIN tracked_links tl ON tl.id = f.first_tracked_link_id`
      : `FROM friends f`;
    const createdOrder = sort === 'oldest' ? 'ASC' : 'DESC';
    let listStmt;
    let listBinds: unknown[];
    if (search) {
      const exactPattern = search;
      const prefixPattern = `${search}%`;
      const wordStartAscii = `% ${search}%`;
      const wordStartFullWidth = `%　${search}%`;
      listStmt = db.prepare(
        `SELECT ${baseSelect},
                CASE
                  WHEN f.display_name LIKE ? THEN 0
                  WHEN f.display_name LIKE ? THEN 1
                  WHEN f.display_name LIKE ? OR f.display_name LIKE ? THEN 2
                  ELSE 3
                END AS match_score
         ${baseFrom} ${where}
         ORDER BY match_score ASC, f.created_at ${createdOrder}
         LIMIT ? OFFSET ?`,
      );
      listBinds = [exactPattern, prefixPattern, wordStartAscii, wordStartFullWidth, ...binds, limit, offset];
    } else {
      listStmt = db.prepare(
        `SELECT ${baseSelect} ${baseFrom} ${where} ORDER BY f.created_at ${createdOrder} LIMIT ? OFFSET ?`,
      );
      listBinds = [...binds, limit, offset];
    }
    const listResult = await listStmt.bind(...listBinds).all<DbFriend>();
    const items = listResult.results;

    let itemsWithTags = includeTags
      ? await Promise.all(
          items.map(async (friend) => {
            const tags = await getFriendTags(db, friend.id);
            return { ...serializeFriendListRow(friend, includeChatStatus), tags: tags.map(serializeTag) };
          }),
        )
      : items.map((friend) => ({ ...serializeFriendListRow(friend, includeChatStatus), tags: [] }));

    if (includeChatStatus && items.length > 0) {
      const ids = items.map((f) => f.id);
      const placeholders = ids.map(() => '?').join(',');

      type IncomingRow = { friend_id: string; content: string; message_type: string; created_at: string };
      type OutgoingRow = { friend_id: string; max_at: string };
      type ScenarioRow = { friend_id: string; scenario_name: string; status: string };

      const [incomingRes, outgoingRes, scenarioRes] = await Promise.all([
        db
          .prepare(
            `SELECT friend_id, content, message_type, created_at FROM (
               SELECT friend_id, content, message_type, created_at,
                      ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
               FROM messages_log
               WHERE direction = 'incoming' AND friend_id IN (${placeholders})
             ) WHERE rn = 1`,
          )
          .bind(...ids)
          .all<IncomingRow>(),
        db
          .prepare(
            `SELECT friend_id, MAX(created_at) AS max_at FROM messages_log
             WHERE direction = 'outgoing'
               AND (delivery_type IS NULL OR delivery_type != 'test')
               AND friend_id IN (${placeholders})
             GROUP BY friend_id`,
          )
          .bind(...ids)
          .all<OutgoingRow>(),
        db
          .prepare(
            `SELECT fs.friend_id, s.name AS scenario_name, fs.status FROM (
               SELECT friend_id, scenario_id, status,
                      ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY started_at DESC) AS rn
               FROM friend_scenarios
               WHERE status IN ('active', 'delivering') AND friend_id IN (${placeholders})
             ) fs
             JOIN scenarios s ON s.id = fs.scenario_id
             WHERE fs.rn = 1`,
          )
          .bind(...ids)
          .all<ScenarioRow>(),
      ]);

      const incomingByFriend = new Map(incomingRes.results.map((r) => [r.friend_id, r]));
      const outgoingByFriend = new Map(outgoingRes.results.map((r) => [r.friend_id, r.max_at]));
      const scenarioByFriend = new Map(scenarioRes.results.map((r) => [r.friend_id, r]));

      type WithChatStatus = (typeof itemsWithTags)[number] & { chatStatus: 'unread' | 'in_progress' | 'resolved' };
      itemsWithTags = (itemsWithTags as WithChatStatus[]).map((f) => {
        const inc = incomingByFriend.get(f.id);
        const outAt = outgoingByFriend.get(f.id);
        const sc = scenarioByFriend.get(f.id);
        const handled = f.chatStatus !== 'unread';
        return {
          ...f,
          latestIncomingMessage: inc
            ? { content: inc.content, messageType: inc.message_type, createdAt: inc.created_at }
            : null,
          latestOutgoingAt: outAt ?? null,
          activeScenario: sc ? { name: sc.scenario_name, status: sc.status } : null,
          handled,
        };
      });
    }

    return c.json({
      success: true,
      data: {
        items: itemsWithTags,
        total,
        page: Math.floor(offset / limit) + 1,
        limit,
        hasNextPage: offset + limit < total,
      },
    });
  } catch (err) {
    console.error('GET /api/friends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/count - friend count (must be before /:id)
friends.get('/api/friends/count', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let count: number;
    if (lineAccountId) {
      const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND line_account_id = ?')
        .bind(lineAccountId).first<{ count: number }>();
      count = row?.count ?? 0;
    } else {
      count = await getFriendCount(c.env.DB);
    }
    return c.json({ success: true, data: { count } });
  } catch (err) {
    console.error('GET /api/friends/count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/ref-stats - ref code attribution stats
friends.get('/api/friends/ref-stats', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const where = lineAccountId ? 'WHERE line_account_id = ?' : 'WHERE ref_code IS NOT NULL';
    const binds = lineAccountId ? [lineAccountId] : [];
    const stmt = c.env.DB.prepare(
      `SELECT ref_code, COUNT(*) as count FROM friends ${where} AND ref_code IS NOT NULL GROUP BY ref_code ORDER BY count DESC`,
    );
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all<{ ref_code: string; count: number }>();
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM friends ${lineAccountId ? 'WHERE line_account_id = ?' : ''} ${lineAccountId ? 'AND' : 'WHERE'} ref_code IS NOT NULL`,
    ).bind(...(lineAccountId ? [lineAccountId] : [])).first<{ count: number }>();
    return c.json({
      success: true,
      data: {
        routes: result.results.map((r) => ({ refCode: r.ref_code, friendCount: r.count })),
        totalWithRef: total?.count ?? 0,
      },
    });
  } catch (err) {
    console.error('GET /api/friends/ref-stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id - get single friend with tags
friends.get('/api/friends/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const db = c.env.DB;

    const [friend, tags] = await Promise.all([
      getFriendById(db, id),
      getFriendTags(db, id),
    ]);

    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeFriend(friend),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/tags - add tag
friends.post('/api/friends/:id/tags', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ tagId: string }>();

    if (!body.tagId) {
      return c.json({ success: false, error: 'tagId is required' }, 400);
    }

    const db = c.env.DB;
    await addTagToFriend(db, friendId, body.tagId);

    const allScenarios = await getScenarios(db);
    for (const scenario of allScenarios) {
      if (scenario.trigger_type === 'tag_added' && scenario.is_active && scenario.trigger_tag_id === body.tagId) {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friendId, scenario.id)
          .first();
        if (!existing) {
          await enrollFriendInScenario(db, friendId, scenario.id);
        }
      }
    }

    await fireEvent(db, 'tag_change', { friendId, eventData: { tagId: body.tagId, action: 'add' } });

    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error('POST /api/friends/:id/tags error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:id/tags/:tagId - remove tag
friends.delete('/api/friends/:id/tags/:tagId', async (c) => {
  try {
    const friendId = c.req.param('id');
    const tagId = c.req.param('tagId');

    await removeTagFromFriend(c.env.DB, friendId, tagId);

    await fireEvent(c.env.DB, 'tag_change', { friendId, eventData: { tagId, action: 'remove' } });

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friends/:id/tags/:tagId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/metadata - merge metadata fields
friends.put('/api/friends/:id/metadata', async (c) => {
  try {
    const friendId = c.req.param('id');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const existing = JSON.parse(friend.metadata || '{}');
    const merged = { ...existing, ...body };
    const now = jstNow();

    await db
      .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(merged), now, friendId)
      .run();

    const updated = await getFriendById(db, friendId);
    const tags = await getFriendTags(db, friendId);

    return c.json({
      success: true,
      data: {
        ...serializeFriend(updated!),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('PUT /api/friends/:id/metadata error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/messages - get message history
friends.get('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT id, direction, message_type as messageType, content, created_at as createdAt
         FROM messages_log WHERE friend_id = ?
           AND (delivery_type IS NULL OR delivery_type != 'test')
         ORDER BY created_at DESC LIMIT 200`,
      )
      .bind(friendId)
      .all<{ id: string; direction: string; messageType: string; content: string; createdAt: string }>();
    return c.json({ success: true, data: result.results.reverse() });
  } catch (err) {
    console.error('GET /api/friends/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/messages - send message to friend
friends.post('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{
      messageType?: string;
      content: string;
      altText?: string;
    }>();

    if (!body.content) {
      return c.json({ success: false, error: 'content is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if ((friend as unknown as Record<string, unknown>).line_account_id) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, (friend as unknown as Record<string, unknown>).line_account_id as string);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    const messageType = body.messageType ?? 'text';

    const { autoTrackContent } = await import('../services/auto-track.js');
    const tracked = await autoTrackContent(
      db, messageType, body.content,
      c.env.WORKER_URL || new URL(c.req.url).origin,
    );

    const message = buildMessage(tracked.messageType, tracked.content, body.altText);
    await lineClient.pushMessage(friend.line_user_id, [message]);

    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'manual', ?)`,
      )
      .bind(logId, friend.id, messageType, body.content, jstNow())
      .run();

    return c.json({ success: true, data: { messageId: logId } });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('POST /api/friends/:id/messages error:', errMsg);
    return c.json({ success: false, error: errMsg }, 500);
  }
});

export { friends };
