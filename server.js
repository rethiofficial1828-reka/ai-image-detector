require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");
const { RealityDefender, RealityDefenderError } = require("@realitydefender/realitydefender");

const app  = express();
const PORT = process.env.PORT || 3000;
const RD_API_KEY = process.env.RD_API_KEY || "rd_90df395c9ed55062_9df0733d76582c985fe1ab2211da8164";

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Multer: memory, 50 MB max (RD limit for images)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only JPEG, PNG, GIF, WebP allowed"));
  },
});

// ── Reality Defender client ───────────────────────────────────────────────────
const rd = new RealityDefender({ apiKey: RD_API_KEY });

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", rdKey: !!RD_API_KEY, time: new Date().toISOString() });
});

// ── Main detection endpoint ───────────────────────────────────────────────────
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image provided" });

  // Write buffer to a temp file (SDK needs a real file path)
  const ext      = req.file.mimetype.split("/")[1].replace("jpeg","jpg");
  const tmpPath  = path.join(os.tmpdir(), `rd_upload_${Date.now()}.${ext}`);

  try {
    fs.writeFileSync(tmpPath, req.file.buffer);

    console.log(`[RD] Uploading ${req.file.originalname} (${(req.file.size/1024).toFixed(1)} KB)...`);

    // Upload to Reality Defender and poll for result (up to 60s)
    const result = await rd.detect(
      { filePath: tmpPath },
      { maxAttempts: 12, pollingInterval: 5000 }   // 12 × 5s = 60s max
    );

    console.log("[RD] Raw result:", JSON.stringify(result, null, 2));

    // ── Normalise result ──────────────────────────────────────────────────────
    // status: REAL | MANIPULATED | ANALYZING | ERROR
    // score:  0-1 (0 = definitely real, 1 = definitely fake)
    const verdict    = mapVerdict(result.status, result.score);
    const confidence = result.score != null ? Math.round(result.score * 100) : null;

    // Build per-model breakdown
    const models = (result.models || []).map(m => ({
      name      : m.name,
      status    : m.status,
      score     : m.score != null ? Math.round(m.score * 100) : null,
    }));

    res.json({
      success   : true,
      requestId : result.requestId,
      verdict,
      confidence,
      rawStatus : result.status,
      models,
      file_info : {
        name    : req.file.originalname,
        size_kb : (req.file.size / 1024).toFixed(1),
        type    : ext.toUpperCase(),
      },
    });

  } catch (err) {
    console.error("[RD] Error:", err.message);
    const msg = err instanceof RealityDefenderError ? err.message : `Server error: ${err.message}`;
    res.status(502).json({ error: msg });
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function mapVerdict(status, score) {
  if (status === "MANIPULATED" || status === "FAKE") return "AI_GENERATED";
  if (status === "REAL")                              return "REAL";
  if (status === "ANALYZING")                         return "ANALYZING";
  // Fallback: use score threshold
  if (score != null) return score >= 0.5 ? "AI_GENERATED" : "REAL";
  return "UNCERTAIN";
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛡  Reality Defender · AI Image Forensics`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   RD API key: ${RD_API_KEY ? "✅ Ready" : "❌ Missing"}\n`);
});
