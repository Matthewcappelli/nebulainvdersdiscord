import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const clientId = process.env.DISCORD_CLIENT_ID || "1509412850450567248";
const leaderboardPath = join(root, "data", "leaderboard.json");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

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

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { discordClientId: clientId });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/leaderboard") {
    const leaderboard = await readLeaderboard();
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
    sendJson(response, 401, { error: "Discord authorization failed" });
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

  const leaderboard = await readLeaderboard();
  const existing = leaderboard.find((entry) => entry.userId === user.id);
  const entry = {
    userId: user.id,
    username: cleanName(user.global_name || user.username || "Discord Player"),
    avatar: user.avatar || null,
    score: existing ? Math.max(existing.score, score) : score,
    lastScore: score,
    updatedAt: new Date().toISOString(),
    context
  };

  const next = existing
    ? leaderboard.map((item) => (item.userId === user.id ? entry : item))
    : [...leaderboard, entry];
  next.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));

  await writeLeaderboard(next.slice(0, 100));
  sendJson(response, 200, { leaderboard: next.slice(0, 10), entry });
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

async function readLeaderboard() {
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

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function cleanName(name) {
  return String(name).replace(/\s+/g, " ").trim().slice(0, 40) || "Discord Player";
}

function sanitizeContext(context) {
  return {
    guildId: typeof context.guildId === "string" ? context.guildId.slice(0, 32) : null,
    channelId: typeof context.channelId === "string" ? context.channelId.slice(0, 32) : null,
    instanceId: typeof context.instanceId === "string" ? context.instanceId.slice(0, 120) : null
  };
}
