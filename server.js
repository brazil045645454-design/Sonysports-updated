const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 7860);

// Change this ONE environment variable when the upstream stream changes.
const STREAM_URL = (
  process.env.STREAM_URL ||
  "https://sonymtmnew-akamaized.pages.dev/hls/live/2120299/ag_strea2909/ENG/master.m3u8"
).trim();

const CHANNEL_ID = "sonysports";
const CHANNEL_NAME = "Sony Sports";
const STREAM_TITLE = "ENG | Day 12 - 30 Sep 2026";

// These are the headers observed in the CloudStream logcat for this stream.
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

// Security: the addon only proxies the configured upstream host.
// This prevents the HLS proxy from becoming an arbitrary open proxy.
function assertAllowedUpstream(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== upstream.hostname) {
    throw new Error("Upstream host is not allowed");
  }
  return u;
}

function proxyUrlFor(upstreamUrl, req) {
  return `${req.protocol}://${req.get("host")}/hls-proxy?url=${encodeURIComponent(upstreamUrl)}`;
}

function rewritePlaylist(text, responseUrl, req) {
  // Rewrite URI="..." attributes used by EXT-X-KEY, EXT-X-MAP,
  // EXT-X-MEDIA, EXT-X-I-FRAMES-ONLY and other HLS tags.
  text = text.replace(/URI="([^"]+)"/g, (_, uri) => {
    try {
      const absolute = new URL(uri, responseUrl).toString();
      assertAllowedUpstream(absolute);
      return `URI="${proxyUrlFor(absolute, req)}"`;
    } catch {
      return `URI="${uri}"`;
    }
  });

  // Rewrite ordinary playlist URI lines (variant playlists / segments).
  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;

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

  console.log(`[HLS] ${response.status} ${u.href}`);

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

// CORS
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.redirect("/manifest.json"));

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

app.get(
  ["/catalog/tv/:id.json", "/catalog/tv/:id/:extra.json"],
  (req, res) => {
    res.json({
      metas:
        req.params.id === "sonysports-catalog" ? [meta] : []
    });
  }
);

app.get("/meta/tv/:id.json", (req, res) => {
  res.json(req.params.id === CHANNEL_ID ? { meta } : { meta: null });
});

app.get("/stream/tv/:id.json", (req, res) => {
  res.set("Cache-Control", "no-store");

  if (req.params.id !== CHANNEL_ID) {
    return res.json({ streams: [] });
  }

  // Stremio receives our proxy URL rather than the upstream URL.
  // This ensures the server adds Referer/Origin/User-Agent to every
  // playlist, segment and key request.
  const proxyStreamUrl = proxyUrlFor(STREAM_URL, req);

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

// Server-side HLS proxy.
// Example:
// /hls-proxy?url=https%3A%2F%2Fsonymtmnew-...%2Fmaster.m3u8
app.get("/hls-proxy", async (req, res) => {
  try {
    if (typeof req.query.url !== "string") {
      return res.status(400).send("Missing url");
    }

    const target = assertAllowedUpstream(req.query.url);
    const upstreamResponse = await fetchUpstream(target.toString());

    if (!upstreamResponse.ok) {
      const body = await upstreamResponse.text().catch(() => "");
      console.error(
        `[HLS] upstream error ${upstreamResponse.status}: ${body.slice(0, 500)}`
      );
      return res
        .status(upstreamResponse.status)
        .send(`Upstream returned HTTP ${upstreamResponse.status}`);
    }

    const contentType =
      upstreamResponse.headers.get("content-type") || "";

    // Read as text if this is a playlist. Checking the URL too makes
    // this work even when the CDN sends an unusual content-type.
    const looksLikePlaylist =
      contentType.includes("mpegurl") ||
      target.pathname.toLowerCase().endsWith(".m3u8");

    if (looksLikePlaylist) {
      const text = await upstreamResponse.text();
      const rewritten = rewritePlaylist(
        text,
        target.toString(),
        req
      );

      res.status(200);
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-store");
      return res.send(rewritten);
    }

    // TS, m4s, AAC, keys, etc.
    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());

    if (contentType) res.set("Content-Type", contentType);
    res.set("Cache-Control", "no-store");
    res.set("Accept-Ranges", "bytes");
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("[HLS] proxy error:", err);
    return res.status(502).send(`HLS proxy error: ${err.message}`);
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    addon: CHANNEL_NAME,
    streamConfigured: Boolean(STREAM_URL)
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sony Sports Stremio addon listening on port ${PORT}`);
  console.log(`Upstream: ${STREAM_URL}`);
});
