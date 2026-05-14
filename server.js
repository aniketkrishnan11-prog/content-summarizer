// =============================================================================
// server.js — AI-Powered Content Synthesizer Backend
// =============================================================================
// Flow:
//   POST /api/summarize
//     → validate input
//     → detect URL vs raw text
//     → (if URL) scrape with cheerio
//     → send text to Groq (OpenAI-compatible endpoint, ultra-fast free tier)
//     → parse & return structured JSON to client
//
// AI Provider: Groq  https://console.groq.com
//   • Free tier: 14,400 req/day, 6,000 req/hour — no credit card required
//   • Default model: llama-3.3-70b-versatile (strong reasoning, fast)
//   • Endpoint: https://api.groq.com/openai/v1  (OpenAI-compatible)
// =============================================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Allow cross-origin requests so the frontend (if served separately) can call us
app.use(cors());

// Parse incoming JSON request bodies
app.use(express.json({ limit: "2mb" }));

// Serve the frontend's index.html from the project root
app.use(express.static("."));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determines whether a given string looks like a valid HTTP/HTTPS URL.
 * @param {string} str - The user-supplied input.
 * @returns {boolean}
 */
function isValidUrl(str) {
  try {
    const url = new URL(str.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fetches a web page and extracts meaningful text from <h1>, <h2>, and <p>
 * tags using cheerio. Strips scripts, styles, nav, footer, and aside elements
 * so the LLM only sees content — not chrome.
 *
 * @param {string} url - The URL to scrape.
 * @returns {Promise<string>} - The cleaned, concatenated text.
 * @throws {Error} - If the page cannot be fetched or yields no usable text.
 */
async function scrapeUrl(url) {
  // Impersonate a real browser so sites don't block us outright
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; ContentSynthesizer/1.0; +https://github.com/your-repo)",
      Accept: "text/html,application/xhtml+xml",
    },
    // 10-second timeout to avoid hanging forever
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch URL (HTTP ${response.status}): ${response.statusText}`
    );
  }

  const html = await response.text();

  // Load HTML into cheerio — our server-side jQuery equivalent
  const $ = cheerio.load(html);

  // Remove elements that pollute the content signal
  $(
    "script, style, noscript, nav, footer, aside, header, [role='navigation'], [role='banner'], [role='complementary']"
  ).remove();

  // Collect text from the semantic content tags we care about
  const contentTags = ["h1", "h2", "h3", "p"];
  const chunks = [];

  contentTags.forEach((tag) => {
    $(tag).each((_, el) => {
      // .text() strips HTML; trim() removes whitespace artefacts
      const text = $(el).text().trim();
      if (text.length > 20) {
        // Ignore tiny fragments like "Read more"
        chunks.push(text);
      }
    });
  });

  if (chunks.length === 0) {
    throw new Error(
      "Could not extract any readable content from the page. " +
        "The site may require JavaScript or block automated access."
    );
  }

  // Join with double newlines so the LLM can follow paragraph boundaries
  return chunks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Retry helper — exponential backoff for transient API errors
// ---------------------------------------------------------------------------

/**
 * Pauses execution for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls an async function up to `maxAttempts` times.
 * Retries only on HTTP 429 (rate-limited) and 503 (service unavailable).
 * Uses full jitter exponential backoff to avoid thundering-herd retries:
 *   delay = random(0, baseDelay * 2^attempt)   capped at maxDelay ms
 *
 * @param {() => Promise<Response>} fetchFn  - A function that returns a fetch Promise.
 * @param {object} opts
 * @param {number} opts.maxAttempts  - Total attempts including the first one. Default 4.
 * @param {number} opts.baseDelay    - Base delay in ms before first retry. Default 1000.
 * @param {number} opts.maxDelay     - Maximum delay cap in ms. Default 16000.
 * @returns {Promise<Response>}
 * @throws {Error} after all attempts are exhausted.
 */
async function fetchWithRetry(fetchFn, { maxAttempts = 4, baseDelay = 1_000, maxDelay = 16_000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response;

    try {
      response = await fetchFn();
    } catch (networkErr) {
      // Network-level failure (timeout, DNS, etc.) — always retry these
      lastError = networkErr;
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
        const jitter = Math.random() * delay; // full jitter
        console.warn(`  [Retry ${attempt + 1}/${maxAttempts - 1}] Network error: ${networkErr.message}. Waiting ${Math.round(jitter)}ms…`);
        await sleep(jitter);
        continue;
      }
      throw networkErr;
    }

    // Success — hand the response back to the caller
    if (response.ok) return response;

    // Rate limited (429) or gateway overloaded (503) — worth retrying
    if ((response.status === 429 || response.status === 503) && attempt < maxAttempts - 1) {
      // Honour the Retry-After header if Gemini provides one (value is seconds)
      const retryAfterHeader = response.headers.get("retry-after");
      let delay;

      if (retryAfterHeader && !isNaN(Number(retryAfterHeader))) {
        // API told us exactly how long to wait — respect it (cap at maxDelay)
        delay = Math.min(Number(retryAfterHeader) * 1_000, maxDelay);
      } else {
        // Exponential backoff with full jitter
        const cap = Math.min(baseDelay * 2 ** attempt, maxDelay);
        delay = Math.random() * cap;
      }

      console.warn(
        `  [Retry ${attempt + 1}/${maxAttempts - 1}] HTTP ${response.status} — waiting ${Math.round(delay)}ms before retry…`
      );
      await sleep(delay);
      lastError = new Error(`HTTP ${response.status}`);
      continue;
    }

    // Any other non-OK status (400, 401, 403, 500…) — do NOT retry, return immediately
    return response;
  }

  // All retries exhausted
  throw lastError ?? new Error("All retry attempts failed.");
}

// ---------------------------------------------------------------------------
// AI summarization
// ---------------------------------------------------------------------------

/**
 * Translates a raw HTTP error response from the Groq API into a clean,
 * human-readable message. Avoids dumping the raw JSON blob at the user.
 *
 * @param {number} status       - HTTP status code.
 * @param {string} rawBody      - Raw response body text.
 * @returns {string}
 */
function humanizeApiError(status, rawBody) {
  // Groq error shape: { "error": { "message": "...", "type": "...", "code": "..." } }
  let apiMessage = "";
  try {
    const parsed = JSON.parse(rawBody);
    apiMessage = parsed?.error?.message || "";
    // Keep only the first line and cap at 200 chars — Groq messages are usually short
    apiMessage = apiMessage.split("\n")[0].slice(0, 200);
  } catch {
    apiMessage = rawBody.slice(0, 150);
  }

  switch (status) {
    case 400:
      return `Bad request sent to the AI (400). ${apiMessage || "Check your input and try again."}`;
    case 401:
      return (
        "Invalid Groq API key (401). " +
        "Double-check the GROQ_API_KEY value in your .env file. " +
        "Get a key at https://console.groq.com/keys."
      );
    case 403:
      return "Access denied by the Groq API (403). Your API key may be inactive or your account suspended.";
    case 413:
      return "Input is too large for the Groq API (413). Try pasting a shorter text or a more focused URL.";
    case 429:
      return (
        "Groq API rate limit reached (429). " +
        "The free tier allows 6,000 requests/hour and 14,400/day. " +
        "Wait a minute and try again — or check your usage at https://console.groq.com/settings/limits."
      );
    case 500:
    case 503:
      return `Groq API is temporarily unavailable (${status}). Please try again in a few moments.`;
    default:
      return `Groq API error (HTTP ${status}): ${apiMessage || "An unexpected error occurred."}`;
  }
}

/**
 * Sends text to the Groq API (OpenAI-compatible endpoint) and returns a
 * parsed JSON object matching our required schema.
 *
 * Automatically retries on 429 / 503 with exponential backoff.
 *
 * Expected schema:
 * {
 *   title: string,
 *   summary: string,
 *   key_takeaways: string[]
 * }
 *
 * @param {string} text - The content to summarize (raw or scraped).
 * @returns {Promise<object>} - The parsed summary object.
 * @throws {Error} - If the API call fails or returns malformed JSON.
 */
async function summarizeWithAI(text) {
  const API_KEY = process.env.GROQ_API_KEY;
  if (!API_KEY) {
    throw new Error(
      "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys " +
      "and add it to your .env file."
    );
  }

  // Groq's OpenAI-compatible base URL — no path changes needed vs OpenAI SDK
  const BASE_URL = process.env.AI_BASE_URL || "https://api.groq.com/openai/v1";

  // llama-3.3-70b-versatile: best balance of quality and speed on Groq free tier.
  // Other good options: llama-3.1-8b-instant (faster, lower quality)
  //                     mixtral-8x7b-32768 (longer context window)
  const MODEL = process.env.AI_MODEL || "llama-3.3-70b-versatile";

  // Truncate very long texts to stay well within the model's context window
  // and avoid hitting Groq's tokens-per-minute limit on the free tier.
  // ~12 000 chars ≈ ~3 000 tokens.
  const MAX_CHARS = 12_000;
  const truncatedText =
    text.length > MAX_CHARS
      ? text.slice(0, MAX_CHARS) + "\n\n[Content truncated for processing length]"
      : text;

  // ── System prompt ──────────────────────────────────────────────────────────
  // Llama 3 models follow instructions very well; keep the JSON schema explicit.
  const systemPrompt = `You are an expert content analyst and summarization engine.
Your ONLY job is to read the provided content and return a single, strictly valid JSON object.

RULES — follow every one without exception:
1. Return ONLY the raw JSON object. No markdown, no code fences, no prose, no explanation.
2. Do NOT wrap the JSON in \`\`\`json ... \`\`\` or any other delimiters.
3. Your entire response must be parseable by JSON.parse() with zero pre-processing.
4. The JSON must exactly match this schema:
{
  "title": "<A concise, compelling title for the content (max 12 words)>",
  "summary": "<A high-density 3-sentence summary that captures the core argument, key evidence, and conclusion>",
  "key_takeaways": [
    "<Actionable or insightful point 1>",
    "<Actionable or insightful point 2>",
    "<Actionable or insightful point 3>",
    "<Actionable or insightful point 4 — optional>",
    "<Actionable or insightful point 5 — optional>"
  ]
}
5. key_takeaways must have at least 3 items and no more than 5.
6. All strings must be properly escaped for JSON.`;

  // ── API request (with automatic retry on 429/503) ─────────────────────────
  const requestBody = JSON.stringify({
    model: MODEL,
    // Low temperature = focused, deterministic output — ideal for structured JSON
    temperature: 0.3,
    // Groq supports max_tokens; 1024 is plenty for our compact JSON schema
    max_tokens: 1024,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Please synthesize the following content:\n\n---\n${truncatedText}\n---`,
      },
    ],
  });

  // fetchWithRetry wraps the fetch and handles 429 back-off automatically
  const response = await fetchWithRetry(
    () =>
      fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Groq uses the same Bearer token scheme as OpenAI
          Authorization: `Bearer ${API_KEY}`,
        },
        body: requestBody,
        signal: AbortSignal.timeout(30_000), // 30-second per-attempt timeout
      }),
    { maxAttempts: 4, baseDelay: 1_500, maxDelay: 20_000 }
  );

  // ── Error handling ─────────────────────────────────────────────────────────
  if (!response.ok) {
    const errBody = await response.text();
    // Full error body logged server-side for debugging; clean message goes to client
    console.error(`  [Groq API] HTTP ${response.status}:`, errBody.slice(0, 500));
    throw new Error(humanizeApiError(response.status, errBody));
  }

  const data = await response.json();

  // Navigate the standard OpenAI response shape that Groq mirrors exactly
  const rawContent = data?.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error("AI returned an empty response. Please try again.");
  }

  // ── Defensive JSON parsing ─────────────────────────────────────────────────
  // Even with strict instructions, LLMs occasionally wrap output in code fences.
  // Strip them before parsing as a safety net.
  let cleanContent = rawContent.trim();
  cleanContent = cleanContent
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleanContent);
  } catch (parseErr) {
    console.error("Raw AI response that failed to parse:\n", rawContent);
    throw new Error(
      `AI returned malformed JSON. Parse error: ${parseErr.message}`
    );
  }

  // ── Schema validation ─────────────────────────────────────────────────────
  if (
    typeof parsed.title !== "string" ||
    typeof parsed.summary !== "string" ||
    !Array.isArray(parsed.key_takeaways) ||
    parsed.key_takeaways.length < 1
  ) {
    throw new Error(
      "AI response did not match expected schema. " +
        "Missing one or more of: title, summary, key_takeaways."
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/summarize
 *
 * Body: { "input": "https://example.com" }  OR  { "input": "Raw text here..." }
 *
 * Response (success):
 * {
 *   "success": true,
 *   "sourceType": "url" | "text",
 *   "data": { title, summary, key_takeaways }
 * }
 *
 * Response (error):
 * { "success": false, "error": "Human-readable message" }
 */
app.post("/api/summarize", async (req, res) => {
  const { input } = req.body;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!input || typeof input !== "string" || input.trim().length === 0) {
    return res
      .status(400)
      .json({ success: false, error: "Request body must include a non-empty `input` field." });
  }

  const trimmed = input.trim();

  if (trimmed.length < 30 && !isValidUrl(trimmed)) {
    return res.status(400).json({
      success: false,
      error:
        "Input is too short to summarize. Please paste at least a sentence or two, or provide a URL.",
    });
  }

  // ── Determine source type & get text ──────────────────────────────────────
  let textToSummarize;
  let sourceType;

  if (isValidUrl(trimmed)) {
    // ── URL path ─────────────────────────────────────────────────────────────
    sourceType = "url";
    console.log(`[${new Date().toISOString()}] Scraping URL: ${trimmed}`);

    try {
      textToSummarize = await scrapeUrl(trimmed);
      console.log(
        `  → Scraped ${textToSummarize.length} characters of content.`
      );
    } catch (scrapeErr) {
      console.error("  → Scrape failed:", scrapeErr.message);
      return res.status(422).json({
        success: false,
        error: `Could not scrape the URL: ${scrapeErr.message}`,
      });
    }
  } else {
    // ── Raw text path ─────────────────────────────────────────────────────────
    sourceType = "text";
    textToSummarize = trimmed;
    console.log(
      `[${new Date().toISOString()}] Processing raw text (${textToSummarize.length} chars).`
    );
  }

  // ── AI Summarization ───────────────────────────────────────────────────────
  let summary;
  try {
    summary = await summarizeWithAI(textToSummarize);
    console.log(`  → AI synthesis complete. Title: "${summary.title}"`);
  } catch (aiErr) {
    console.error("  → AI call failed:", aiErr.message);
    return res.status(502).json({
      success: false,
      error: `AI summarization failed: ${aiErr.message}`,
    });
  }

  // ── Success response ───────────────────────────────────────────────────────
  return res.json({
    success: true,
    sourceType,
    data: summary,
  });
});

// ---------------------------------------------------------------------------
// 404 catch-all for unknown API routes
// ---------------------------------------------------------------------------
app.use("/api/*", (req, res) => {
  res.status(404).json({ success: false, error: "API endpoint not found." });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log(" AI-Powered Content Synthesizer");
  console.log("=".repeat(60));
  console.log(` Server running at : http://localhost:${PORT}`);
  console.log(` API endpoint      : POST http://localhost:${PORT}/api/summarize`);
  console.log(
    ` Groq API key      : ${process.env.GROQ_API_KEY ? "✓ loaded" : "✗ MISSING — set GROQ_API_KEY in .env (https://console.groq.com/keys)"}`
  );
  console.log(` AI Model          : ${process.env.AI_MODEL || "llama-3.3-70b-versatile (default)"}`);
  console.log("=".repeat(60));
});