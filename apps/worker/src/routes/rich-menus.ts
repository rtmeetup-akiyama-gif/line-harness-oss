import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { getFriendById, getLineAccountById } from '@line-crm/db';
import type { Env } from '../index.js';

const richMenus = new Hono<Env>();

/** Resolve LINE access token — uses accountId query param if provided, otherwise default */
async function resolveLineClient(c: { env: Env['Bindings']; req: { query(key: string): string | undefined } }): Promise<LineClient> {
  const accountId = c.req.query('accountId');
  if (accountId) {
    const account = await getLineAccountById(c.env.DB, accountId);
    if (account) return new LineClient(account.channel_access_token);
  }
  return new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
}

// GET /api/rich-menus — list all rich menus from LINE API
richMenus.get('/api/rich-menus', async (c) => {
  try {
    const lineClient = await resolveLineClient(c);
    const result = await lineClient.getRichMenuList();
    return c.json({ success: true, data: result.richmenus ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus error:', message);
    return c.json({ success: false, error: `Failed to fetch rich menus: ${message}` }, 500);
  }
});

// POST /api/rich-menus — create a rich menu via LINE API
richMenus.post('/api/rich-menus', async (c) => {
  try {
    const body = await c.req.json();
    const lineClient = await resolveLineClient(c);
    const result = await lineClient.createRichMenu(body);
    return c.json({ success: true, data: result }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus error:', message);
    return c.json({ success: false, error: `Failed to create rich menu: ${message}` }, 500);
  }
});

// DELETE /api/rich-menus/:id — delete a rich menu
richMenus.delete('/api/rich-menus/:id', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const lineClient = await resolveLineClient(c);
    await lineClient.deleteRichMenu(richMenuId);
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/rich-menus/:id error:', message);
    return c.json({ success: false, error: `Failed to delete rich menu: ${message}` }, 500);
  }
});

// POST /api/rich-menus/:id/default — set rich menu as default for all users
richMenus.post('/api/rich-menus/:id/default', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const lineClient = await resolveLineClient(c);
    await lineClient.setDefaultRichMenu(richMenuId);
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/:id/default error:', message);
    return c.json({ success: false, error: `Failed to set default rich menu: ${message}` }, 500);
  }
});
// POST /api/rich-menus/bulk-unlink — clear individually-linked rich menus for
// every follower on an account, so the account-wide default rich menu takes
// effect for everyone.
//
// WHY THIS EXISTS: a friend can have a rich menu linked *directly to them*
// (via linkRichMenuToUser), which LINE always prefers over the account-wide
// default (setDefaultRichMenu). Migrating off another tool (e.g. エルメ) that
// individually links a menu per-follower means our new default silently does
// nothing for anyone who already has an individual link — the old menu (and
// its old tap actions/message text) keeps showing. This endpoint uses LINE's
// official bulk-unlink endpoint (POST /v2/bot/richmenu/bulk/unlink, max 500
// user IDs per call) to clear those individual links account-wide; everyone
// then falls back to whatever is currently set as the account default.
// Safe/idempotent: unlinking a user with no individual link is a no-op on
// LINE's side.
richMenus.post('/api/rich-menus/bulk-unlink', async (c) => {
  try {
    const body = await c.req.json<{ accountId?: string }>();
    if (!body.accountId) {
      return c.json({ success: false, error: 'accountId is required' }, 400);
    }
    const account = await getLineAccountById(c.env.DB, body.accountId);
    if (!account) {
      return c.json({ success: false, error: 'line account not found' }, 404);
    }

    const result = await c.env.DB
      .prepare(`SELECT line_user_id FROM friends WHERE line_account_id = ? AND is_following = 1`)
      .bind(body.accountId)
      .all<{ line_user_id: string }>();
    const userIds = result.results.map((r) => r.line_user_id);

    let unlinked = 0;
    const errors: { chunk: number; error: string }[] = [];
    const CHUNK_SIZE = 500; // LINE's max per bulk-unlink call
    for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
      const chunk = userIds.slice(i, i + CHUNK_SIZE);
      const res = await fetch('https://api.line.me/v2/bot/richmenu/bulk/unlink', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${account.channel_access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userIds: chunk }),
      });
      if (res.ok) {
        unlinked += chunk.length;
      } else {
        errors.push({ chunk: i / CHUNK_SIZE + 1, error: `${res.status} ${await res.text()}` });
      }
    }

    return c.json({ success: true, data: { totalFriends: userIds.length, unlinked, errorCount: errors.length, errors } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/bulk-unlink error:', message);
    return c.json({ success: false, error: message }, 500);
  }
});
</parameter>
// POST /api/friends/:friendId/rich-menu — link rich menu to a specific friend
richMenus.post('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ richMenuId: string }>();

    if (!body.richMenuId) {
      return c.json({ success: false, error: 'richMenuId is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const friendAccountId = (friend as unknown as Record<string, string | null>).line_account_id;
    if (friendAccountId) {
      const account = await getLineAccountById(db, friendAccountId);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    await lineClient.linkRichMenuToUser(friend.line_user_id, body.richMenuId);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to link rich menu to friend: ${message}` }, 500);
  }
});

// DELETE /api/friends/:friendId/rich-menu — unlink rich menu from a specific friend
richMenus.delete('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const friendAccId = (friend as unknown as Record<string, string | null>).line_account_id;
    if (friendAccId) {
      const account = await getLineAccountById(c.env.DB, friendAccId);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    await lineClient.unlinkRichMenuFromUser(friend.line_user_id);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to unlink rich menu from friend: ${message}` }, 500);
  }
});

// GET /api/friends/:friendId/rich-menu — get rich menu currently linked to a friend
richMenus.get('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const friendAccId = (friend as unknown as Record<string, string | null>).line_account_id;
    if (friendAccId) {
      const account = await getLineAccountById(db, friendAccId);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);

    // 個別メニュー取得 — 404 (個別未設定) のみ null に正規化。トークン期限切れ
    // / 5xx 等の真のエラーは外側 catch に伝搬させて 500 を返す。null と「取得失敗」
    // を混同すると運用者にデフォルトメニューが偽表示される。
    let userMenuId: string | null = null;
    try {
      const r = await lineClient.getRichMenuIdOfUser(friend.line_user_id);
      userMenuId = r.richMenuId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) {
        userMenuId = null;
      } else {
        throw err;
      }
    }

    // 個別未設定ならデフォルトを fallback。getDefaultRichMenuId は client.ts 側で
    // 404 を null に変換済 (Task 1)、その他のエラーは throw され外側 catch に流れる。
    let isDefault = false;
    let effectiveId: string | null = userMenuId;
    if (!userMenuId) {
      effectiveId = await lineClient.getDefaultRichMenuId();
      isDefault = !!effectiveId;
    }

    // メニュー名は LINE API のリストから lookup (rich_menus DB テーブルは無い)
    let name: string | null = null;
    if (effectiveId) {
      try {
        const list = await lineClient.getRichMenuList();
        const found = (list.richmenus ?? []).find((m) => m.richMenuId === effectiveId);
        name = found?.name ?? null;
      } catch {
        // silent — 名前は出せないが id だけは返す
      }
    }

    return c.json({
      success: true,
      data: { id: effectiveId, name, isDefault },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to fetch friend rich menu: ${message}` }, 500);
  }
});

export { richMenus };

// POST /api/rich-menus/:id/image — upload rich menu image (accepts base64 body or binary)
richMenus.post('/api/rich-menus/:id/image', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const contentType = c.req.header('content-type') ?? '';

    let imageData: ArrayBuffer;
    let imageContentType: 'image/png' | 'image/jpeg' = 'image/png';

    if (contentType.includes('application/json')) {
      // Accept base64 encoded image in JSON body
      const body = await c.req.json<{ image: string; contentType?: string }>();
      if (!body.image) {
        return c.json({ success: false, error: 'image (base64) is required' }, 400);
      }
      // Strip data URI prefix if present
      const base64 = body.image.replace(/^data:image\/\w+;base64,/, '');
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      imageData = bytes.buffer;
      if (body.contentType === 'image/jpeg') imageContentType = 'image/jpeg';
    } else if (contentType.includes('image/')) {
      // Accept raw binary upload
      imageData = await c.req.arrayBuffer();
      imageContentType = contentType.includes('jpeg') || contentType.includes('jpg') ? 'image/jpeg' : 'image/png';
    } else {
      return c.json({ success: false, error: 'Content-Type must be application/json (with base64) or image/png or image/jpeg' }, 400);
    }

    const lineClient = await resolveLineClient(c);
    await lineClient.uploadRichMenuImage(richMenuId, imageData, imageContentType);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/:id/image error:', message);
    return c.json({ success: false, error: `Failed to upload rich menu image: ${message}` }, 500);
  }
});
