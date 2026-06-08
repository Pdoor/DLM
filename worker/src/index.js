import webpush from 'web-push';

const BUNGIE_BASE_URL = 'https://www.bungie.net';
const BUNGIE_AUTHORIZE_URL = 'https://www.bungie.net/en/OAuth/Authorize';
const BUNGIE_TOKEN_URL = 'https://www.bungie.net/platform/app/oauth/token/';
const FRIENDS_PATH = '/Platform/Social/Friends/';
const GROUP_ID = '5420062';
const GROUP_TYPE_CLAN = 1;
const GROUP_FILTER_ALL = 0;
const D3_PETITION_URL = 'https://www.change.org/p/petition-sony-to-develop-destiny-3';
const FRIEND_DETAILS_COMPONENTS = '200';
const FRIEND_DETAILS_CACHE_TTL_MS = 15 * 60 * 1000;
const ACTIVITY_TEAM_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEASONAL_HUB_COMPONENTS = [
  100, 104, 200, 201, 202, 301, 700, 900, 1200
].join(',');

const SEASONAL_HUB_RECORDS = {
  orders: [],
  daily: [
    390537696,
    444958787,
    3804384646
  ],
  weekly: [
    791269862,
    791269856,
    791269859
  ]
};

const ACTIVE_ORDER_BUCKET_HASH = 635141261;
const BOUNTY_CATEGORY_HASH = 1784235469;

let friendManifestCache = null;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') return corsResponse(null, env);
      if (url.pathname === '/api/config') return await handleConfig(env);
      if (url.pathname === '/api/d3-signatures') return await handleD3Signatures();
      if (url.pathname === '/auth/login') return await handleLogin(request, env);
      if (url.pathname === '/auth/callback') return await handleCallback(request, env);
      if (url.pathname === '/api/subscribe' && request.method === 'POST') return await handleSubscribe(request, env);
      if (url.pathname === '/api/clan-presence') return await handleClanPresence(env);
      if (url.pathname === '/api/friends-status') return await handleFriendsStatus(request, env);
      if (url.pathname === '/api/friends-details') return await handleFriendsDetails(request, env);
      if (url.pathname === '/api/activity-team') return await handleActivityTeam(request, env);
      if (url.pathname === '/api/raid-events' && request.method === 'GET') return await handleRaidEvents(request, env);
      if (url.pathname === '/api/raid-events' && request.method === 'POST') return await handleCreateRaidEvent(request, env);
      if (url.pathname.match(/^\/api\/raid-events\/[^/]+$/) && request.method === 'PUT') return await handleUpdateRaidEvent(request, env);
      if (url.pathname.match(/^\/api\/raid-events\/[^/]+$/) && request.method === 'DELETE') return await handleDeleteRaidEvent(request, env);
      if (url.pathname.match(/^\/api\/raid-events\/[^/]+\/delete$/) && request.method === 'POST') return await handleDeleteRaidEvent(request, env);
      if (url.pathname.match(/^\/api\/raid-events\/[^/]+\/add-member$/) && request.method === 'POST') return await handleAddRaidEventMember(request, env);
      if (url.pathname.match(/^\/api\/raid-events\/[^/]+\/join$/) && request.method === 'POST') return await handleJoinRaidEvent(request, env);
      if (url.pathname.match(/^\/api\/raid-events\/[^/]+\/leave$/) && request.method === 'POST') return await handleLeaveRaidEvent(request, env);
      if (url.pathname === '/api/debug/friends-shape') return await handleFriendsShapeDebug(request, env);
      if (url.pathname === '/api/seasonal-hub') return await handleSeasonalHub(request, env);
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

async function handleD3Signatures() {
  const response = await fetch(D3_PETITION_URL, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
      'User-Agent': 'DestinyLoreMasters/1.0 (+https://pdoor.github.io/DLM/)'
    }
  });
  if (!response.ok) throw new Error(`Change.org error ${response.status}`);

  const html = await response.text();
  const signatures = extractD3SignatureCount(html);
  if (!signatures) throw new Error('D3 signatures unavailable');

  return corsResponse({
    petitionUrl: D3_PETITION_URL,
    signatures,
    checkedAt: new Date().toISOString()
  });
}

async function handleLogin(request, env) {
  assertEnv(env, ['BUNGIE_CLIENT_ID', 'FRONTEND_URL']);
  const url = new URL(request.url);
  const state = createLoginState(url.searchParams.get('returnTo'));

  const authorizeUrl = new URL(BUNGIE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', env.BUNGIE_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', state);
  return Response.redirect(authorizeUrl.toString(), 302);
}

async function handleCallback(request, env) {
  assertEnv(env, ['BUNGIE_CLIENT_ID', 'BUNGIE_API_KEY', 'FRONTEND_URL']);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) return textResponse('Missing code/state', 400);
  const loginState = parseLoginState(state);
  if (!loginState.valid) return textResponse('Invalid OAuth state', 400);

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

  const frontendUrl = new URL(loginState.returnTo || '.', env.FRONTEND_URL);
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

  const status = message === 'Session expired' || message === 'Authentication required' ? 401 : 500;
  return corsResponse({ error: message }, env, status);
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

async function handleFriendsDetails(request, env) {
  assertEnv(env, ['BUNGIE_API_KEY']);
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const locale = url.searchParams.get('locale') || 'it';
  if (!userId) return corsResponse({ error: 'Missing userId' }, env, 400);

  const user = await getUser(env, userId);
  if (!user) return corsResponse({ error: 'Unknown user' }, env, 404);

  const freshUser = await ensureAccessToken(env, user);
  const friends = await bungieFetch(FRIENDS_PATH, env, freshUser.accessToken);
  const friendList = friends.Response?.friends || friends.Response || [];
  const manifest = await getFriendDetailsManifest(env, locale);
  const detailedFriends = await mapLimit(friendList, 2, (friend) => {
    return hydrateFriendDetails(env, freshUser, friend, manifest);
  });

  return corsResponse({
    checkedAt: new Date().toISOString(),
    friends: detailedFriends.filter(Boolean)
  }, env);
}

async function handleActivityTeam(request, env) {
  assertEnv(env, ['BUNGIE_API_KEY']);
  const url = new URL(request.url);
  const instanceId = cleanText(url.searchParams.get('instanceId') || '').replace(/[^\d]/g, '');
  if (!instanceId) return corsResponse({ error: 'Missing instanceId' }, env, 400);

  await ensureActivityTeamCacheTable(env);
  const cached = await getActivityTeamCache(env, instanceId);
  if (cached && Date.now() - cached.updatedAt < ACTIVITY_TEAM_CACHE_TTL_MS) {
    return corsResponse({
      ...cached.report,
      cached: true
    }, env);
  }

  const report = await bungieFetch(`/Platform/Destiny2/Stats/PostGameCarnageReport/${instanceId}/`, env);
  const normalized = normalizeActivityTeam(instanceId, report.Response || {});
  await saveActivityTeamCache(env, instanceId, normalized);
  return corsResponse(normalized, env);
}

async function handleRaidEvents(request, env) {
  const url = new URL(request.url);
  const weekStart = parseWeekStart(url.searchParams.get('weekStart'));
  const userId = url.searchParams.get('userId') || '';
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const viewerKey = userId ? await getPlannerViewerParticipantKey(env, userId) : '';

  const events = await listRaidEvents(env, weekStart.toISOString(), weekEnd.toISOString());
  const participants = events.length
    ? await listRaidParticipants(env, events.map((event) => event.eventId))
    : new Map();

  return corsResponse({
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    events: await Promise.all(events.map(async (event) => {
      const eventParticipants = participants.get(event.eventId) || [];
      const viewerCanManage = await canManageRaidEventForUser(env, event, userId, viewerKey, eventParticipants);
      return {
        ...event,
        viewerJoined: Boolean(eventParticipants.some((participant) => {
          return (viewerKey && participant.userId === viewerKey)
            || (userId && participant.userId === userId)
            || (viewerCanManage && participant.userId === event.creatorUserId);
        })),
        viewerCanManage,
        participants: eventParticipants
      };
    }))
  }, env);
}

async function handleCreateRaidEvent(request, env) {
  const body = await readJsonBody(request);
  const user = await requirePlannerUser(env, body.userId);
  const profile = await getPlannerUserProfile(env, user);
  const event = normalizeRaidEventInput(body, user, profile);
  const selectedMembers = normalizePlannerClanMembers(body.clanMembers, profile, 24);
  const now = Date.now();

  await saveRaidEvent(env, event);
  await saveRaidParticipant(env, event.eventId, createAuthRaidParticipant(user, profile, user.userId, now));
  for (const [index, member] of selectedMembers.entries()) {
    await saveRaidParticipant(env, event.eventId, createClanRaidParticipant(member, user.userId, 'clan', now + index + 1));
  }

  return corsResponse({
    ok: true,
    event: {
      ...event,
      participants: [
        {
          userId: getPlannerParticipantKey(user, profile),
          displayName: profile.displayName,
          membershipId: profile.membershipId,
          participantType: 'auth',
          joinedAt: event.createdAt
        },
        ...selectedMembers.map((member) => ({
          userId: `bungie:${member.membershipId}`,
          displayName: member.displayName,
          membershipId: member.membershipId,
          participantType: 'clan',
          joinedAt: event.createdAt
        }))
      ]
    }
  }, env, 201);
}

async function handleUpdateRaidEvent(request, env) {
  const eventId = getEventIdFromPath(new URL(request.url).pathname);
  const body = await readJsonBody(request);
  const user = await requirePlannerUser(env, body.userId);
  const existing = await getRaidEvent(env, eventId);
  if (!existing) return corsResponse({ error: 'Evento non trovato' }, env, 404);
  const profile = await getPlannerUserProfile(env, user);
  if (!await canManageRaidEventWithProfile(env, existing, user, profile)) {
    return corsResponse({ error: 'Solo il creatore puo modificare questo evento' }, env, 403);
  }
  const updated = {
    ...normalizeRaidEventInput(body, user, profile),
    eventId,
    creatorUserId: existing.creatorUserId,
    creatorName: existing.creatorName,
    status: existing.status,
    createdAt: existing.createdAt,
    updatedAt: Date.now()
  };
  const selectedMembers = normalizePlannerClanMembers(body.clanMembers, profile, 24);
  const now = Date.now();

  await updateRaidEvent(env, updated);
  await deleteRaidParticipantsByType(env, eventId, ['clan', 'reserve']);
  await deleteRaidParticipant(env, eventId, user.userId);
  await saveRaidParticipant(env, eventId, createAuthRaidParticipant(user, profile, user.userId, now));
  for (const [index, member] of selectedMembers.entries()) {
    await saveRaidParticipant(env, eventId, createClanRaidParticipant(member, user.userId, 'clan', now + index + 1));
  }

  return corsResponse({ ok: true, event: updated }, env);
}

async function handleDeleteRaidEvent(request, env) {
  const eventId = getEventIdFromPath(new URL(request.url).pathname);
  const body = await readJsonBody(request);
  const user = await requirePlannerUser(env, body.userId);
  const event = await getRaidEvent(env, eventId);
  if (!event) return corsResponse({ error: 'Evento non trovato' }, env, 404);
  const profile = await getPlannerUserProfile(env, user);
  if (!await canManageRaidEventWithProfile(env, event, user, profile)) {
    return corsResponse({ error: 'Solo il creatore puo eliminare questo evento' }, env, 403);
  }

  await markRaidEventDeleted(env, eventId);
  return corsResponse({ ok: true }, env);
}

async function handleAddRaidEventMember(request, env) {
  const eventId = getEventIdFromPath(new URL(request.url).pathname);
  const body = await readJsonBody(request);
  const user = await requirePlannerUser(env, body.userId);
  const event = await getRaidEvent(env, eventId);
  if (!event) return corsResponse({ error: 'Evento non trovato' }, env, 404);

  const profile = await getPlannerUserProfile(env, user);
  if (!await canManageRaidEventWithProfile(env, event, user, profile)) {
    return corsResponse({ error: 'Solo il promoter puo aggiungere membri' }, env, 403);
  }

  const member = normalizePlannerClanMembers([body.member], profile, 1)[0];
  if (!member) return corsResponse({ error: 'Membro clan non valido' }, env, 400);

  const participants = await listRaidParticipants(env, [eventId]);
  const current = participants.get(eventId) || [];
  const alreadyAdded = current.some((participant) => participant.userId === `bungie:${member.membershipId}`);
  if (alreadyAdded) return corsResponse({ ok: true, duplicate: true }, env);

  const lastJoinedAt = current.reduce((max, participant) => Math.max(max, Number(participant.joinedAt || 0)), 0);
  await saveRaidParticipant(env, eventId, createClanRaidParticipant(member, user.userId, 'clan', Math.max(Date.now(), lastJoinedAt + 1)));
  return corsResponse({ ok: true }, env);
}

async function handleJoinRaidEvent(request, env) {
  const eventId = getEventIdFromPath(new URL(request.url).pathname);
  const body = await readJsonBody(request);
  const user = await requirePlannerUser(env, body.userId);
  const profile = await getPlannerUserProfile(env, user);
  const event = await getRaidEvent(env, eventId);
  if (!event) return corsResponse({ error: 'Evento non trovato' }, env, 404);

  const participants = await listRaidParticipants(env, [eventId]);
  const current = participants.get(eventId) || [];
  const participantKey = getPlannerParticipantKey(user, profile);
  const alreadyJoined = current.some((participant) => participant.userId === participantKey || participant.userId === user.userId);

  await saveRaidParticipant(env, eventId, createAuthRaidParticipant(user, profile, user.userId));
  return corsResponse({ ok: true }, env);
}

async function handleLeaveRaidEvent(request, env) {
  const eventId = getEventIdFromPath(new URL(request.url).pathname);
  const body = await readJsonBody(request);
  const user = await requirePlannerUser(env, body.userId);
  const profile = await getPlannerUserProfile(env, user);
  const event = await getRaidEvent(env, eventId);
  await deleteRaidParticipant(env, eventId, getPlannerParticipantKey(user, profile));
  await deleteRaidParticipant(env, eventId, user.userId);
  if (event && await canManageRaidEventWithProfile(env, event, user, profile)) {
    await deleteRaidParticipant(env, eventId, event.creatorUserId);
  }
  return corsResponse({ ok: true }, env);
}

async function handleFriendsShapeDebug(request, env) {
  const secret = request.headers.get('x-dlm-admin-secret');
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return corsResponse({ error: 'Unauthorized' }, env, 401);
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId') || await getLatestRefreshUserId(env);
  if (!userId) return corsResponse({ error: 'No refresh-token user found' }, env, 404);

  const user = await getUser(env, userId);
  if (!user) return corsResponse({ error: 'Unknown user' }, env, 404);

  const freshUser = await ensureAccessToken(env, user);
  const friends = await bungieFetch(FRIENDS_PATH, env, freshUser.accessToken);
  const friendList = friends.Response?.friends || friends.Response || [];
  const sample = friendList.slice(0, 3).map(summarizeObjectShape);

  return corsResponse({
    checkedAt: new Date().toISOString(),
    userId: freshUser.userId,
    count: friendList.length,
    responseKeys: summarizeObjectShape(friends.Response || {}),
    samples: sample
  }, env);
}

async function handleSeasonalHub(request, env) {
  assertEnv(env, ['BUNGIE_API_KEY']);
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const locale = url.searchParams.get('locale') || 'it';
  if (!userId) return corsResponse({ error: 'Missing userId' }, env, 400);

  const user = await getUser(env, userId);
  if (!user) return corsResponse({ error: 'Unknown user' }, env, 404);

  const freshUser = await ensureAccessToken(env, user);
  const memberships = await bungieFetch('/Platform/User/GetMembershipsForCurrentUser/', env, freshUser.accessToken);
  const membership = chooseDestinyMembership(memberships.Response);
  if (!membership) return corsResponse({ error: 'No Destiny membership found' }, env, 404);

  const profile = await bungieFetch(
    `/Platform/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=${SEASONAL_HUB_COMPONENTS}`,
    env,
    freshUser.accessToken
  );

  const manifest = await getSeasonalManifest(env, locale);
  const itemDefinitions = await getProfileItemDefinitions(env, locale, profile, manifest.objectives);
  const sections = buildSeasonalSections(profile.Response || {}, manifest, itemDefinitions);

  return corsResponse({
    checkedAt: new Date().toISOString(),
    membership: {
      membershipId: String(membership.membershipId || ''),
      membershipType: membership.membershipType,
      displayName: getMembershipDisplayName(membership)
    },
    sections
  }, env);
}

async function getSeasonalManifest(env, locale) {
  const manifest = await bungieFetch('/Platform/Destiny2/Manifest/', env);
  const paths = manifest.Response?.jsonWorldComponentContentPaths;
  const localized = paths?.[locale] || paths?.it || paths?.en;
  if (!localized) throw new Error('Destiny manifest unavailable');

  const [records, objectives] = await Promise.all([
    fetchJson(BUNGIE_BASE_URL + localized.DestinyRecordDefinition),
    fetchJson(BUNGIE_BASE_URL + localized.DestinyObjectiveDefinition)
  ]);

  const rewardItems = await getRecordRewardDefinitions(env, locale, records);
  return { records, objectives, rewardItems };
}

async function getRecordRewardDefinitions(env, locale, records) {
  const hashes = new Set();
  Object.values(SEASONAL_HUB_RECORDS).flat().forEach((recordHash) => {
    const record = records[String(recordHash)];
    (record?.rewardItems || []).forEach((reward) => {
      if (reward.itemHash) hashes.add(reward.itemHash);
    });
  });

  const definitions = {};
  await mapLimit([...hashes], 5, async (hash) => {
    try {
      const data = await bungieFetch(`/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/?lc=${locale}`, env);
      definitions[String(hash)] = data.Response;
    } catch (error) {
      console.warn(`Record reward definition unavailable for ${hash}`, error.message);
    }
  });
  return definitions;
}

async function getProfileItemDefinitions(env, locale, profile, objectives) {
  const hashes = new Set();
  const inventories = profile.Response?.characterInventories?.data || {};
  const itemObjectives = profile.Response?.itemComponents?.objectives?.data || {};

  Object.values(inventories).forEach((inventory) => {
    (inventory.items || []).forEach((item) => {
      if (isExpiredInventoryItem(item)) return;
      const objectiveState = itemObjectives[item.itemInstanceId];
      if (!objectiveState?.objectives?.length && item.bucketHash !== ACTIVE_ORDER_BUCKET_HASH) return;
      hashes.add(item.itemHash);
    });
  });

  const definitions = {};
  await mapLimit([...hashes].slice(0, 160), 5, async (hash) => {
    try {
      const data = await bungieFetch(`/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/?lc=${locale}`, env);
      definitions[String(hash)] = data.Response;
    } catch (error) {
      console.warn(`Item definition unavailable for ${hash}`, error.message);
    }
  });

  const rewardHashes = new Set();
  Object.values(definitions).forEach((definition) => {
    (definition.value?.itemValue || []).forEach((reward) => {
      if (reward.itemHash) rewardHashes.add(reward.itemHash);
    });
  });

  await mapLimit([...rewardHashes], 5, async (hash) => {
    if (definitions[String(hash)]) return;
    try {
      const data = await bungieFetch(`/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/?lc=${locale}`, env);
      definitions[String(hash)] = data.Response;
    } catch (error) {
      console.warn(`Reward definition unavailable for ${hash}`, error.message);
    }
  });

  return definitions;
}

function buildSeasonalSections(profile, manifest, itemDefinitions) {
  const orders = uniqueEntries([
    ...inventoryOrdersToHubEntries(profile, manifest, itemDefinitions)
  ]);
  const daily = uniqueEntries([
    ...SEASONAL_HUB_RECORDS.daily.map((hash) => recordToHubEntry(hash, 'Giornaliero', profile, manifest))
  ]);
  const weekly = uniqueEntries([
    ...SEASONAL_HUB_RECORDS.weekly.map((hash) => recordToHubEntry(hash, 'Settimanale', profile, manifest))
  ]);

  return {
    orders: orders.filter(Boolean).sort(compareHubEntries),
    daily: daily.filter(Boolean),
    weekly: weekly.filter(Boolean)
  };
}

function recordToHubEntry(hash, type, profile, manifest) {
  const def = manifest.records[String(hash)];
  if (!def?.displayProperties) return null;
  const runtime = getRuntimeRecord(profile, hash);
  const objectives = getRecordObjectives(def, runtime, manifest);
  const progress = objectives[0] ? getObjectiveProgress(objectives[0]) : getRuntimeProgress(runtime);
  const resetKind = getResetKind(type);

  return {
    id: `record-${hash}`,
    title: def.displayProperties.name || type,
    description: def.displayProperties.description || '',
    type,
    source: 'Record',
    completed: Boolean(runtime?.state && hasFlag(runtime.state, 1)) || objectives.every((objective) => objective.complete),
    progress,
    expiresAt: parseExpiration(def.expirationInfo) || getNextResetIso(resetKind),
    resetKind,
    rewards: getRewardItems(def.rewardItems || [], manifest.rewardItems)
  };
}

function inventoryOrdersToHubEntries(profile, manifest, itemDefinitions) {
  const inventories = profile.characterInventories?.data || {};
  const itemObjectives = profile.itemComponents?.objectives?.data || {};
  const entries = [];

  Object.values(inventories).forEach((inventory) => {
    (inventory.items || []).forEach((item) => {
      if (isExpiredInventoryItem(item)) return;
      const objectiveState = itemObjectives[item.itemInstanceId];
      if (!objectiveState?.objectives?.length) return;
      const def = itemDefinitions[String(item.itemHash)];
      if (!def?.displayProperties?.name || !isActiveOrderDefinition(def)) return;

      const objectives = objectiveState.objectives.map((objective) => ({
        ...objective,
        completionValue: objective.completionValue
          || manifest.objectives[String(objective.objectiveHash)]?.completionValue
          || 1,
        progressDescription: objective.progressDescription
          || manifest.objectives[String(objective.objectiveHash)]?.progressDescription
          || ''
      }));

      entries.push({
        id: `item-${item.itemInstanceId || item.itemHash}`,
        title: def.displayProperties.name,
        description: def.displayProperties.description || '',
        type: def.inventory?.tierTypeName || def.itemTypeDisplayName || 'Ordine',
        source: 'Inventario',
        completed: objectives.every((objective) => objective.complete),
        progress: getObjectiveProgress(objectives[0]),
        expiresAt: item.expirationDate || null,
        rewards: getItemRewards(def, itemDefinitions)
      });
    });
  });

  return entries;
}

function getItemRewards(def, itemDefinitions) {
  return getRewardItems(def.value?.itemValue || [], itemDefinitions);
}

function getRewardItems(rewards, itemDefinitions) {
  return rewards
    .filter((reward) => reward.itemHash && reward.quantity > 0)
    .map((reward) => {
      const rewardDef = itemDefinitions[String(reward.itemHash)];
      return {
        itemHash: reward.itemHash,
        quantity: reward.quantity,
        conditional: Boolean(reward.hasConditionalVisibility),
        name: rewardDef?.displayProperties?.name || `Ricompensa ${reward.itemHash}`,
        description: rewardDef?.displayProperties?.description || '',
        tier: rewardDef?.inventory?.tierTypeName || '',
        icon: rewardDef?.displayProperties?.icon || ''
      };
    });
}

function isExpiredInventoryItem(item) {
  if (!item.expirationDate) return false;
  const expiresAt = new Date(item.expirationDate).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function getRuntimeRecord(profile, hash) {
  const profileRecord = profile.profileRecords?.data?.records?.[String(hash)];
  if (profileRecord) return profileRecord;

  const characterRecords = profile.characterRecords?.data || {};
  for (const records of Object.values(characterRecords)) {
    const record = records.records?.[String(hash)];
    if (record) return record;
  }
  return null;
}

function getRecordObjectives(def, runtime, manifest) {
  if (runtime?.objectives?.length) {
    return runtime.objectives.map((objective) => ({
      ...objective,
      completionValue: objective.completionValue
        || manifest.objectives[String(objective.objectiveHash)]?.completionValue
        || 1
    }));
  }

  return (def.objectiveHashes || []).map((objectiveHash) => ({
    objectiveHash,
    progress: 0,
    completionValue: manifest.objectives[String(objectiveHash)]?.completionValue || 1,
    complete: false
  }));
}

function getObjectiveProgress(objective) {
  const value = Number(objective.progress || 0);
  const max = Number(objective.completionValue || 0);
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : (objective.complete ? 100 : 0);
  return {
    value,
    max,
    percent,
    label: max > 1 ? `${value}/${max}` : `${percent}%`,
    description: objective.progressDescription || ''
  };
}

function getRuntimeProgress(runtime) {
  const value = Number(runtime?.completedCount || 0);
  const max = Number(runtime?.completionValue || 0);
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return { value, max, percent, label: max ? `${value}/${max}` : `${percent}%` };
}

function isActiveOrderDefinition(def) {
  const typeName = String(def.itemTypeDisplayName || '').toLowerCase();
  const traitIds = def.traitIds || [];
  const categoryHashes = def.itemCategoryHashes || [];

  return def.inventory?.bucketTypeHash === ACTIVE_ORDER_BUCKET_HASH
    && def.itemType === 26
    && typeName.startsWith('ordine')
    && traitIds.includes('item.bounty')
    && categoryHashes.includes(BOUNTY_CATEGORY_HASH);
}

function chooseDestinyMembership(response) {
  const memberships = response?.destinyMemberships || [];
  if (!memberships.length) return null;
  const primaryId = response?.primaryMembershipId;
  const crossSaveType = memberships.find((item) => item.crossSaveOverride)?.crossSaveOverride;
  return memberships.find((item) => item.membershipId === primaryId)
    || memberships.find((item) => item.membershipType === crossSaveType)
    || memberships.find((item) => item.membershipType === 3)
    || memberships[0];
}

function getMembershipDisplayName(membership) {
  const name = membership.bungieGlobalDisplayName || membership.displayName || 'Guardiano';
  const code = membership.bungieGlobalDisplayNameCode ? `#${membership.bungieGlobalDisplayNameCode}` : '';
  return `${name}${code}`;
}

function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function compareHubEntries(a, b) {
  const aRank = getOrderTierRank(a.type);
  const bRank = getOrderTierRank(b.type);
  if (aRank !== bRank) return aRank - bRank;
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  return a.title.localeCompare(b.title, 'it');
}

function getOrderTierRank(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('leggenda')) return 0;
  if (normalized.includes('esotico')) return 1;
  if (normalized.includes('comune')) return 2;
  return 3;
}

function hasFlag(value, flag) {
  return (Number(value) & flag) === flag;
}

function parseExpiration(expirationInfo) {
  if (!expirationInfo?.hasExpiration) return null;
  return expirationInfo.expirationDate || expirationInfo.description || null;
}

function getResetKind(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('giornal')) return 'daily';
  if (normalized.includes('settiman')) return 'weekly';
  return '';
}

function getNextResetIso(resetKind) {
  if (!resetKind) return null;

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(17, 0, 0, 0);

  if (resetKind === 'daily') {
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }

  if (resetKind === 'weekly') {
    const targetDay = 2;
    let daysUntilTuesday = (targetDay - next.getUTCDay() + 7) % 7;
    if (daysUntilTuesday === 0 && next <= now) daysUntilTuesday = 7;
    next.setUTCDate(next.getUTCDate() + daysUntilTuesday);
    return next.toISOString();
  }

  return null;
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

async function getFriendDetailsManifest(env, locale) {
  const now = Date.now();
  if (friendManifestCache?.locale === locale && friendManifestCache.expiresAt > now) {
    return friendManifestCache.value;
  }

  const manifest = await bungieFetch('/Platform/Destiny2/Manifest/', env);
  const paths = manifest.Response?.jsonWorldComponentContentPaths;
  const localized = paths?.[locale] || paths?.it || paths?.en;
  if (!localized) throw new Error('Destiny manifest unavailable');

  const [classes, activities, records] = await Promise.all([
    fetchJson(BUNGIE_BASE_URL + localized.DestinyClassDefinition),
    fetchJson(BUNGIE_BASE_URL + localized.DestinyActivityDefinition),
    fetchJson(BUNGIE_BASE_URL + localized.DestinyRecordDefinition)
  ]);

  const value = { classes, activities, records };
  friendManifestCache = {
    locale,
    value,
    expiresAt: now + 6 * 60 * 60 * 1000
  };
  return value;
}

async function hydrateFriendDetails(env, user, friend, manifest) {
  const friendId = getFriendId(friend);
  if (!friendId) return null;

  const fallback = getFriendFallback(friend);
  const cached = await getFriendDetailsCache(env, user.userId, friendId);
  if (cached && Date.now() - cached.updatedAt < FRIEND_DETAILS_CACHE_TTL_MS) {
    return {
      ...cached.details,
      displayName: fallback.displayName || cached.details.displayName,
      isOnline: fallback.isOnline
    };
  }

  try {
    const membership = await resolveFriendDestinyMembership(friend, env, user.accessToken);
    if (!membership?.membershipId || !membership?.membershipType) {
      await saveFriendDetailsCache(env, user.userId, friendId, fallback);
      return fallback;
    }

    const profile = await bungieFetch(
      `/Platform/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=${FRIEND_DETAILS_COMPONENTS}`,
      env,
      user.accessToken
    );
    const characters = Object.values(profile.Response?.characters?.data || {});
    if (!characters.length) {
      await saveFriendDetailsCache(env, user.userId, friendId, fallback);
      return fallback;
    }

    const lastCharacter = characters.reduce((latest, current) => {
      return new Date(current.dateLastPlayed) > new Date(latest.dateLastPlayed) ? current : latest;
    });

    const activities = await getRecentActivities(env, membership, lastCharacter.characterId, manifest.activities, user.accessToken);
    const clan = await getMemberClan(env, membership, user.accessToken);
    const details = {
      ...fallback,
      id: friendId,
      membershipId: String(membership.membershipId || fallback.membershipId || ''),
      membershipType: membership.membershipType,
      className: manifest.classes[String(lastCharacter.classHash)]?.displayProperties?.name || fallback.className,
      title: getTitleName(lastCharacter, manifest.records),
      classIcon: lastCharacter.emblemBackgroundPath
        ? BUNGIE_BASE_URL + lastCharacter.emblemBackgroundPath
        : fallback.classIcon,
      powerLevel: lastCharacter.light || 0,
      lastPlayedTimestamp: new Date(lastCharacter.dateLastPlayed).getTime() || 0,
      lastActivityTimestamp: activities[0]
        ? new Date(activities[0].period).getTime() || 0
        : new Date(lastCharacter.dateLastPlayed).getTime() || 0,
      lastActivityText: activities[0]
        ? `${activities[0].name} il ${formatDate(activities[0].period)}`
        : `Ultimo accesso il ${formatDate(lastCharacter.dateLastPlayed)}`,
      clanName: clan.name,
      clanCallsign: clan.callsign,
      clanGroupId: clan.groupId,
      activities
    };

    await saveFriendDetailsCache(env, user.userId, friendId, details);
    return details;
  } catch (error) {
    console.warn(`Friend details unavailable for ${fallback.displayName}`, error.message);
    if (!cached) await saveFriendDetailsCache(env, user.userId, friendId, fallback);
    return cached
      ? { ...cached.details, displayName: fallback.displayName || cached.details.displayName, isOnline: fallback.isOnline }
      : fallback;
  }
}

async function resolveFriendDestinyMembership(friend, env, accessToken) {
  const candidates = getFriendMembershipCandidates(friend);
  if (candidates.length) return candidates[0];

  const bungieNetMembershipId = friend.bungieNetMembershipId || friend.membershipId;
  if (!bungieNetMembershipId) return null;

  try {
    const data = await bungieFetch(`/Platform/User/GetMembershipsById/${bungieNetMembershipId}/254/`, env, accessToken);
    return chooseDestinyMembership(data.Response);
  } catch (error) {
    console.warn(`Friend membership resolution failed for ${bungieNetMembershipId}`, error.message);
    return null;
  }
}

function getFriendMembershipCandidates(friend) {
  const candidates = [];
  const directMembershipId = friend.destinyMembershipId || friend.lastSeenAsMembershipId || friend.membershipId;
  const directMembershipType = friend.destinyMembershipType || friend.lastSeenAsBungieMembershipType || friend.membershipType;
  if (directMembershipId && directMembershipType && Number(directMembershipType) !== 254) {
    candidates.push({
      membershipId: String(directMembershipId),
      membershipType: Number(directMembershipType),
      displayName: getFriendName(friend)
    });
  }

  const memberships = friend.destinyMemberships || friend.memberships || [];
  memberships.forEach((membership) => {
    if (membership?.membershipId && membership?.membershipType && Number(membership.membershipType) !== 254) {
      candidates.push({
        membershipId: String(membership.membershipId),
        membershipType: Number(membership.membershipType),
        displayName: getMembershipDisplayName(membership)
      });
    }
  });

  return candidates;
}

async function getRecentActivities(env, membership, characterId, activityDefinitions, accessToken) {
  try {
    const activityData = await bungieFetch(
      `/Platform/Destiny2/${membership.membershipType}/Account/${membership.membershipId}/Character/${characterId}/Stats/Activities/?count=10`,
      env,
      accessToken
    );
    return (activityData.Response?.activities || []).map((activity) => ({
      name: getActivityName(activity, activityDefinitions),
      period: activity.period,
      instanceId: String(activity.activityDetails?.instanceId || '')
    }));
  } catch (error) {
    console.warn(`Recent activities unavailable for ${membership.membershipId}`, error.message);
    return [];
  }
}

async function getMemberClan(env, membership, accessToken) {
  try {
    const data = await bungieFetch(
      `/Platform/GroupV2/User/${membership.membershipType}/${membership.membershipId}/${GROUP_FILTER_ALL}/${GROUP_TYPE_CLAN}/`,
      env,
      accessToken
    );
    const result = data.Response?.results?.[0];
    const group = result?.group || result;
    return {
      name: group?.name || '',
      callsign: group?.clanInfo?.clanCallsign || group?.clanCallsign || '',
      groupId: String(group?.groupId || '')
    };
  } catch (error) {
    console.warn(`Clan unavailable for ${membership.membershipId}`, error.message);
    return { name: '', callsign: '', groupId: '' };
  }
}

function getFriendFallback(friend) {
  const displayName = getFriendName(friend);
  return {
    id: getFriendId(friend),
    membershipId: String(friend.destinyMembershipId || friend.lastSeenAsMembershipId || friend.membershipId || ''),
    membershipType: Number(friend.destinyMembershipType || friend.lastSeenAsBungieMembershipType || friend.membershipType || 0),
    bungieNetMembershipId: String(friend.bungieNetMembershipId || friend.bungieNetUser?.membershipId || ''),
    displayName,
    isOnline: isOnline(friend),
    className: 'Amico Bungie',
    title: '',
    classIcon: 'dlm.ico',
    powerLevel: 0,
    lastPlayedTimestamp: 0,
    lastActivityTimestamp: 0,
    lastActivityText: isOnline(friend) ? 'Online' : 'Nessuna attività recente',
    clanName: '',
    clanCallsign: '',
    clanGroupId: '',
    activities: []
  };
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
  if (!user.refreshToken) {
    throw new Error('Session expired');
  }

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

async function requirePlannerUser(env, userId) {
  if (!userId) throw new Error('Authentication required');
  const user = await getUser(env, userId);
  if (!user) throw new Error('Authentication required');
  return ensureAccessToken(env, user);
}

async function getPlannerUserProfile(env, user) {
  try {
    const memberships = await bungieFetch('/Platform/User/GetMembershipsForCurrentUser/', env, user.accessToken);
    const membership = chooseDestinyMembership(memberships.Response);
    return {
      membershipId: String(membership?.membershipId || user.bungieMembershipId || ''),
      displayName: membership ? getMembershipDisplayName(membership) : 'Guardiano'
    };
  } catch (error) {
    console.warn(`Planner profile unavailable for ${user.userId}`, error.message);
    return {
      membershipId: user.bungieMembershipId || '',
      displayName: 'Guardiano'
    };
  }
}

async function getPlannerViewerParticipantKey(env, userId) {
  try {
    const user = await getUser(env, userId);
    if (!user) return '';
    const freshUser = await ensureAccessToken(env, user);
    const profile = await getPlannerUserProfile(env, freshUser);
    return getPlannerParticipantKey(freshUser, profile);
  } catch {
    return '';
  }
}

function getPlannerParticipantKey(user, profile) {
  return profile.membershipId ? `bungie:${profile.membershipId}` : `user:${user.userId}`;
}

function canManageRaidEvent(event, userId, viewerKey, participants) {
  if (!userId) return false;
  if (event.creatorUserId === userId) return true;
  if (!viewerKey) return false;
  return participants.some((participant) => {
    return participant.participantType === 'auth'
      && participant.addedByUserId === event.creatorUserId
      && participant.userId === viewerKey;
  });
}

async function canManageRaidEventForUser(env, event, userId, viewerKey, participants) {
  if (canManageRaidEvent(event, userId, viewerKey, participants)) return true;
  if (!userId || !event.creatorUserId) return false;

  try {
    const [viewer, creator] = await Promise.all([
      getUser(env, userId),
      getUser(env, event.creatorUserId)
    ]);
    return Boolean(
      viewer?.bungieMembershipId
      && creator?.bungieMembershipId
      && viewer.bungieMembershipId === creator.bungieMembershipId
    );
  } catch {
    return false;
  }
}

async function canManageRaidEventWithProfile(env, event, user, profile) {
  const participantKey = getPlannerParticipantKey(user, profile);
  if (event.creatorUserId === user.userId) return true;
  const participants = await listRaidParticipants(env, [event.eventId]);
  return canManageRaidEventForUser(env, event, user.userId, participantKey, participants.get(event.eventId) || []);
}

function createAuthRaidParticipant(user, profile, addedByUserId, joinedAt) {
  return {
    participantKey: getPlannerParticipantKey(user, profile),
    displayName: profile.displayName,
    membershipId: profile.membershipId || '',
    participantType: 'auth',
    addedByUserId,
    joinedAt
  };
}

function createClanRaidParticipant(member, addedByUserId, participantType = 'clan', joinedAt) {
  return {
    participantKey: `bungie:${member.membershipId}`,
    displayName: member.displayName,
    membershipId: member.membershipId,
    participantType,
    addedByUserId,
    joinedAt
  };
}

function normalizePlannerClanMembers(value, profile, maxMembers, extraExcludedMembers = []) {
  const members = Array.isArray(value) ? value : [];
  const seen = new Set([
    String(profile.membershipId || ''),
    ...extraExcludedMembers.map((member) => String(member.membershipId || ''))
  ].filter(Boolean));
  const normalized = [];

  for (const member of members) {
    const membershipId = cleanText(member?.membershipId);
    const displayName = cleanText(member?.displayName).slice(0, 80);
    if (!membershipId || !displayName || seen.has(membershipId)) continue;
    seen.add(membershipId);
    normalized.push({ membershipId, displayName });
    if (normalized.length >= maxMembers) break;
  }

  return normalized;
}

function normalizeRaidEventInput(body, user, profile) {
  const title = cleanText(body.title).slice(0, 80);
  const activity = cleanText(body.activity || 'Raid').slice(0, 60);
  const description = cleanText(body.description).slice(0, 280);
  const startsAt = new Date(body.startsAt);
  const durationMinutes = clampNumber(body.durationMinutes, 60, 360, 120);
  const maxPlayers = clampNumber(body.maxPlayers, 2, 12, 6);
  const now = Date.now();

  if (!title) throw new Error('Titolo evento obbligatorio');
  if (Number.isNaN(startsAt.getTime())) throw new Error('Data evento non valida');

  return {
    eventId: createId(),
    title,
    activity,
    description,
    startsAt: startsAt.toISOString(),
    durationMinutes,
    maxPlayers,
    creatorUserId: user.userId,
    creatorName: profile.displayName,
    status: 'scheduled',
    createdAt: now,
    updatedAt: now
  };
}

function parseWeekStart(value) {
  const source = value ? new Date(`${value}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(source.getTime())) throw new Error('Settimana non valida');
  source.setUTCHours(0, 0, 0, 0);
  const day = source.getUTCDay() || 7;
  source.setUTCDate(source.getUTCDate() - day + 1);
  return source;
}

function getEventIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/raid-events\/([^/]+)(?:\/|$)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
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

async function readJsonBody(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function extractD3SignatureCount(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const patterns = [
    /Sign petition\s*#+?\s*([\d,.]+)\s*Verified signatures/i,
    /([\d,.]+)\s*Verified signatures/i,
    /"signature_count"\s*:\s*(\d+)/i,
    /"signatureCount"\s*:\s*(\d+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern) || String(html || '').match(pattern);
    const value = match?.[1] ? Number(match[1].replace(/[^\d]/g, '')) : 0;
    if (Number.isFinite(value) && value > 0) return value;
  }

  return 0;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

async function getFriendDetailsCache(env, userId, friendId) {
  const row = await env.DLM_DB.prepare(`
    SELECT details_json, updated_at
    FROM friend_details_cache
    WHERE user_id = ? AND friend_id = ?
  `).bind(userId, friendId).first();
  if (!row) return null;
  return {
    details: JSON.parse(row.details_json),
    updatedAt: row.updated_at || 0
  };
}

async function saveFriendDetailsCache(env, userId, friendId, details) {
  await env.DLM_DB.prepare(`
    INSERT INTO friend_details_cache (
      user_id, friend_id, details_json, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, friend_id) DO UPDATE SET
      details_json = excluded.details_json,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    friendId,
    JSON.stringify(details),
    Date.now()
  ).run();
}

async function ensureActivityTeamCacheTable(env) {
  await env.DLM_DB.prepare(`
    CREATE TABLE IF NOT EXISTS activity_team_cache (
      instance_id TEXT PRIMARY KEY,
      report_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();
}

async function getActivityTeamCache(env, instanceId) {
  const row = await env.DLM_DB.prepare(`
    SELECT report_json, updated_at
    FROM activity_team_cache
    WHERE instance_id = ?
  `).bind(instanceId).first();
  if (!row) return null;
  return {
    report: JSON.parse(row.report_json),
    updatedAt: row.updated_at || 0
  };
}

async function saveActivityTeamCache(env, instanceId, report) {
  await env.DLM_DB.prepare(`
    INSERT INTO activity_team_cache (
      instance_id, report_json, updated_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      report_json = excluded.report_json,
      updated_at = excluded.updated_at
  `).bind(
    instanceId,
    JSON.stringify(report),
    Date.now()
  ).run();
}

async function listRaidEvents(env, startIso, endIso) {
  const { results } = await env.DLM_DB.prepare(`
    SELECT event_id, title, activity, description, starts_at, duration_minutes, max_players,
      creator_user_id, creator_name, status, created_at, updated_at
    FROM raid_events
    WHERE starts_at >= ? AND starts_at < ? AND status = 'scheduled'
    ORDER BY starts_at ASC, created_at ASC
  `).bind(startIso, endIso).all();
  return results.map(raidEventFromRow);
}

async function getRaidEvent(env, eventId) {
  const row = await env.DLM_DB.prepare(`
    SELECT event_id, title, activity, description, starts_at, duration_minutes, max_players,
      creator_user_id, creator_name, status, created_at, updated_at
    FROM raid_events
    WHERE event_id = ?
  `).bind(eventId).first();
  return row ? raidEventFromRow(row) : null;
}

async function saveRaidEvent(env, event) {
  await env.DLM_DB.prepare(`
    INSERT INTO raid_events (
      event_id, title, activity, description, starts_at, duration_minutes, max_players,
      creator_user_id, creator_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.eventId,
    event.title,
    event.activity,
    event.description || '',
    event.startsAt,
    event.durationMinutes,
    event.maxPlayers,
    event.creatorUserId,
    event.creatorName,
    event.status,
    event.createdAt,
    event.updatedAt
  ).run();
}

async function updateRaidEvent(env, event) {
  await env.DLM_DB.prepare(`
    UPDATE raid_events
    SET title = ?,
      activity = ?,
      description = ?,
      starts_at = ?,
      duration_minutes = ?,
      max_players = ?,
      updated_at = ?
    WHERE event_id = ?
  `).bind(
    event.title,
    event.activity,
    event.description || '',
    event.startsAt,
    event.durationMinutes,
    event.maxPlayers,
    event.updatedAt || Date.now(),
    event.eventId
  ).run();
}

async function markRaidEventDeleted(env, eventId) {
  await env.DLM_DB.prepare(`
    UPDATE raid_events
    SET status = 'deleted',
      updated_at = ?
    WHERE event_id = ?
  `).bind(Date.now(), eventId).run();
}

async function listRaidParticipants(env, eventIds) {
  const placeholders = eventIds.map(() => '?').join(',');
  const { results } = await env.DLM_DB.prepare(`
    SELECT event_id, user_id, display_name, membership_id, participant_type, added_by_user_id, joined_at
    FROM raid_participants
    WHERE event_id IN (${placeholders})
    ORDER BY joined_at ASC
  `).bind(...eventIds).all();

  const map = new Map();
  results.forEach((row) => {
    const eventId = row.event_id;
    if (!map.has(eventId)) map.set(eventId, []);
    map.get(eventId).push({
      userId: row.user_id,
      displayName: row.display_name,
      membershipId: row.membership_id || '',
      participantType: row.participant_type || 'auth',
      addedByUserId: row.added_by_user_id || '',
      joinedAt: row.joined_at
    });
  });
  return map;
}

async function saveRaidParticipant(env, eventId, participant) {
  await env.DLM_DB.prepare(`
    INSERT INTO raid_participants (
      event_id, user_id, display_name, membership_id, participant_type, added_by_user_id, joined_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET
      display_name = excluded.display_name,
      membership_id = excluded.membership_id,
      participant_type = excluded.participant_type,
      added_by_user_id = excluded.added_by_user_id
  `).bind(
    eventId,
    participant.participantKey,
    participant.displayName,
    participant.membershipId || '',
    participant.participantType || 'auth',
    participant.addedByUserId || '',
    participant.joinedAt || Date.now()
  ).run();
}

async function deleteRaidParticipant(env, eventId, participantKey) {
  await env.DLM_DB.prepare(`
    DELETE FROM raid_participants
    WHERE event_id = ? AND user_id = ?
  `).bind(eventId, participantKey).run();
}

async function deleteRaidParticipantsByType(env, eventId, participantTypes) {
  const placeholders = participantTypes.map(() => '?').join(',');
  await env.DLM_DB.prepare(`
    DELETE FROM raid_participants
    WHERE event_id = ? AND participant_type IN (${placeholders})
  `).bind(eventId, ...participantTypes).run();
}

function raidEventFromRow(row) {
  return {
    eventId: row.event_id,
    title: row.title,
    activity: row.activity,
    description: row.description || '',
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    maxPlayers: row.max_players,
    creatorUserId: row.creator_user_id,
    creatorName: row.creator_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getLatestRefreshUserId(env) {
  const row = await env.DLM_DB.prepare(`
    SELECT user_id
    FROM users
    WHERE refresh_token IS NOT NULL AND refresh_token != ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).first();
  return row?.user_id || '';
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
  return String(
    friend.destinyMembershipId
    || friend.lastSeenAsMembershipId
    || friend.membershipId
    || friend.bungieNetMembershipId
    || friend.bungieNetUser?.membershipId
    || friend.bungieGlobalDisplayNameCode
    || ''
  );
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

function getTitleName(character, recordDefinitions) {
  const titleRecordHash = character.titleRecordHash;
  if (!titleRecordHash) return '';

  const titleInfo = recordDefinitions[String(titleRecordHash)]?.titleInfo;
  const byGender = titleInfo?.titlesByGender || {};
  const byGenderHash = titleInfo?.titlesByGenderHash || {};
  const genderType = String(character.genderType);
  const genderHash = String(character.genderHash);

  return byGender[genderType]
    || byGenderHash[genderHash]
    || Object.values(byGender)[0]
    || Object.values(byGenderHash)[0]
    || '';
}

function getActivityName(activity, activityDefinitions) {
  const details = activity.activityDetails || {};
  const hash = details.directorActivityHash || details.activityHash || details.referenceId;
  return activityDefinitions[String(hash)]?.displayProperties?.name || 'Attività sconosciuta';
}

function normalizeActivityTeam(instanceId, report) {
  const entries = Array.isArray(report.entries) ? report.entries : [];
  const teams = Array.isArray(report.teams) ? report.teams : [];
  const teamNames = new Map(teams.map((team) => {
    const teamId = String(team.teamId ?? team.teamName ?? '');
    const name = cleanText(team.teamName || team.standing?.basic?.displayValue || '');
    return [teamId, name];
  }));

  return {
    instanceId,
    period: report.period || '',
    activityName: cleanText(report.activityDetails?.activityName || ''),
    players: entries.map((entry) => {
      const player = entry.player || {};
      const info = player.destinyUserInfo || {};
      const values = entry.values || {};
      const teamId = String(entry.teamId ?? values.team?.basic?.value ?? '');
      return {
        displayName: getMembershipDisplayName(info),
        membershipId: String(info.membershipId || ''),
        membershipType: Number(info.membershipType || 0),
        emblemPath: cleanText(player.iconPath || player.emblemPath || ''),
        className: cleanText(player.characterClass || ''),
        lightLevel: Number(player.lightLevel || 0),
        teamId,
        teamName: teamNames.get(teamId) || '',
        completed: Boolean(Number(values.completed?.basic?.value || 0)),
        kills: Number(values.kills?.basic?.value || 0),
        deaths: Number(values.deaths?.basic?.value || 0),
        assists: Number(values.assists?.basic?.value || 0),
        score: Number(values.score?.basic?.value || 0)
      };
    }).filter((player) => player.displayName && player.displayName !== 'Guardiano')
  };
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString('it-IT') + ' ' + date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function summarizeObjectShape(value, depth = 0) {
  if (!value || typeof value !== 'object') return typeof value;
  if (depth >= 2) return Array.isArray(value) ? 'array' : 'object';

  const entries = Object.entries(value).slice(0, 40).map(([key, item]) => {
    if (Array.isArray(item)) {
      return [key, {
        type: 'array',
        length: item.length,
        itemShape: item[0] && typeof item[0] === 'object'
          ? summarizeObjectShape(item[0], depth + 1)
          : typeof item[0]
      }];
    }
    if (item && typeof item === 'object') {
      return [key, {
        type: 'object',
        shape: summarizeObjectShape(item, depth + 1)
      }];
    }
    return [key, { type: typeof item }];
  });

  return Object.fromEntries(entries);
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

function createLoginState(returnTo) {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  if (!safeReturnTo) return createId();
  return `${createId()}.${btoa(safeReturnTo).replace(/=+$/g, '')}`;
}

function parseLoginState(state) {
  const [nonce, encodedReturnTo] = String(state || '').split('.', 2);
  if (!nonce || nonce.length < 16) return { valid: false, returnTo: '' };
  if (!encodedReturnTo) return { valid: true, returnTo: '' };

  try {
    const padded = encodedReturnTo.padEnd(Math.ceil(encodedReturnTo.length / 4) * 4, '=');
    return { valid: true, returnTo: sanitizeReturnTo(atob(padded)) };
  } catch {
    return { valid: true, returnTo: '' };
  }
}

function sanitizeReturnTo(returnTo) {
  const value = String(returnTo || '').trim();
  if (!value || value.startsWith('/') || value.includes('://') || value.includes('\\')) return '';
  if (value.includes('..')) return '';
  return value.slice(0, 120);
}

function assertEnv(env, names) {
  for (const name of names) {
    if (!env[name]) throw new Error(`Missing env var: ${name}`);
  }
}

function corsResponse(body, env, status = 200) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-dlm-admin-secret'
    }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}
