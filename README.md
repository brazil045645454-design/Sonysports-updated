---
title: Sony Sports Stremio Addon
emoji: 📺
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Sony Sports Stremio Addon

This version uses a **server-side HLS proxy**.

The upstream HLS server is requested with the headers observed in the working CloudStream log:

- Referer: `https://www.sonyliv.com/`
- Origin: `https://www.sonyliv.com`
- User-Agent: Firefox 155 on Windows

The addon rewrites the HLS master/variant playlists so that child playlists, segments and HLS key URLs also pass through the proxy.

## Current stream

```text
https://sonymtmnew-akamaized.pages.dev/hls/live/2120299/ag_strea2909/ENG/master.m3u8
```

If the stream URL changes later, set the `STREAM_URL` environment variable. The code also contains this URL as its default, so no variable is required for the current link.

## Hugging Face Spaces

Create a new **Docker** Space and upload:

- `server.js`
- `package.json`
- `Dockerfile`
- `README.md`

The Space uses port `7860`.

After it is running, your addon manifest will be:

```text
https://YOUR-USERNAME-YOUR-SPACE.hf.space/manifest.json
```

Use the exact `.hf.space` hostname shown by Hugging Face for your Space.

### Optional: change the stream without editing code

Space → Settings → Variables and secrets → add:

```text
STREAM_URL=https://your-new-stream/master.m3u8
```

Restart/redeploy the Space.

## Render

Create a Web Service from this project.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Render supplies `PORT` automatically.

The addon manifest will be:

```text
https://YOUR-SERVICE.onrender.com/manifest.json
```

You can also use the included Dockerfile.

## Install in Stremio

In Stremio:

1. Open Addons.
2. Paste your deployed `/manifest.json` URL into the addon search/install field.
3. Install the addon.
4. Open the TV/catalog section and select Sony Sports.

## Test before installing

Open:

```text
https://YOUR-HOST/health
```

You should get JSON with `"ok": true`.

Then open:

```text
https://YOUR-HOST/manifest.json
```

Finally test the stream endpoint:

```text
https://YOUR-HOST/stream/tv/sonysports.json
```

The returned `url` should point to `/hls-proxy?...`, not directly to the Sony CDN.

## Important

Do not make the proxy an arbitrary URL proxy. This implementation only allows requests to the same hostname as the configured `STREAM_URL`.

The addon does not transcode the video. It only fetches the HLS resources with the required request headers and forwards them to Stremio.
