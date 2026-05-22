const fs = require("node:fs/promises");
const path = require("node:path");

const API_KEY = process.env.BUNGIE_API_KEY || "81224e7b397c4b5e9601d8183066729c";
const BUNGIE_BASE_URL = "https://www.bungie.net";
const WARMIND_PLAYER_ACTIVITY_URL = "https://api.warmind.io/in/playerActivity";
const GROUP_ID = "5420062";
const REMOTE_GROUP_ID = "6761737";
const PVP_BUCKETS = new Set(["crucible", "private-crucible", "pvp-new"]);
const PVE_BUCKETS = new Set([
  "dungeon",
  "lost-sectors",
  "nhunts",
  "nightfall",
  "offensives",
  "pve-new",
  "raid",
  "strikes"
]);

async function main() {
  const manifest = await bungieFetch("/Platform/Destiny2/Manifest/");
  const paths = manifest.Response.jsonWorldComponentContentPaths.it
    || manifest.Response.jsonWorldComponentContentPaths.en;

  const [classes, activityDefinitions, recordDefinitions] = await Promise.all([
    fetchJson(BUNGIE_BASE_URL + paths.DestinyClassDefinition),
    fetchJson(BUNGIE_BASE_URL + paths.DestinyActivityDefinition),
    fetchJson(BUNGIE_BASE_URL + paths.DestinyRecordDefinition)
  ]);

  const members = await getAllClanMembers();
  const hydratedMembers = await mapLimit(members, 2, (member) => {
    return hydrateMember(member, classes, activityDefinitions, recordDefinitions);
  });

  hydratedMembers.sort(compareMembers);

  const payload = {
    generatedAt: new Date().toISOString(),
    clanName: "Destiny Lore Masters",
    groupId: GROUP_ID,
    remoteGroupId: REMOTE_GROUP_ID,
    members: hydratedMembers
  };

  const dataDir = path.join(process.cwd(), "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "clan-status.json"),
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  console.log(`Generated data/clan-status.json with ${hydratedMembers.length} members.`);

  try {
    const playerActivity = await getWarmindPlayerActivity();
    await fs.writeFile(
      path.join(dataDir, "player-activity.json"),
      JSON.stringify(playerActivity, null, 2),
      "utf8"
    );
    console.log("Generated data/player-activity.json from Warmind.");
  } catch (error) {
    console.warn(`Warmind player activity unavailable: ${error.message}`);
  }
}

async function getAllClanMembers() {
  const members = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await bungieFetch(`/Platform/GroupV2/${GROUP_ID}/Members/?currentpage=${page}`);
    members.push(...(data.Response.results || []));
    hasMore = Boolean(data.Response.hasMore);
    page += 1;
  }

  return members;
}

async function hydrateMember(member, classes, activityDefinitions, recordDefinitions) {
  const displayName = getDisplayName(member);
  const fallback = {
    displayName,
    membershipId: String(member.destinyUserInfo?.membershipId || ""),
    bungieNetMembershipId: String(member.destinyUserInfo?.bungieNetMembershipId || ""),
    isOnline: Boolean(member.isOnline),
    className: "Guardiano",
    title: "",
    classIcon: "dlm.ico",
    powerLevel: 0,
    lastPlayedTimestamp: 0,
    lastActivityTimestamp: 0,
    lastActivityText: "Nessuna attivita recente",
    activities: []
  };

  try {
    const info = member.destinyUserInfo;
    const profile = await bungieFetch(`/Platform/Destiny2/${info.membershipType}/Profile/${info.membershipId}/?components=200`);
    const characters = Object.values(profile.Response?.characters?.data || {});
    if (!characters.length) return fallback;

    const lastCharacter = characters.reduce((latest, current) => {
      return new Date(current.dateLastPlayed) > new Date(latest.dateLastPlayed) ? current : latest;
    });

    const activityData = await bungieFetch(`/Platform/Destiny2/${info.membershipType}/Account/${info.membershipId}/Character/${lastCharacter.characterId}/Stats/Activities/?count=10`);
    const activities = (activityData.Response?.activities || []).map((activity) => ({
      name: getActivityName(activity, activityDefinitions),
      period: activity.period
    }));

    return {
      ...fallback,
      className: classes[String(lastCharacter.classHash)]?.displayProperties?.name || "Guardiano",
      title: getTitleName(lastCharacter, recordDefinitions),
      classIcon: lastCharacter.emblemBackgroundPath
        ? BUNGIE_BASE_URL + lastCharacter.emblemBackgroundPath
        : "dlm.ico",
      powerLevel: lastCharacter.light || 0,
      lastPlayedTimestamp: new Date(lastCharacter.dateLastPlayed).getTime() || 0,
      lastActivityTimestamp: activities[0]
        ? new Date(activities[0].period).getTime() || 0
        : new Date(lastCharacter.dateLastPlayed).getTime() || 0,
      lastActivityText: activities[0]
        ? `${activities[0].name} il ${formatDate(activities[0].period)}`
        : `Ultimo accesso il ${formatDate(lastCharacter.dateLastPlayed)}`,
      activities
    };
  } catch (error) {
    console.warn(`Details unavailable for ${displayName}: ${error.message}`);
    return fallback;
  }
}

function getTitleName(character, recordDefinitions) {
  const titleRecordHash = character.titleRecordHash;
  if (!titleRecordHash) return "";

  const titleInfo = recordDefinitions[String(titleRecordHash)]?.titleInfo;
  const byGender = titleInfo?.titlesByGender || {};
  const byGenderHash = titleInfo?.titlesByGenderHash || {};
  const genderType = String(character.genderType);
  const genderHash = String(character.genderHash);

  return byGender[genderType]
    || byGenderHash[genderHash]
    || Object.values(byGender)[0]
    || Object.values(byGenderHash)[0]
    || "";
}

function getDisplayName(member) {
  const info = member.destinyUserInfo || {};
  const name = info.bungieGlobalDisplayName || info.displayName || "Guardiano";
  const code = info.bungieGlobalDisplayNameCode ? `#${info.bungieGlobalDisplayNameCode}` : "";
  return `${name}${code}`;
}

function getActivityName(activity, activityDefinitions) {
  const details = activity.activityDetails || {};
  const hash = details.directorActivityHash || details.activityHash || details.referenceId;
  return activityDefinitions[String(hash)]?.displayProperties?.name || "Attivita sconosciuta";
}

function compareMembers(a, b) {
  const aTime = a.lastActivityTimestamp || a.lastPlayedTimestamp || 0;
  const bTime = b.lastActivityTimestamp || b.lastPlayedTimestamp || 0;
  if (aTime !== bTime) return bTime - aTime;
  return a.displayName.localeCompare(b.displayName, "it");
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleDateString("it-IT") + " " + date.toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function bungieFetch(pathname) {
  return fetchJson(BUNGIE_BASE_URL + pathname, {
    headers: { "X-API-Key": API_KEY }
  });
}

async function getWarmindPlayerActivity() {
  const data = await fetchJson(WARMIND_PLAYER_ACTIVITY_URL, {
    headers: {
      Accept: "application/json",
      Referer: "https://warmind.io/activity",
      "User-Agent": "DLM clan dashboard"
    }
  });
  const response = data.response || {};
  const modes = response.activityByModeType || {};
  const pve = sumModeScores(modes, PVE_BUCKETS);
  const pvp = sumModeScores(modes, PVP_BUCKETS);
  const gambit = Number(modes["gambit-new"]?.rawScore || 0);

  return {
    generatedAt: new Date().toISOString(),
    source: "Warmind.io",
    sourceUrl: "https://warmind.io/activity",
    windowSizeInSec: Number(response.windowSizeInSec || 0),
    averageConcurrentPlayers: Number(response.averageConcurrentPlayers || 0),
    pvePlayers: pve,
    pvpPlayers: pvp,
    gambitPlayers: gambit
  };
}

function sumModeScores(modes, buckets) {
  return Object.entries(modes).reduce((total, [bucket, value]) => {
    return buckets.has(bucket) ? total + Number(value?.rawScore || 0) : total;
  }, 0);
}

async function fetchJson(url, options = {}) {
  const retryStatuses = [429, 500, 502, 503, 504];
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const body = await response.text();
        const error = new Error(`HTTP ${response.status}: ${body.slice(0, 250)}`);
        error.status = response.status;
        throw error;
      }

      const data = await response.json();
      if (data.ErrorCode && data.ErrorCode !== 1) {
        const error = new Error(data.Message || `Bungie error ${data.ErrorCode}`);
        error.status = data.ErrorCode;
        throw error;
      }

      return data;
    } catch (error) {
      lastError = error;
      if (!retryStatuses.includes(error.status) || attempt === 2) break;
      await delay(1000 * (attempt + 1));
    }
  }

  throw lastError;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
