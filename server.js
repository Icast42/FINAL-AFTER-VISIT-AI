import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8099;

// Load DripBar brain instructions from text file
let brainText = fs.readFileSync("./dripbar_brain.txt", "utf8");

// Truncate instructions to stay under GA Realtime 16k token limit
// 16k tokens ≈ ~40k characters (rough heuristic)
const MAX_CHARS = 40000;
let instructions = brainText;
if (instructions.length > MAX_CHARS) {
  console.warn(
    `DripBar brain is too large (${instructions.length} chars). ` +
    `Truncating to first ${MAX_CHARS} characters for session.instructions.`
  );
  instructions = instructions.slice(0, MAX_CHARS);
}

// Serve the static frontend
app.use(express.static("public"));

/**
 * POST /session
 * Uses GA endpoint /v1/realtime/client_secrets to get an ephemeral key
 * for the gpt-realtime model, with speech output (female voice).
 */
app.post("/session", async (req, res) => {
  try {
    const sessionConfig = {
      session: {
        type: "realtime",          // ✅ REQUIRED for GA Realtime
        model: "gpt-realtime",     // GA realtime model
        instructions,              // DripBar brain (truncated if necessary)
        audio: {
          output: {
            voice: "marin"         // friendly female voice
          }
        }
      }
    };

    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(sessionConfig)
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("CLIENT_SECRETS HTTP ERROR:", r.status, txt);
      return res.status(500).json({
        error: "client_secrets http error",
        status: r.status,
        body: txt
      });
    }

    const data = await r.json();
    // GA format: { object: "realtime.client_secret", value: "ek_..." , ... }
    res.json(data);
  } catch (err) {
    console.error("SESSION ERROR:", err);
    res.status(500).json({ error: "session failed" });
  }
});

app.listen(PORT, () => {
  console.log("DripBar AI (GA Realtime) running at http://localhost:" + PORT);
});
