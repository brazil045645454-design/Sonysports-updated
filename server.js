const express = require("express");

const app = express();

// Render terminates HTTPS at its edge proxy.
app.set("trust proxy", true);

const PORT = Number(process.env.PORT || 7860);

const STREAM_URL = (
  process.env.STREAM_URL ||
  "https://sonymtmnew-akamaized.pages.dev/hls/live/2120299/ag_strea2909/ENG/master.m3u8"
).trim();

const CHANNEL_ID = "sonysports";
const CHANNEL_NAME = "Sony Sports";
const STREAM_TITLE = "ENG | Day 12 - 30 Sep 2026";

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

function assertAllowedUpstream(url) {
  const u = new URL(url);

  if (u.protocol !== "https:" || u.hostname !== upstream.hostname) {
    throw new Error("Upstream host is not allowed");
  }

  return u;
}

function proxyUrlFor(upstreamUrl, req) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();

  const protocol =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : req.protocol;

  return `${protocol}://${req.get("host")}/hls-proxy?url=${encodeURIComponent(
    upstreamUrl
  )}`;
}

function rewritePlaylist(text, responseUrl, req) {
  // Rewrite URI="..." attributes such as EXT-X-KEY and EXT-X-MAP.
  text = text.replace(/URI="([^"]+)"/g, (_, uri) => {
    try {
      const absolute = new URL(uri, responseUrl).toString();
      assertAllowedUpstream(absolute);

      return `URI="${proxyUrlFor(absolute, req)}"`;
    } catch {
      return `URI="${uri}"`;
    }
  });

  // Rewrite normal HLS playlist URLs.
  return text
    .split(/\r?\n/)
    .map((line) => {
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

async function fetchUpstream(url, req) {
  const u = assertAllowedUpstream(url);

  const headers = {
    ...UPSTREAM_HEADERS
  };

  // Forward Range requests from Stremio/player.
  const range = req?.get?.("range");

  if (range) {
    headers.Range = range;
  }

  console.log(
    `[HLS] GET ${u.href}${range ? ` (Range: ${range})` : ""}`
  );

  const response = await fetch(u, {
    method: "GET",
    headers,
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

// Stremio stream endpoint.
app.get("/stream/tv/:id.json", (req, res) => {
  res.set("Cache-Control", "no-store");

  if (req.params.id !== CHANNEL_ID) {
    return res.json({
      streams: []
    });
  }

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
app.get("/hls-proxy", async (req, res) => {
  try {
    if (typeof req.query.url !== "string") {
      return res.status(400).send("Missing url");
    }

    const target = assertAllowedUpstream(req.query.url);

    const upstreamResponse = await fetchUpstream(
      target.toString(),
      req
    );

    if (!upstreamResponse.ok) {
      const body = await upstreamResponse
        .text()
        .catch(() => "");

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
      upstreamResponse.headers.get("content-type") || "";

    const looksLikePlaylist =
      contentType.includes("mpegurl") ||
      target.pathname.toLowerCase().endsWith(".m3u8");

    // HLS playlist
    if (looksLikePlaylist) {
      const text = await upstreamResponse.text();

      const rewritten = rewritePlaylist(
        text,
        target.toString(),
        req
      );

      res.status(200);
      res.set(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );
      res.set("Cache-Control", "no-store");

      return res.send(rewritten);
    }

    // Media segments / keys / audio / video.
    if (contentType) {
      res.set("Content-Type", contentType);
    }

    res.set("Cache-Control", "no-store");
    res.set("Accept-Ranges", "bytes");

    const contentLength =
      upstreamResponse.headers.get("content-length");

    const contentRange =
      upstreamResponse.headers.get("content-range");

    if (contentLength) {
      res.set("Content-Length", contentLength);
    }

    if (contentRange) {
      res.set("Content-Range", contentRange);
    }

    res.status(upstreamResponse.status);

    if (!upstreamResponse.body) {
      return res.end();
    }

    // Stream data instead of buffering the entire segment.
    const reader =
      upstreamResponse.body.getReader();

    try {
      while (true) {
        const { value, done } =
          await reader.read();

        if (done) {
          break;
        }

        if (value) {
          res.write(Buffer.from(value));
        }
      }

      return res.end();
    } catch (streamErr) {
      console.error(
        "[HLS] downstream stream error:",
        streamErr
      );

      if (!res.headersSent) {
        return res
          .status(502)
          .send("HLS stream error");
      }

      return res.end();
    }
  } catch (err) {
    console.error(
      "[HLS] proxy error:",
      err
    );

    return res
      .status(502)
      .send(`HLS proxy error: ${err.message}`);
  }
});

// Direct upstream test.
app.get("/test-stream", async (req, res) => {
  try {
    const upstreamResponse =
      await fetchUpstream(
        STREAM_URL,
        req
      );

    const contentType =
      upstreamResponse.headers.get(
        "content-type"
      ) || "";

    const body =
      await upstreamResponse.text();

    res.status(upstreamResponse.status).json({
      upstreamStatus:
        upstreamResponse.status,

      contentType,

      isPlaylist:
        contentType.includes("mpegurl") ||
        STREAM_URL
          .toLowerCase()
          .endsWith(".m3u8"),

      preview:
        body.slice(0, 1000)
    });
  } catch (err) {
    console.error(
      "[TEST] stream error:",
      err
    );

    res.status(502).json({
      error: err.message
    });
  }
});

// Health check.
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    addon: CHANNEL_NAME,
    streamConfigured:
      Boolean(STREAM_URL)
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not found"
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "Internal error"
  });
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Sony Sports Stremio addon listening on port ${PORT}`
    );

    console.log(
      `Upstream: ${STREAM_URL}`
    );
  }
);
