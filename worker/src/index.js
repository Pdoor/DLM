import webpush from 'web-push';

const BUNGIE_BASE_URL = 'https://www.bungie.net';
const BUNGIE_AUTHORIZE_URL = 'https://www.bungie.net/en/OAuth/Authorize';
const BUNGIE_TOKEN_URL = 'https://www.bungie.net/platform/app/oauth/token/';
const FRIENDS_PATH = '/Platform/Social/Friends/';
const GROUP_ID = '5420062';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') return corsResponse(null, env);
      if (url.pathname === '/api/config') return await handleConfig(env);
      if (url.pathname === '/auth/login') return await handleLogin(env);
      if (url.pathname === '/auth/callback') return await handleCallback(request, env);
      if (url.pathname === '/api/subscribe' && request.method === 'POST') return await handleSubscribe(request, env);
      if (url.pathname === '/api/clan-presence') return await handleClanPresence(env);
      if (url.pathname === '/api/friends-status') return await handleFriendsStatus(request, env);
      if (url.pathname === '/api/check-now' && request.method === 'POST') return await handleCheckNow(request, env);

      return corsResponse({ error: 'Not found' }, env, 404);
    } catch (error) {
      console.error('Request failed', error);
      return handleWorkerError(request, env, error);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkAllUsers(env));
  }
};

async function handleConfig(env) {
  return corsResponse({ vapidPublicKey: env.VAPID_PUBLIC_KEY }, env);
}

async function handleLogin(env) {
  assertEnv(env, ['BUNGIE_CLIENT_ID', 'FRONTEND_URL']);
  const state = createId();

  const url = new URL(BUNGIE_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.BUNGIE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return Response.redirect(url.toString(), 302);
}

async function handleCallback(request, env) {
  assertEnv(env, ['BUNGIE_CLIENT_ID', 'BUNGIE_API_KEY', 'FRONTEND_URL']);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) return textResponse('Missing code/state', 400);
  if (state.length < 16) return textResponse('Invalid OAuth state', 400);

  const token = await exchangeCodeForToken(code, env);
  const bungieMembershipId = String(token.membership_id || token.membershipId || createId());
  const userId = createId();
  await saveUser(env, {
    userId,
    bungieMembershipId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + ((token.expires_in || 3600) - 120) * 1000,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  const frontendUrl = new URL(env.FRONTEND_URL);
  frontendUrl.searchParams.set('dlmUser', userId);
  return Response.redirect(frontendUrl.toString(), 302);
}

function handleWorkerError(request, env, error) {
  const message = error.message || 'Worker error';
  const url = new URL(request.url);
  if (url.pathname.startsWith('/auth/')) {
    try {
      const frontendUrl = new URL(env.FRONTEND_URL || 'https://pdoor.github.io/DLM/');
      frontendUrl.searchParams.set('dlmAuthError', message.slice(0, 180));
      return Response.redirect(frontendUrl.toString(), 302);
    } catch {
      return textResponse(message, 500);
    }
  }

  return corsResponse({ error: message }, env, 500);
}

async function handleSubscribe(request, env) {
  assertEnv(env, ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
  const body = await request.json();
  if (!body.userId || !body.subscription?.endpoint) {
    return corsResponse({ error: 'Invalid subscription payload' }, env, 400);
  }

  const user = await getUser(env, body.userId);
  if (!user) return corsResponse({ error: 'Unknown user' }, env, 404);

  const subId = await sha256(body.subscription.endpoint);
  await savePushSubscription(env, {
    userId: body.userId,
    subId,
    subscription: body.subscription,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  try {
    await sendPush(body.subscription, env, {
      title: 'Destiny Lore Masters',
      body: 'Notifiche attivate su questo dispositivo.',
      url: env.FRONTEND_URL || '/'
    });
  } catch (error) {
    await deletePushSubscription(env, body.userId, subId);
    console.error('Test push failed', error?.statusCode || error?.message || error);
    return corsResponse({ error: 'Test notifica non riuscito' }, env, 502);
  }

  return corsResponse({ ok: true }, env);
}

async function handleCheckNow(request, env) {
  const secret = request.headers.get('x-dlm-admin-secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return corsResponse({ error: 'Unauthorized' }, env, 401);
  }
  await checkAllUsers(env);
  return corsResponse({ ok: true }, env);
}

async function handleFriendsStatus(request, env) {
  assertEnv(env, ['BUNGIE_API_KEY']);
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return corsResponse({ error: 'Missing userId' }, env, 400);

  const user = await getUser(env, userId);
  if (!user) return corsResponse({ error: 'Unknown user' }, env, 404);

  const freshUser = await ensureAccessToken(env, user);
  const friends = await bungieFetch(FRIENDS_PATH, env, freshUser.accessToken);
  const friendList = friends.Response?.friends || friends.Response || [];
  return corsResponse({
    checkedAt: new Date().toISOString(),
    friends: friendList.map((friend) => ({
      id: getFriendId(friend),
      membershipId: String(friend.membershipId || friend.destinyMembershipId || ''),
      bungieNetMembershipId: String(friend.bungieNetMembershipId || ''),
      displayName: getFriendName(friend),
      isOnline: isOnline(friend),
      onlineTitle: friend.onlineTitle || 0
    }))
  }, env);
}

async function handleClanPresence(env) {
  assertEnv(env, ['BUNGIE_API_KEY']);
  const members = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await bungieFetch(`/Platform/GroupV2/${GROUP_ID}/Members/?currentpage=${page}`, env);
    members.push(...(data.Response?.results || []));
    hasMore = Boolean(data.Response?.hasMore);
    page += 1;
  }

  return corsResponse({
    checkedAt: new Date().toISOString(),
    members: members.map((member) => ({
      id: getMemberId(member),
      membershipId: String(member.destinyUserInfo?.membershipId || member.membershipId || ''),
      bungieNetMembershipId: String(member.destinyUserInfo?.bungieNetMembershipId || member.bungieNetMembershipId || ''),
      displayName: getMemberName(member),
      isOnline: Boolean(member.isOnline)
    }))
  }, env);
}

async function checkAllUsers(env) {
  assertEnv(env, ['BUNGIE_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
  const users = await listUsers(env);
  for (const user of users) {
    await checkUserFriends(env, user).catch((error) => {
      console.error(`Friend check failed for ${user.userId}`, error);
    });
  }
}

async function checkUserFriends(env, user) {
  const freshUser = await ensureAccessToken(env, user);
  const friends = await bungieFetch(FRIENDS_PATH, env, freshUser.accessToken);
  const friendList = friends.Response?.friends || friends.Response || [];

  for (const friend of friendList) {
    const friendId = getFriendId(friend);
    if (!friendId) continue;

    const previous = await getPresence(env, freshUser.userId, friendId);
    const current = {
      online: isOnline(friend),
      name: getFriendName(friend),
      onlineTitle: friend.onlineTitle || 0,
      checkedAt: Date.now()
    };

    if (current.online && !previous?.online) {
      await notifyUser(env, freshUser.userId, {
        title: 'Amico online',
        body: `${current.name} è online su Bungie.`,
        url: env.FRONTEND_URL || '/'
      });
    }
    const changed = !previous
      || previous.online !== current.online
      || previous.name !== current.name
      || previous.onlineTitle !== current.onlineTitle;

    if (changed) {
      await savePresence(env, freshUser.userId, friendId, current);
    }
  }
}

async function notifyUser(env, userId, payload) {
  const subscriptions = await listPushSubscriptions(env, userId);

  for (const item of subscriptions) {
    try {
      await sendPush(item.subscription, env, payload);
    } catch (error) {
      console.error('Push failed', error?.statusCode || error?.message || error);
      if ([404, 410].includes(error?.statusCode)) {
        const subId = await sha256(item.subscription.endpoint);
        await deletePushSubscription(env, userId, subId);
      }
    }
  }
}

async function sendPush(subscription, env, payload) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  return webpush.sendNotification(subscription, JSON.stringify(payload));
}

async function ensureAccessToken(env, user) {
  if (user.expiresAt && user.expiresAt > Date.now()) return user;

  const token = await refreshToken(user.refreshToken, env);
  const updated = {
    ...user,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || user.refreshToken,
    expiresAt: Date.now() + ((token.expires_in || 3600) - 120) * 1000,
    updatedAt: Date.now()
  };
  await saveUser(env, updated);
  return updated;
}

async function exchangeCodeForToken(code, env) {
  const params = {
    grant_type: 'authorization_code',
    code,
    client_id: env.BUNGIE_CLIENT_ID
  };
  if (env.BUNGIE_CLIENT_SECRET) params.client_secret = env.BUNGIE_CLIENT_SECRET;
  return tokenRequest(params);
}

async function refreshToken(refreshTokenValue, env) {
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: env.BUNGIE_CLIENT_ID
  };
  if (env.BUNGIE_CLIENT_SECRET) params.client_secret = env.BUNGIE_CLIENT_SECRET;
  return tokenRequest(params);
}

async function tokenRequest(params) {
  const response = await fetch(BUNGIE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  if (!response.ok) throw new Error(`Bungie token error ${response.status}: ${await response.text()}`);
  return response.json();
}

async function bungieFetch(path, env, accessToken) {
  const headers = { 'X-API-Key': env.BUNGIE_API_KEY };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${BUNGIE_BASE_URL}${path}`, { headers });
  if (!response.ok) throw new Error(`Bungie API error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  if (data.ErrorCode && data.ErrorCode !== 1) {
    throw new Error(data.Message || `Bungie API error ${data.ErrorCode}`);
  }
  return data;
}

async function getUser(env, userId) {
  const row = await env.DLM_DB.prepare(`
    SELECT user_id, bungie_membership_id, access_token, refresh_token, expires_at, created_at, updated_at
    FROM users
    WHERE user_id = ?
  `).bind(userId).first();
  return row ? userFromRow(row) : null;
}

async function saveUser(env, user) {
  await env.DLM_DB.prepare(`
    INSERT INTO users (
      user_id, bungie_membership_id, access_token, refresh_token, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      bungie_membership_id = excluded.bungie_membership_id,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).bind(
    user.userId,
    user.bungieMembershipId || '',
    user.accessToken,
    user.refreshToken || '',
    user.expiresAt,
    user.createdAt || Date.now(),
    user.updatedAt || Date.now()
  ).run();
}

async function listUsers(env) {
  const { results } = await env.DLM_DB.prepare(`
    SELECT user_id, bungie_membership_id, access_token, refresh_token, expires_at, created_at, updated_at
    FROM users
  `).all();
  return results.map(userFromRow);
}

async function savePushSubscription(env, item) {
  await env.DLM_DB.prepare(`
    INSERT INTO push_subscriptions (
      user_id, sub_id, subscription_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, sub_id) DO UPDATE SET
      subscription_json = excluded.subscription_json,
      updated_at = excluded.updated_at
  `).bind(
    item.userId,
    item.subId,
    JSON.stringify(item.subscription),
    item.createdAt || Date.now(),
    item.updatedAt || Date.now()
  ).run();
}

async function listPushSubscriptions(env, userId) {
  const { results } = await env.DLM_DB.prepare(`
    SELECT subscription_json
    FROM push_subscriptions
    WHERE user_id = ?
  `).bind(userId).all();
  return results.map((row) => ({ subscription: JSON.parse(row.subscription_json) }));
}

async function deletePushSubscription(env, userId, subId) {
  await env.DLM_DB.prepare(`
    DELETE FROM push_subscriptions
    WHERE user_id = ? AND sub_id = ?
  `).bind(userId, subId).run();
}

async function getPresence(env, userId, friendId) {
  const row = await env.DLM_DB.prepare(`
    SELECT online, name, online_title, checked_at
    FROM presence
    WHERE user_id = ? AND friend_id = ?
  `).bind(userId, friendId).first();
  if (!row) return null;
  return {
    online: Boolean(row.online),
    name: row.name || '',
    onlineTitle: row.online_title || 0,
    checkedAt: row.checked_at || 0
  };
}

async function savePresence(env, userId, friendId, presence) {
  await env.DLM_DB.prepare(`
    INSERT INTO presence (
      user_id, friend_id, online, name, online_title, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, friend_id) DO UPDATE SET
      online = excluded.online,
      name = excluded.name,
      online_title = excluded.online_title,
      checked_at = excluded.checked_at
  `).bind(
    userId,
    friendId,
    presence.online ? 1 : 0,
    presence.name || '',
    presence.onlineTitle || 0,
    presence.checkedAt || Date.now()
  ).run();
}

function userFromRow(row) {
  return {
    userId: row.user_id,
    bungieMembershipId: row.bungie_membership_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getFriendId(friend) {
  return String(friend.membershipId || friend.bungieNetMembershipId || friend.destinyMembershipId || friend.bungieGlobalDisplayNameCode || '');
}

function getFriendName(friend) {
  const name = friend.bungieGlobalDisplayName || friend.displayName || friend.name || 'Un amico';
  const code = friend.bungieGlobalDisplayNameCode ? `#${friend.bungieGlobalDisplayNameCode}` : '';
  return `${name}${code}`;
}

function isOnline(friend) {
  return friend.onlineStatus === 1 || friend.onlineStatus === 'Online';
}

function getMemberId(member) {
  const info = member.destinyUserInfo || member;
  return String(info.membershipId || info.bungieNetMembershipId || info.bungieGlobalDisplayNameCode || '');
}

function getMemberName(member) {
  const info = member.destinyUserInfo || member;
  const name = info.bungieGlobalDisplayName || info.displayName || member.displayName || 'Guardiano';
  const code = info.bungieGlobalDisplayNameCode ? `#${info.bungieGlobalDisplayNameCode}` : '';
  return `${name}${code}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertEnv(env, names) {
  for (const name of names) {
    if (!env[name]) throw new Error(`Missing env var: ${name}`);
  }
}

function corsResponse(body, env, status = 200) {
  const allowedOrigin = env.FRONTEND_URL ? new URL(env.FRONTEND_URL).origin : '*';
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-dlm-admin-secret'
    }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}
