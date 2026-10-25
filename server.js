const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "readings.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ readings: [], events: [], alerts: [] }, null, 2)
  );
}

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(PUBLIC_DIR));

function readDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      readings: Array.isArray(d.readings) ? d.readings : [],
      events: Array.isArray(d.events) ? d.events : [],
      alerts: Array.isArray(d.alerts) ? d.alerts : []
    };
  } catch {
    return { readings: [], events: [], alerts: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function id() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function n(v) {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function riskFor(r) {
  let score = 0;
  const reasons = [];
  let available = 0;

  if (r.heartRate !== null) {
    available++;
    if (r.heartRate < 40 || r.heartRate > 130) {
      score += 30;
      reasons.push("Heart rate outside prototype limits");
    } else if (r.heartRate < 50 || r.heartRate > 110) {
      score += 15;
      reasons.push("Heart rate needs review");
    }
  }

  if (r.spo2 !== null) {
    available++;
    if (r.spo2 < 90) {
      score += 35;
      reasons.push("Low SpO2 reading");
    } else if (r.spo2 < 94) {
      score += 15;
      reasons.push("SpO2 below prototype target");
    }
  }

  if (r.temperature !== null) {
    available++;
    if (r.temperature > 38) {
      score += 25;
      reasons.push("High temperature reading");
    } else if (r.temperature > 37.5) {
      score += 10;
      reasons.push("Temperature needs review");
    }
  }

  if (r.motion !== null) {
    available++;
    if (r.motion > 25) {
      score += 20;
      reasons.push("High motion reading");
    }
  }

  if (String(r.ppgQuality).toUpperCase() === "POOR") {
    score += 10;
    reasons.push("Poor PPG signal quality");
  }

  score = Math.min(100, score);

  return {
    riskScore: available ? score : null,
    riskLevel: !available
      ? "INSUFFICIENT_DATA"
      : score >= 50 ? "HIGH"
      : score >= 25 ? "MODERATE" : "LOW",
    riskReasons: reasons,
    availableParameters: available
  };
}

function createEvent(db, r, title, message, type) {
  const event = {
    id: id(),
    timestamp: r.timestamp,
    deviceId: r.deviceId,
    type,
    title,
    message,
    acknowledged: false
  };

  db.events.unshift(event);
  db.alerts.unshift({ ...event });
  db.events = db.events.slice(0, 500);
  db.alerts = db.alerts.slice(0, 200);
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SeizureWatch Pro API",
    time: new Date().toISOString()
  });
});

app.post("/api/readings", (req, res) => {
  const b = req.body || {};

  const r = {
    id: id(),
    deviceId: String(b.deviceId || "SeizureWatch-01"),
    timestamp: new Date().toISOString(),
    heartRate: n(b.heartRate),
    spo2: n(b.spo2),
    temperature: n(b.temperature),
    motion: n(b.motion),
    latitude: n(b.latitude),
    longitude: n(b.longitude),
    ppgQuality: b.ppgQuality ?? "UNKNOWN",
    activity: b.activity ?? "UNKNOWN",
    respiration: n(b.respiration),
    stress: b.stress ?? null,
    sleepEstimate: b.sleepEstimate ?? b.sleep_estimate ?? null,
    battery: n(b.battery)
  };

  Object.assign(r, riskFor(r));

  const db = readDB();
  db.readings.push(r);
  if (db.readings.length > 2000) db.readings = db.readings.slice(-2000);

  if (r.riskScore !== null && r.riskScore >= 50) {
    createEvent(
      db, r, "Risk Score Warning",
      `Prototype score ${r.riskScore}/100. ${r.riskReasons.join("; ")}`,
      "RISK_SCORE_ALERT"
    );
  } else if (r.riskReasons.length) {
    createEvent(
      db, r, "Sensor Threshold Alert",
      r.riskReasons.join("; "),
      "SENSOR_ALERT"
    );
  }

  saveDB(db);
  res.status(201).json({ success: true, message: "Reading received", reading: r });
});

app.get("/api/latest", (req, res) => {
  const db = readDB();
  const latest = db.readings.at(-1) || null;
  const age = latest ? Date.now() - new Date(latest.timestamp).getTime() : Infinity;
  res.json({
    ...(latest || {}),
    latest,
    online: age < 15000,
    deviceOnline: age < 15000,
    serverTime: new Date().toISOString()
  });
});

app.get("/api/history", (req, res) => {
  const db = readDB();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 40, 500));
  res.json({ readings: db.readings.slice(-limit).reverse(), count: db.readings.length });
});

app.get("/api/analytics", (req, res) => {
  const db = readDB();
  const recent = db.readings.slice(-100);

  const avg = key => {
    const values = recent.map(x => n(x[key])).filter(x => x !== null);
    return values.length
      ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
      : null;
  };

  res.json({
    totalReadings: db.readings.length,
    averageHeartRate: avg("heartRate"),
    averageSpO2: avg("spo2"),
    averageTemperature: avg("temperature"),
    averageMotion: avg("motion"),
    averageRiskScore: avg("riskScore"),
    totalEvents: db.events.length,
    activeAlerts: db.alerts.filter(x => !x.acknowledged).length,
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/events", (req, res) => {
  res.json({ events: readDB().events.slice(0, 200) });
});

app.get("/api/alerts", (req, res) => {
  res.json({ alerts: readDB().alerts.slice(0, 200) });
});

app.post("/api/events/:id/acknowledge", (req, res) => {
  const db = readDB();
  const event = db.events.find(x => x.id === req.params.id);

  if (!event) {
    return res.status(404).json({ success: false, message: "Event not found" });
  }

  event.acknowledged = true;
  const alert = db.alerts.find(x => x.id === event.id);
  if (alert) alert.acknowledged = true;

  saveDB(db);
  res.json({ success: true, event });
});

app.get("/api/export/readings.csv", (req, res) => {
  const db = readDB();
  const columns = [
    "timestamp", "deviceId", "heartRate", "spo2", "temperature", "motion",
    "latitude", "longitude", "ppgQuality", "activity", "respiration",
    "stress", "sleepEstimate", "battery", "riskScore", "riskLevel", "riskReasons"
  ];

  const esc = value => {
    const v = Array.isArray(value) ? value.join("; ") : value ?? "";
    return '"' + String(v).replace(/"/g, '""') + '"';
  };

  const csv = [
    columns.join(","),
    ...db.readings.map(r => columns.map(c => esc(r[c])).join(","))
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="seizurewatch-readings.csv"');
  res.send("\uFEFF" + csv.join("\r\n"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "API endpoint not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("SeizureWatch Pro running on port " + PORT);
  console.log("Dashboard: http://localhost:" + PORT);
});