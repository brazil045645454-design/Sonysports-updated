const express = require("express");

const app = express();

// Render is behind a reverse proxy.
app.set("trust proxy", true);

const PORT = Number(process.env.PORT || 7860);

// ============================================================
// STREAM URL
// ============================================================

const STREAM_URL = (
  process.env.STREAM_URL ||
  "https://sonymtmnew-akamaized.pages.dev/hls/live/2120299/ag_strea2909/ENG/master.m3u8"
).trim();

const CHANNEL_ID = "sonysports";
const CHANNEL_NAME = "Sony Sports";
const STREAM_TITLE = "Sony Sports Live";

// ============================================================
// UPSTREAM HEADERS
// ============================================================

const UPSTREAM_HEADERS = {
  "Referer": "https://www.sonyliv.com/",
  "Origin": "https://www.sonyliv.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0"
};

// ============================================================
// UPSTREAM HOST VALIDATION
// ============================================================

let upstream;

try {
  upstream = new URL(STREAM_URL);
} catch {
  throw new Error("STREAM_URL is not a valid URL");
}

// Hosts allowed by the proxy.
//
// The STREAM_URL host is automatically allowed.
// Sony's Akamai CDN is also allowed because the master
// playlist can point from pages.dev to akamaized.net.
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
    throw new Error(
      `Upstream host is not allowed: ${u.hostname}`
    );
  }

  return u;
}

// ============================================================
// CREATE PROXY URL
// ============================================================

function proxyUrlFor(upstreamUrl, req) {
  return `${req.protocol}://${req.get(
    "host"
  )}/hls-proxy?url=${encodeURIComponent(upstreamUrl)}`;
}

// ============================================================
// REWRITE HLS PLAYLIST
// ============================================================

function rewritePlaylist(text, responseUrl, req) {

  // Rewrite URI="..." attributes.
  //
  // Handles things such as:
  // EXT-X-KEY
  // EXT-X-MAP
  // EXT-X-MEDIA
  // etc.

  text = text.replace(
    /URI="([^"]+)"/g,
    (_, uri) => {
      try {
        const absolute = new URL(
          uri,
          responseUrl
        ).toString();

        assertAllowedUpstream(absolute);

        return `URI="${proxyUrlFor(
          absolute,
          req
        )}"`;
      } catch {
        return `URI="${uri}"`;
      }
    }
  );

  // Rewrite normal HLS URLs.
  //
  // This handles:
  // variant .m3u8 files
  // .ts segments
  // .m4s segments
  // audio segments
  // subtitles
  // etc.

  return text
    .split(/\r?\n/)
    .map(line => {

      const trimmed = line.trim();

      if (
        !trimmed ||
        trimmed.startsWith("#")
      ) {
        return line;
      }

      try {
        const absolute = new URL(
          trimmed,
          responseUrl
        ).toString();

        assertAllowedUpstream(absolute);

        return proxyUrlFor(
          absolute,
          req
        );
      } catch {
        return line;
      }
    })
    .join("\n");
}

// ============================================================
// FETCH UPSTREAM
// ============================================================

async function fetchUpstream(url) {

  const u = assertAllowedUpstream(url);

  console.log(
    `[HLS] GET ${u.href}`
  );

  const response = await fetch(
    u,
    {
      method: "GET",
      headers: UPSTREAM_HEADERS,
      redirect: "follow"
    }
  );

  // If Sony redirects to another Akamai hostname,
  // allow the final hostname too.
  try {
    const finalUrl = new URL(
      response.url
    );

    allowedHosts.add(
      finalUrl.hostname
    );
  } catch {}

  console.log(
    `[HLS] ${response.status} ${response.url}`
  );

  return response;
}

// ============================================================
// MANIFEST
// ============================================================

const manifest = {
  id: "community.sonysports.live",
  version: "2.0.0",
  name: CHANNEL_NAME,
  description: "Sony Sports live channel",

  resources: [
    "catalog",
    "meta",
    "stream"
  ],

  types: [
    "tv"
  ],

  idPrefixes: [
    CHANNEL_ID
  ],

  catalogs: [
    {
      type: "tv",
      id: "sonysports-catalog",
      name: CHANNEL_NAME
    }
  ]
};

// ============================================================
// META
// ============================================================

const meta = {
  id: CHANNEL_ID,
  type: "tv",
  name: CHANNEL_NAME,
  description: "Sony Sports live"
};

// ============================================================
// CORS
// ============================================================

app.use(
  (req, res, next) => {

    res.set(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.set(
      "Access-Control-Allow-Headers",
      "*"
    );

    res.set(
      "Access-Control-Allow-Methods",
      "GET,HEAD,OPTIONS"
    );

    if (
      req.method === "OPTIONS"
    ) {
      return res.sendStatus(204);
    }

    next();
  }
);

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.redirect(
      "/manifest.json"
    );
  }
);

// ============================================================
// MANIFEST ENDPOINT
// ============================================================

app.get(
  "/manifest.json",
  (req, res) => {
    res.json(manifest);
  }
);

// ============================================================
// CATALOG
// ============================================================

app.get(
  [
    "/catalog/tv/:id.json",
    "/catalog/tv/:id/:extra.json"
  ],

  (req, res) => {

    res.json({
      metas:
        req.params.id ===
        "sonysports-catalog"
          ? [meta]
          : []
    });

  }
);

// ============================================================
// META
// ============================================================

app.get(
  "/meta/tv/:id.json",

  (req, res) => {

    res.json(
      req.params.id === CHANNEL_ID
        ? { meta }
        : { meta: null }
    );

  }
);

// ============================================================
// STREAM
// ============================================================

app.get(
  "/stream/tv/:id.json",

  (req, res) => {

    res.set(
      "Cache-Control",
      "no-store"
    );

    if (
      req.params.id !==
      CHANNEL_ID
    ) {
      return res.json({
        streams: []
      });
    }

    // IMPORTANT:
    // Stremio receives our proxy URL,
    // NOT the Sony URL directly.

    const proxyStreamUrl =
      proxyUrlFor(
        STREAM_URL,
        req
      );

    console.log(
      `[STREAM] ${proxyStreamUrl}`
    );

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

  }
);

// ============================================================
// SERVER-SIDE HLS PROXY
// ============================================================

app.get(
  "/hls-proxy",

  async (req, res) => {

    try {

      if (
        typeof req.query.url !==
        "string"
      ) {
        return res
          .status(400)
          .send("Missing url");
      }

      const target =
        assertAllowedUpstream(
          req.query.url
        );

      const upstreamResponse =
        await fetchUpstream(
          target.toString()
        );

      // ======================================================
      // UPSTREAM ERROR
      // ======================================================

      if (
        !upstreamResponse.ok
      ) {

        const body =
          await upstreamResponse
            .text()
            .catch(
              () => ""
            );

        console.error(
          `[HLS] upstream error ` +
          `${upstreamResponse.status}: ` +
          `${body.slice(0, 500)}`
        );

        return res
          .status(
            upstreamResponse.status
          )
          .send(
            `Upstream returned HTTP ` +
            `${upstreamResponse.status}`
          );

      }

      const contentType =
        upstreamResponse
          .headers
          .get(
            "content-type"
          ) || "";

      // ======================================================
      // DETECT PLAYLIST
      // ======================================================

      const looksLikePlaylist =
        contentType
          .toLowerCase()
          .includes(
            "mpegurl"
          ) ||

        target.pathname
          .toLowerCase()
          .endsWith(
            ".m3u8"
          );

      // ======================================================
      // PLAYLIST
      // ======================================================

      if (
        looksLikePlaylist
      ) {

        const text =
          await upstreamResponse
            .text();

        // Use the FINAL URL here.
        //
        // This is important because the Sony pages.dev
        // master redirects/points to the Akamai CDN.
        const rewritten =
          rewritePlaylist(
            text,
            upstreamResponse.url,
            req
          );

        res.status(200);

        res.set(
          "Content-Type",
          "application/vnd.apple.mpegurl"
        );

        res.set(
          "Cache-Control",
          "no-store"
        );

        return res.send(
          rewritten
        );

      }

      // ======================================================
      // VIDEO / AUDIO / SEGMENTS / KEYS
      // ======================================================

      const buffer =
        Buffer.from(
          await upstreamResponse
            .arrayBuffer()
        );

      if (
        contentType
      ) {
        res.set(
          "Content-Type",
          contentType
        );
      }

      res.set(
        "Cache-Control",
        "no-store"
      );

      res.set(
        "Accept-Ranges",
        "bytes"
      );

      return res
        .status(200)
        .send(buffer);

    } catch (err) {

      console.error(
        "[HLS] proxy error:",
        err
      );

      return res
        .status(502)
        .send(
          `HLS proxy error: ${err.message}`
        );

    }

  }
);

// ============================================================
// TEST STREAM
// ============================================================

app.get(
  "/test-stream",

  async (req, res) => {

    try {

      const target =
        assertAllowedUpstream(
          STREAM_URL
        );

      const upstreamResponse =
        await fetchUpstream(
          target.toString()
        );

      const contentType =
        upstreamResponse
          .headers
          .get(
            "content-type"
          ) || "";

      const text =
        await upstreamResponse
          .text();

      res.json({

        upstreamStatus:
          upstreamResponse.status,

        contentType,

        isPlaylist:
          contentType
            .toLowerCase()
            .includes(
              "mpegurl"
            ) ||
          target.pathname
            .toLowerCase()
            .endsWith(
              ".m3u8"
            ),

        preview:
          text.slice(
            0,
            2000
          )

      });

    } catch (err) {

      console.error(
        "[TEST] error:",
        err
      );

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",

  (req, res) => {

    res.json({

      ok: true,

      addon:
        CHANNEL_NAME,

      streamConfigured:
        Boolean(
          STREAM_URL
        )

    });

  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        error:
          "Not found"
      });

  }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      err
    );

    res
      .status(500)
      .json({
        error:
          "Internal error"
      });

  }
);

// ============================================================
// START SERVER
// ============================================================

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

    console.log(
      `Allowed hosts:`,
      [...allowedHosts]
    );

  }
);
