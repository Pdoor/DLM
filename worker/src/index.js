import webpush from 'web-push';

const BUNGIE_BASE_URL = 'https://www.bungie.net';
const BUNGIE_AUTHORIZE_URL = 'https://www.bungie.net/en/OAuth/Authorize';
const BUNGIE_TOKEN_URL = 'https://www.bungie.net/platform/app/oauth/token/';
const FRIENDS_PATH = '/Platform/Social/Friends/';
const USER_PREFIX = 'user:';
const SUB_PREFIX = 'sub:';
const PRESENCE_PREFIX = 'presence:';
const STATE_PREFIX = 'state:';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') return corsResponse(null, env);
      if (url.pathname === '/api/config') return handleConfig(env);
      if (url.pathname === '/auth/login') return handleLogin(env);
      if (url.pathname === '/auth/callback') return handleCallback(request, env);
      if (url.pathname === '/api/subscribe' && request.method === 'POST') return handleSubscribe(request, env);
      if (url.pathname === '/api/check-now' && request.method === 'POST') return handleCheckNow(request, env);

      return corsResponse({ error: 'Not found' }, env, 404);
    } catch (error) {
      console.error('Request failed', error);
      return corsResponse({ error: error.message || 'Worker error' }, env, 500);
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
  const state = crypto.randomUUID();
  await env.DLM_OAUTH_STATES.put(`${STATE_PREFIX}${state}`, JSON.stringify({ createdAt: Date.now() }), {
    expirationTtl: 10 * 60
  });

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

  const stateKey = `${STATE_PREFIX}${state}`;
  const storedState = await env.DLM_OAUTH_STATES.get(stateKey);
  if (!storedState) return textResponse('Invalid or expired OAuth state', 400);
  await env.DLM_OAUTH_STATES.delete(stateKey);

  const token = await exchangeCodeForToken(code, env);
  const bungieMembershipId = String(token.membership_id || token.membershipId || crypto.randomUUID());
  const userId = crypto.randomUUID();
  await env.DLM_USERS.put(`${USER_PREFIX}${userId}`, JSON.stringify({
    userId,
    bungieMembershipId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + ((token.expires_in || 3600) - 120) * 1000,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }));

  const frontendUrl = new URL(env.FRONTEND_URL);
  frontendUrl.searchParams.set('dlmUser', userId);
  return Response.redirect(frontendUrl.toString(), 302);
}

async function handleSubscribe(request, env) {
  const body = await request.json();
  if (!body.userId || !body.subscription?.endpoint) {
    return corsResponse({ error: 'Invalid subscription payload' }, env, 400);
  }

  const user = await getUser(env, body.userId);
  if (!user) return corsResponse({ error: 'Unknown user' }, env, 404);

  const subId = await sha256(body.subscription.endpoint);
  await env.DLM_PUSH_SUBSCRIPTIONS.put(`${SUB_PREFIX}${body.userId}:${subId}`, JSON.stringify({
    userId: body.userId,
    subscription: body.subscription,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }));

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

async function checkAllUsers(env) {
  assertEnv(env, ['BUNGIE_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
  const users = await listJson(env.DLM_USERS, USER_PREFIX);
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

    const presenceKey = `${PRESENCE_PREFIX}${freshUser.userId}:${friendId}`;
    const previous = await env.DLM_PRESENCE.get(presenceKey, 'json');
    const current = {
      online: isOnline(friend),
      name: getFriendName(friend),
      onlineTitle: friend.onlineTitle || 0,
      checkedAt: Date.now()
    };

    await env.DLM_PRESENCE.put(presenceKey, JSON.stringify(current));

    if (current.online && !previous?.online) {
      await notifyUser(env, freshUser.userId, {
        title: 'Amico online',
        body: `${current.name} è online su Bungie.`,
        url: env.FRONTEND_URL || '/'
      });
    }
  }
}

async function notifyUser(env, userId, payload) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const subscriptions = await listJson(env.DLM_PUSH_SUBSCRIPTIONS, `${SUB_PREFIX}${userId}:`);

  for (const item of subscriptions) {
    try {
      await webpush.sendNotification(item.subscription, JSON.stringify(payload));
    } catch (error) {
      console.error('Push failed', error?.statusCode || error?.message || error);
      if ([404, 410].includes(error?.statusCode)) {
        const subId = await sha256(item.subscription.endpoint);
        await env.DLM_PUSH_SUBSCRIPTIONS.delete(`${SUB_PREFIX}${userId}:${subId}`);
      }
    }
  }
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
  await env.DLM_USERS.put(`${USER_PREFIX}${user.userId}`, JSON.stringify(updated));
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
  const response = await fetch(`${BUNGIE_BASE_URL}${path}`, {
    headers: {
      'X-API-Key': env.BUNGIE_API_KEY,
      'Authorization': `Bearer ${accessToken}`
    }
  });
  if (!response.ok) throw new Error(`Bungie API error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  if (data.ErrorCode && data.ErrorCode !== 1) {
    throw new Error(data.Message || `Bungie API error ${data.ErrorCode}`);
  }
  return data;
}

async function getUser(env, userId) {
  return env.DLM_USERS.get(`${USER_PREFIX}${userId}`, 'json');
}

async function listJson(namespace, prefix) {
  const results = [];
  let cursor;
  do {
    const page = await namespace.list({ prefix, cursor });
    cursor = page.cursor;
    for (const key of page.keys) {
      const item = await namespace.get(key.name, 'json');
      if (item) results.push(item);
    }
  } while (cursor);
  return results;
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

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
