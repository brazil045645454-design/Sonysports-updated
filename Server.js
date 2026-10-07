const express = require("express");

const app = express();
app.set("trust proxy", true);
const PORT = Number(process.env.PORT || 7860);

const STREAM_URL = (
  process.env.STREAM_URL ||
  "https://sonymtmnew-akamaized.pages.dev/hls/live/2120299/ag_strea2909/ENG/master.m3u8"
).trim();

const CHANNEL_ID = "sonysports";
const CHANNEL_NAME = "Sony Sports";
const STREAM_TITLE = "Sony Sports Live";

const UPSTREAM_HEADERS = {
  "Referer": "https://www.sonyliv.com/",
  "Origin": "https://www.sonyliv.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0"
};

let upstream;
try {
  upstream = new URL(STREAM_URL);
} catch {
  throw new Error("STREAM_URL is not a valid URL");
}

const allowedHosts = new Set([
  upstream.hostname,
  "sonymtmnew.akamaized.net"
]);

function assertAllowedUpstream(url) {
  const u = new URL(url);

  if (u.protocol !== "https:") {
    throw new Error("Only HTTPS upstream URLs are allowed");
  }

  if (!allowedHosts.has(u.hostname)) {
    throw new Error(`Upstream host is not allowed: ${u.hostname}`);
  }

  return u;
}

function proxyUrlFor(upstreamUrl, req) {
  return `${req.protocol}://${req.get("host")}/hls-proxy?url=${encodeURIComponent(upstreamUrl)}`;
}

function rewritePlaylist(text, responseUrl, req) {
  text = text.replace(/URI="([^"]+)"/g, (_, uri) => {
    try {
      const absolute = new URL(uri, responseUrl).toString();
      assertAllowedUpstream(absolute);
      return `URI="${proxyUrlFor(absolute, req)}"`;
    } catch {
      return `URI="${uri}"`;
    }
  });

  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        return line;
      }

      try {
        const absolute = new URL(trimmed, responseUrl).toString();
        assertAllowedUpstream(absolute);
        return proxyUrlFor(absolute, req);
      } catch {
        return line;
      }
    })
    .join("\n");
}

async function fetchUpstream(url) {
  const u = assertAllowedUpstream(url);

  console.log(`[HLS] GET ${u.href}`);

  const response = await fetch(u, {
    method: "GET",
    headers: UPSTREAM_HEADERS,
    redirect: "follow"
  });

  try {
    const finalUrl = new URL(response.url);
    allowedHosts.add(finalUrl.hostname);
  } catch {}

  console.log(`[HLS] ${response.status} ${response.url}`);

  return response;
}

const manifest = {
  id: "community.sonysports.live",
  version: "2.0.0",
  name: CHANNEL_NAME,
  description: "Sony Sports live channel",
  resources: ["catalog", "meta", "stream"],
  types: ["tv"],
  idPrefixes: [CHANNEL_ID],

  catalogs: [
    {
      type: "tv",
      id: "sonysports-catalog",
      name: CHANNEL_NAME
    }
  ]
};

const meta = {
  id: CHANNEL_ID,
  type: "tv",
  name: CHANNEL_NAME,
  description: "Sony Sports live"
};

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.get("/", (req, res) => {
  res.redirect("/manifest.json");
});

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

app.get(
  ["/catalog/tv/:id.json", "/catalog/tv/:id/:extra.json"],
  (req, res) => {
    res.json({
      metas:
        req.params.id === "sonysports-catalog"
          ? [meta]
          : []
    });
  }
);

app.get("/meta/tv/:id.json", (req, res) => {
  res.json(
    req.params.id === CHANNEL_ID
      ? { meta }
      : { meta: null }
  );
});

app.get("/stream/tv/:id.json", (req, res) => {
  res.set("Cache-Control", "no-store");

  if (req.params.id !== CHANNEL_ID) {
    return res.json({ streams: [] });
  }

  const proxyStreamUrl = proxyUrlFor(STREAM_URL, req);

  console.log(`[STREAM] ${proxyStreamUrl}`);

  res.json({
    streams: [
      {
        name: CHANNEL_NAME,
        title: STREAM_TITLE,
        url: proxyStreamUrl,

        behaviorHints: {
          notWebReady: true
        }
      }
    ]
  });
});

app.get("/hls-proxy", async (req, res) => {
  try {
    if (typeof req.query.url !== "string") {
      return res.status(400).send("Missing url");
    }

    const target = assertAllowedUpstream(req.query.url);

    const upstreamResponse =
      await fetchUpstream(target.toString());

    if (!upstreamResponse.ok) {
      const body =
        await upstreamResponse.text().catch(() => "");

      console.error(
        `[HLS] upstream error ${upstreamResponse.status}: ${body.slice(
          0,
          500
        )}`
      );

      return res
        .status(upstreamResponse.status)
        .send(
          `Upstream returned HTTP ${upstreamResponse.status}`
        );
    }

    const contentType =
      upstreamResponse.headers.get("content-type") ||
