import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";
import cors from "cors";
import crypto from "crypto";

const app = express();
const PORT = 3000;

// Cached earthquake data
let cachedQuakes = null;
let lastFetch = 0;
let sseClients = [];
const CACHE_TTL = 60000; // 1 minute

app.use(cors());

// Ignore SSL certificate issues
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/************************************************************************
 * fetch Earthquake Data (PHIVOLCS)
 ************************************************************************/
async function fetchEarthquakeData(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log("[Proxy] Fetching data from PHIVOLCS website...");
      const { data } = await axios.get("https://earthquake.phivolcs.dost.gov.ph/", {
        httpsAgent,
        timeout: 8000,
      });

      const $ = cheerio.load(data);
      const rows = [];
      $("table tbody tr").each((_, el) => {
        const linkEl = $(el).find("td a").first();
        const href = linkEl.attr("href") ? linkEl.attr("href").replace(/\\/g, "/") : null;
        const link = href ? `https://earthquake.phivolcs.dost.gov.ph/${href}` : null;
        const cols = $(el).find("td").map((_, td) => $(td).text().trim()).get();

        if (cols.length >= 6) {
          rows.push({
            id: `${cols[0].replace(/\s+/g, "_")}_${cols[1]}_${cols[2]}_${cols[4]}`,
            time: cols[0],
            lat: parseFloat(cols[1]),
            lon: parseFloat(cols[2]),
            depth: parseFloat(cols[3]),
            magnitude: parseFloat(cols[4]),
            location: cols[5],
            link,
          });
        }
      });

      if (rows.length === 0) throw new Error("No data parsed");
      return rows;
    } catch (err) {
      console.warn(`[Proxy] Attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/************************************************************************
 * Broadcast new earthquakes to SSE clients
 ************************************************************************/
function broadcastNewEarthquakes(newRows) {
  if (!cachedQuakes) {
    cachedQuakes = newRows;
    return;
  }

  const oldIds = new Set(cachedQuakes.map(q => q.id));
  const newEvents = newRows.filter(q => !oldIds.has(q.id));

  if (newEvents.length > 0) {
    console.log(`[SSE] Broadcasting ${newEvents.length} new earthquake(s)`);
    for (const client of sseClients) {
      for (const ev of newEvents) {
        client.write(`data: ${JSON.stringify(ev)}\n\n`);
        client.flush?.();
      }
    }
    cachedQuakes = [...newRows];
  }
}

/************************************************************************
 * Parse PHIVOLCS Date
 ************************************************************************/
function parsePhivolcsDate(text) {
  const monthNames = {
    Jan: 0, January: 0, Feb: 1, February: 1, Mar: 2, March: 2,
    Apr: 3, April: 3, May: 4, Jun: 5, June: 5, Jul: 6, July: 6,
    Aug: 7, August: 7, Sep: 8, September: 8, Oct: 9, October: 9,
    Nov: 10, November: 10, Dec: 11, December: 11
  };

  const m = text.match(/(\d{1,2}) (\w+) (\d{4}) - (\d{1,2}):(\d{2})(?: (\w{2}))?/);
  if (!m) return null;
  const [_, day, monthName, year, hourStr, minStr, ampm] = m;
  const month = monthNames[monthName];
  if (month === undefined) return null;

  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);
  if (ampm) {
    if (ampm.toUpperCase() === "PM" && hour < 12) hour += 12;
    if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
  }
  return new Date(year, month, day, hour, minute);
}

/************************************************************************
 * /api/earthquakes
 ************************************************************************/
app.get("/api/earthquakes", async (req, res) => {
  const now = Date.now();
  try {
    let rows;
    if (cachedQuakes && now - lastFetch < CACHE_TTL && !req.query.forceRefresh) {
      console.log("[Proxy] Using cached earthquakes");
      rows = cachedQuakes;
    } else {
      try {
        rows = await fetchEarthquakeData();
        cachedQuakes = rows;
        lastFetch = now;
      } catch (err) {
        console.warn("[Proxy] Fetch failed, using cached data if available");
        if (cachedQuakes) rows = cachedQuakes;
        else throw err;
      }
    }

    const { start, end } = req.query;
    let filteredRows = rows;
    if (start || end) {
      const startDate = start ? new Date(start) : null;
      const endDate = end ? new Date(end) : null;
      filteredRows = rows.filter(row => {
        const t = parsePhivolcsDate(row.time);
        if (!t) return false;
        if (startDate && t < startDate) return false;
        if (endDate && t > endDate) return false;
        return true;
      });
    }

    res.json(filteredRows);
  } catch (e) {
    console.error("Scrape error:", e.message);
    res.status(500).json({ error: "Failed to fetch PHIVOLCS data" });
  }
});

/************************************************************************
 * /api/usgs-earthquakes
 ************************************************************************/
app.get("/api/usgs-earthquakes", async (req, res) => {
  const {
    start,
    end,
    minlatitude = 4,
    maxlatitude = 22,
    minlongitude = 116,
    maxlongitude = 127,
    minmagnitude = 1.0
  } = req.query;

  let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson`;
  if (start) url += `&starttime=${encodeURIComponent(start)}`;
  if (end) url += `&endtime=${encodeURIComponent(end)}`;
  url += `&minlatitude=${minlatitude}&maxlatitude=${maxlatitude}`;
  url += `&minlongitude=${minlongitude}&maxlongitude=${maxlongitude}`;
  url += `&minmagnitude=${minmagnitude}`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    res.json(data);
  } catch (err) {
    console.error("USGS API error:", err.message);
    res.status(500).json({ error: "Failed to fetch USGS earthquake data" });
  }
});

/************************************************************************
 * /api/faultlines
 ************************************************************************/
app.get("/api/faultlines", async (req, res) => {
  try {
    console.log("[Proxy] Fetching fault lines from GeoRisk...");
    const url =
      "https://hazardhunter.georisk.gov.ph/geoserver/hazardhunter/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=hazardhunter:active_faults&outputFormat=application/json";

    const { data } = await axios.get(url, { httpsAgent, timeout: 15000 });
    res.json(data);
  } catch (err) {
    console.error("Fault line fetch failed:", err.message);
    res.status(500).json({ error: "Could not fetch fault lines" });
  }
});

/************************************************************************
 * /api/earthquakes/stream (SSE)
 ************************************************************************/
app.get("/api/earthquakes/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.push(res);
  console.log(`[SSE] Client connected (${sseClients.length} total)`);

  const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter(c => c !== res);
    console.log(`[SSE] Client disconnected (${sseClients.length} remaining)`);
  });
});

/************************************************************************
 * Background Auto-Fetch
 ************************************************************************/
let lastLatestId = null;

async function checkForNewEarthquake() {
  try {
    console.log("[AutoFetch] Checking PHIVOLCS for updates...");
    const newRows = await fetchEarthquakeData();
    if (!newRows || newRows.length === 0) return;

    const newLatestId = newRows[0].id;

    // Compare with the last known quake ID
    if (lastLatestId && newLatestId !== lastLatestId) {
      console.log(`[AutoFetch] 🆕 New earthquake detected: ${newRows[0].location} (${newRows[0].magnitude} M)`);
      broadcastNewEarthquakes(newRows);
      cachedQuakes = newRows;
      lastFetch = Date.now();
      lastLatestId = newLatestId;
    } else {
      console.log("[AutoFetch] No new earthquakes yet.");
    }
  } catch (err) {
    console.warn("[AutoFetch] Detector failed:", err.message);
  }
}

// Initial load
(async () => {
  try {
    console.log("[Startup] Initial PHIVOLCS fetch...");
    cachedQuakes = await fetchEarthquakeData();
    lastFetch = Date.now();
    if (cachedQuakes.length > 0) lastLatestId = cachedQuakes[0].id;
    console.log(`[Startup] Loaded ${cachedQuakes.length} earthquake entries.`);
  } catch (err) {
    console.warn("[Startup] Failed to load initial data:", err.message);
  }
})();

// Check every 20s
setInterval(checkForNewEarthquake, 20000);

/************************************************************************
 * Start Server
 ************************************************************************/
export default app;
