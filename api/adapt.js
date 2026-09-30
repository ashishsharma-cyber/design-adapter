// api/adapt.js — serverless proxy
// Keeps your API key on the server. The browser never sees it.
// Works on Vercel (and Netlify / Cloudflare with tiny changes).

export const config = { api: { bodyParser: { sizeLimit: "25mb" } } };

export default async function handler(req, res) {
  // Allow the browser page to call this function
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

  if (!OPENAI_KEY && !GOOGLE_KEY) {
    return res.status(500).json({
      error:
        "No key configured on the server. Add OPENAI_API_KEY or GOOGLE_API_KEY in your hosting environment variables.",
    });
  }

  try {
    const { prompt, images, size, aspectRatio } = req.body || {};
    if (!prompt || !images || !images.length) {
      return res.status(400).json({ error: "prompt and images are required" });
    }

    // ---------- OpenAI path (preferred: better text rendering) ----------
    if (OPENAI_KEY) {
      const form = new FormData();
      form.append("model", "gpt-image-1");
      form.append("prompt", prompt);
      form.append("size", size || "1536x1024");
      form.append("quality", "high");
      form.append("input_fidelity", "high");
      form.append("n", "1");

      for (let i = 0; i < images.length; i++) {
        const bin = Buffer.from(images[i], "base64");
        form.append(
          "image[]",
          new Blob([bin], { type: "image/png" }),
          `image-${i}.png`
        );
      }

      const r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
        body: form,
      });

      const data = await r.json();
      if (!r.ok) {
        return res
          .status(r.status)
          .json({ error: data?.error?.message || "OpenAI request failed" });
      }
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) return res.status(502).json({ error: "No image returned" });
      return res.status(200).json({ image: b64, provider: "openai" });
    }

    // ---------- Google path (fallback) ----------
    const parts = images.map((d) => ({
      inline_data: { mime_type: "image/png", data: d },
    }));
    parts.push({ text: prompt });

    const body = {
      contents: [{ parts }],
      generationConfig: { imageConfig: { aspectRatio: aspectRatio || "16:9" } },
    };

    let r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!r.ok) {
      delete body.generationConfig;
      r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
    }

    const data = await r.json();
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ error: data?.error?.message || "Google request failed" });
    }

    const out = (data?.candidates?.[0]?.content?.parts || []).find(
      (p) => p.inline_data || p.inlineData
    );
    if (!out) return res.status(502).json({ error: "No image returned" });

    const pd = out.inline_data || out.inlineData;
    return res.status(200).json({ image: pd.data, provider: "google" });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
