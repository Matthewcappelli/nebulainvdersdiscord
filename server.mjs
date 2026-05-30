import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import pg from "pg";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const clientId = process.env.DISCORD_CLIENT_ID || "1509412850450567248";
const botToken = process.env.DISCORD_BOT_TOKEN;
const leaderboardPath = join(root, "data", "leaderboard.json");
const settingsPath = join(root, "data", "guild-settings.json");
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("railway.internal") ? false : { rejectUnauthorized: false }
    })
  : null;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
let discordClient = null;

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname === "/install" || url.pathname === "/invite") {
      redirectToInstall(response);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    serveStatic(request, response, url);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Server error" });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Sakura Invaders running on 0.0.0.0:${port}`);
});

startDiscordBot();

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { discordClientId: clientId });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/leaderboard") {
    const scope = getLeaderboardScope(url.searchParams.get("guildId"));
    const leaderboard = await readLeaderboard(scope.scopeId);
    sendJson(response, 200, { leaderboard: leaderboard.slice(0, 10) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/token") {
    await exchangeDiscordToken(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/score") {
    await submitScore(request, response);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function redirectToInstall(response) {
  const installUrl = new URL("https://discord.com/oauth2/authorize");
  installUrl.searchParams.set("client_id", clientId);
  installUrl.searchParams.set("scope", "bot applications.commands");
  installUrl.searchParams.set("permissions", "3072");
  installUrl.searchParams.set("integration_type", "0");

  response.writeHead(302, {
    location: installUrl.toString(),
    "cache-control": "no-store"
  });
  response.end();
}

async function exchangeDiscordToken(request, response) {
  const { code } = await readJsonBody(request);
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!clientSecret) {
    sendJson(response, 503, { error: "Missing DISCORD_CLIENT_SECRET" });
    return;
  }

  if (!code || typeof code !== "string") {
    sendJson(response, 400, { error: "Missing authorization code" });
    return;
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code
    })
  });
  const payload = await tokenResponse.json();

  if (!tokenResponse.ok || !payload.access_token) {
    const detail = cleanDiscordError(payload);
    console.warn("Discord token exchange failed", tokenResponse.status, detail);
    sendJson(response, 401, {
      error: "Discord authorization failed",
      detail
    });
    return;
  }

  sendJson(response, 200, { access_token: payload.access_token });
}

async function submitScore(request, response) {
  const body = await readJsonBody(request);
  const score = Number(body.score);
  const accessToken = String(body.accessToken || "");
  const context = sanitizeContext(body.context || {});

  if (!Number.isInteger(score) || score < 0 || score > 9999999) {
    sendJson(response, 400, { error: "Invalid score" });
    return;
  }

  if (!accessToken) {
    sendJson(response, 401, { error: "Discord authentication required" });
    return;
  }

  const user = await fetchDiscordUser(accessToken);
  if (!user) {
    sendJson(response, 401, { error: "Invalid Discord access token" });
    return;
  }

  const entry = {
    scopeId: getLeaderboardScope(context.guildId).scopeId,
    userId: user.id,
    username: cleanName(user.global_name || user.username || "Discord Player"),
    avatar: user.avatar || null,
    score,
    lastScore: score,
    updatedAt: new Date().toISOString(),
    context
  };

  const savedEntry = await saveScore(entry);
  const leaderboard = await readLeaderboard(entry.scopeId);
  announceScore(savedEntry);
  sendJson(response, 200, { leaderboard: leaderboard.slice(0, 10), entry: savedEntry });
}

async function fetchDiscordUser(accessToken) {
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!userResponse.ok) return null;
  return userResponse.json();
}

function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(root, pathname));

  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": types[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 20000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function readLeaderboard(scopeId = "global") {
  if (pool) return readSqlLeaderboard(scopeId);

  try {
    const raw = await readFile(leaderboardPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => (entry.scopeId || "global") === scopeId)
      .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
  } catch {
    return [];
  }
}

async function saveScore(entry) {
  if (pool) return saveSqlScore(entry);

  const leaderboard = await readFileLeaderboard();
  const existing = leaderboard.find((item) => item.userId === entry.userId && (item.scopeId || "global") === entry.scopeId);
  const savedEntry = {
    ...entry,
    score: existing ? Math.max(existing.score, entry.score) : entry.score
  };
  const next = existing
    ? leaderboard.map((item) => (item.userId === entry.userId && (item.scopeId || "global") === entry.scopeId ? savedEntry : item))
    : [...leaderboard, savedEntry];
  await writeLeaderboard(next.slice(0, 100));
  return savedEntry;
}

async function readFileLeaderboard() {
  try {
    const raw = await readFile(leaderboardPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeLeaderboard(leaderboard) {
  await mkdir(dirname(leaderboardPath), { recursive: true });
  await writeFile(leaderboardPath, `${JSON.stringify(leaderboard, null, 2)}\n`);
}

async function ensureLeaderboardTable() {
  if (!pool) return;
  await pool.query(`
    create table if not exists server_leaderboard_scores (
      scope_id text not null,
      user_id text not null,
      username text not null,
      avatar text,
      score integer not null default 0,
      last_score integer not null default 0,
      guild_id text,
      channel_id text,
      instance_id text,
      updated_at timestamptz not null default now(),
      primary key (scope_id, user_id)
    )
  `);
}

async function ensureGuildSettingsTable() {
  if (!pool) return;
  await pool.query(`
    create table if not exists guild_settings (
      guild_id text primary key,
      announcement_channel_id text,
      updated_at timestamptz not null default now()
    )
  `);
}

async function readSqlLeaderboard(scopeId) {
  await ensureLeaderboardTable();
  const result = await pool.query(
    `
    select
      scope_id as "scopeId",
      user_id as "userId",
      username,
      avatar,
      score,
      last_score as "lastScore",
      guild_id as "guildId",
      channel_id as "channelId",
      instance_id as "instanceId",
      updated_at as "updatedAt"
    from server_leaderboard_scores
    where scope_id = $1
    order by score desc, username asc
    limit 10
  `,
    [scopeId]
  );
  return result.rows.map(formatSqlEntry);
}

async function saveSqlScore(entry) {
  await ensureLeaderboardTable();
  const result = await pool.query(
    `
      insert into server_leaderboard_scores (
        scope_id,
        user_id,
        username,
        avatar,
        score,
        last_score,
        guild_id,
        channel_id,
        instance_id,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $5, $6, $7, $8, now())
      on conflict (scope_id, user_id) do update set
        username = excluded.username,
        avatar = excluded.avatar,
        score = greatest(server_leaderboard_scores.score, excluded.score),
        last_score = excluded.last_score,
        guild_id = excluded.guild_id,
        channel_id = excluded.channel_id,
        instance_id = excluded.instance_id,
        updated_at = now()
      returning
        scope_id as "scopeId",
        user_id as "userId",
        username,
        avatar,
        score,
        last_score as "lastScore",
        guild_id as "guildId",
        channel_id as "channelId",
        instance_id as "instanceId",
        updated_at as "updatedAt"
    `,
    [
      entry.scopeId,
      entry.userId,
      entry.username,
      entry.avatar,
      entry.score,
      entry.context.guildId,
      entry.context.channelId,
      entry.context.instanceId
    ]
  );
  return formatSqlEntry(result.rows[0]);
}

function formatSqlEntry(row) {
  return {
    scopeId: row.scopeId,
    userId: row.userId,
    username: row.username,
    avatar: row.avatar,
    score: Number(row.score),
    lastScore: Number(row.lastScore),
    updatedAt: row.updatedAt,
    context: {
      guildId: row.guildId,
      channelId: row.channelId,
      instanceId: row.instanceId
    }
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function cleanName(name) {
  return String(name).replace(/\s+/g, " ").trim().slice(0, 40) || "Discord Player";
}

function cleanDiscordError(payload) {
  const error = typeof payload?.error === "string" ? payload.error : "unknown_error";
  const description =
    typeof payload?.error_description === "string"
      ? payload.error_description.replace(/\s+/g, " ").trim()
      : "";
  return description ? `${error}: ${description}`.slice(0, 180) : error.slice(0, 180);
}

function sanitizeContext(context) {
  return {
    guildId: typeof context.guildId === "string" ? context.guildId.slice(0, 32) : null,
    channelId: typeof context.channelId === "string" ? context.channelId.slice(0, 32) : null,
    instanceId: typeof context.instanceId === "string" ? context.instanceId.slice(0, 120) : null
  };
}

function getLeaderboardScope(guildId) {
  return {
    scopeId: typeof guildId === "string" && guildId ? `guild:${guildId.slice(0, 32)}` : "global"
  };
}

async function startDiscordBot() {
  if (!botToken) {
    console.log("Discord bot disabled: DISCORD_BOT_TOKEN is not set");
    return;
  }

  try {
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
    discordClient.once(Events.ClientReady, async (client) => {
      console.log(`Discord bot ready as ${client.user.tag}`);
      await Promise.allSettled([...client.guilds.cache.keys()].map((guildId) => registerBotCommands(guildId)));
    });
    discordClient.on(Events.GuildCreate, (guild) => registerBotCommands(guild.id));
    discordClient.on(Events.InteractionCreate, handleInteraction);
    await discordClient.login(botToken);
  } catch (error) {
    console.error("Discord bot failed to start", error);
  }
}

async function registerBotCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(botToken);
  const commands = [
    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("Show this server's Sakura Invaders leaderboard.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("setscorechannel")
      .setDescription("Set where Sakura Invaders score announcements are posted.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The channel for score announcements.")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Change the Sakura Invaders bot status.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName("type")
          .setDescription("The status type.")
          .addChoices(
            { name: "Playing", value: "playing" },
            { name: "Watching", value: "watching" },
            { name: "Listening", value: "listening" },
            { name: "Competing", value: "competing" }
          )
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("The status text.")
          .setMaxLength(128)
          .setRequired(true)
      )
      .toJSON()
  ];

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "leaderboard") {
    await handleLeaderboardCommand(interaction);
    return;
  }

  if (interaction.commandName === "setscorechannel") {
    await handleSetScoreChannelCommand(interaction);
    return;
  }

  if (interaction.commandName === "status") {
    await handleStatusCommand(interaction);
  }
}

async function handleLeaderboardCommand(interaction) {
  const scopeId = getLeaderboardScope(interaction.guildId).scopeId;
  const leaderboard = await readLeaderboard(scopeId);

  if (!leaderboard.length) {
    await interaction.reply("No Sakura Invaders scores yet for this server.");
    return;
  }

  await interaction.reply({
    content: formatLeaderboardMessage(leaderboard, interaction.guildId),
    allowedMentions: { users: [] }
  });
}

async function handleSetScoreChannelCommand(interaction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  await saveGuildSettings(interaction.guildId, { announcementChannelId: channel.id });
  await interaction.reply({
    content: `Score announcements will now go to <#${channel.id}>.`,
    ephemeral: true
  });
}

async function handleStatusCommand(interaction) {
  const type = interaction.options.getString("type", true);
  const text = interaction.options.getString("text", true).slice(0, 128);
  const activityType = getActivityType(type);

  discordClient.user.setPresence({
    activities: [{ name: text, type: activityType }],
    status: "online"
  });

  await interaction.reply({
    content: `Bot status updated to ${type} ${text}.`,
    ephemeral: true
  });
}

async function announceScore(entry) {
  if (!discordClient) return;

  try {
    const settings = entry.context.guildId ? await readGuildSettings(entry.context.guildId) : {};
    const channelId = settings.announcementChannelId || entry.context.channelId;
    if (!channelId) return;
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    await channel.send({
      content: `<@${entry.userId}> finished Sakura Invaders with **${entry.lastScore.toLocaleString()}** points. Best on this server: **${entry.score.toLocaleString()}**.`,
      allowedMentions: { users: [entry.userId] }
    });
  } catch (error) {
    console.warn("Could not announce score", error.message);
  }
}

function formatLeaderboardMessage(leaderboard, guildId) {
  const title = guildId ? "Sakura Invaders leaderboard for this server" : "Sakura Invaders leaderboard";
  const lines = leaderboard
    .slice(0, 10)
    .map((entry, index) => `${index + 1}. <@${entry.userId}> - **${entry.score.toLocaleString()}**`)
    .join("\n");
  return `**${title}**\n${lines}`;
}

async function readGuildSettings(guildId) {
  if (!guildId) return {};
  if (pool) {
    await ensureGuildSettingsTable();
    const result = await pool.query(
      `
        select announcement_channel_id as "announcementChannelId"
        from guild_settings
        where guild_id = $1
      `,
      [guildId]
    );
    return result.rows[0] || {};
  }

  const settings = await readFileSettings();
  return settings[guildId] || {};
}

async function saveGuildSettings(guildId, patch) {
  if (!guildId) return;
  if (pool) {
    await ensureGuildSettingsTable();
    await pool.query(
      `
        insert into guild_settings (guild_id, announcement_channel_id, updated_at)
        values ($1, $2, now())
        on conflict (guild_id) do update set
          announcement_channel_id = excluded.announcement_channel_id,
          updated_at = now()
      `,
      [guildId, patch.announcementChannelId]
    );
    return;
  }

  const settings = await readFileSettings();
  settings[guildId] = { ...settings[guildId], ...patch };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

async function readFileSettings() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf-8"));
  } catch {
    return {};
  }
}

function getActivityType(type) {
  return {
    playing: ActivityType.Playing,
    watching: ActivityType.Watching,
    listening: ActivityType.Listening,
    competing: ActivityType.Competing
  }[type] ?? ActivityType.Playing;
}
