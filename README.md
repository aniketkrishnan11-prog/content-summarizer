# AI-Powered Content Synthesizer

A full-stack web application that accepts a **URL or raw text**, intelligently scrapes and extracts content, then uses **Google Gemini** to return a structured JSON summary — rendered as a beautiful, readable card.

```
Input: URL or raw text
  → Backend detects type
  → (URL) Cheerio scrapes <h1>, <h2>, <p> tags
  → Gemini returns JSON: { title, summary, key_takeaways }
  → Frontend renders the card
```

---

## Tech Stack

| Layer      | Technology                              |
|------------|----------------------------------------|
| Backend    | Node.js + Express                       |
| Scraping   | Cheerio (server-side HTML parsing)      |
| AI         | Google Gemini via OpenAI-compat API     |
| Frontend   | Vanilla HTML/CSS/JS + Tailwind CDN      |
| Config     | dotenv                                  |

---

## Prerequisites

- **Node.js v18+** (required for native `fetch` and `AbortSignal.timeout`)
- A **Google Gemini API key** (free tier available)

---

## Setup & Installation

### 1. Clone or download the project

```bash
git clone https://github.com/your-username/ai-content-synthesizer.git
cd ai-content-synthesizer
```

### 2. Install dependencies

```bash
npm install
```

This installs: `express`, `cors`, `dotenv`, `cheerio`, `node-fetch`.

### 3. Get a Gemini API Key

1. Visit [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Sign in with your Google account
3. Click **"Create API key"**
4. Copy the key — it starts with `AIza...`

The **free tier** is generous enough for development and personal use.

### 4. Configure environment variables

Open the `.env` file in the project root and add your key:

```env
GEMINI_API_KEY=AIzaSyYour_actual_key_here
```

> ⚠️ **Never commit `.env` with a real key to a public repository.** Add `.env` to your `.gitignore`.

### 5. Run the server

```bash
# Production start
npm start

# Development mode (auto-restarts on file changes — Node 18+ built-in)
npm run dev
```

You should see:

```
============================================================
 AI-Powered Content Synthesizer
============================================================
 Server running at : http://localhost:3000
 API endpoint      : POST http://localhost:3000/api/summarize
 Gemini API key    : ✓ loaded
============================================================
```

### 6. Open the app

Navigate to [http://localhost:3000](http://localhost:3000) in your browser.

---

## Usage

### Via the Web UI

1. Paste either a **URL** (e.g. `https://en.wikipedia.org/wiki/Artificial_intelligence`) or **raw text** into the textarea.
2. The input type is auto-detected and displayed as a badge.
3. Click **"Synthesize →"** (or press `Ctrl+Enter` / `Cmd+Enter`).
4. Watch the skeleton loader while the AI works, then see the results card animate in.

### Via the API directly (curl)

**Summarize a URL:**
```bash
curl -X POST http://localhost:3000/api/summarize \
  -H "Content-Type: application/json" \
  -d '{"input": "https://en.wikipedia.org/wiki/Machine_learning"}'
```

**Summarize raw text:**
```bash
curl -X POST http://localhost:3000/api/summarize \
  -H "Content-Type: application/json" \
  -d '{"input": "Quantum computing uses quantum mechanical phenomena like superposition and entanglement to perform computations that classical computers cannot efficiently solve. It has potential applications in cryptography, drug discovery, and optimization problems."}'
```

**Success response:**
```json
{
  "success": true,
  "sourceType": "url",
  "data": {
    "title": "Machine Learning: Algorithms That Learn From Data",
    "summary": "Machine learning is a subset of artificial intelligence ...",
    "key_takeaways": [
      "Supervised learning trains models on labeled datasets ...",
      "Unsupervised learning discovers hidden patterns ...",
      "Deep learning uses neural networks with many layers ..."
    ]
  }
}
```

**Error response:**
```json
{
  "success": false,
  "error": "Could not scrape the URL: Failed to fetch URL (HTTP 403)"
}
```

---

## Project Structure

```
ai-content-synthesizer/
├── server.js       ← Express backend: scraping + AI integration
├── index.html      ← Frontend SPA: UI + fetch logic
├── package.json    ← Dependencies and npm scripts
├── .env            ← API keys and config (NOT committed to git)
└── README.md       ← This file
```

---

## Configuration Options

All options are set in `.env`:

| Variable       | Required | Default                                                    | Description                             |
|----------------|----------|------------------------------------------------------------|-----------------------------------------|
| `GEMINI_API_KEY` | ✅ Yes  | —                                                          | Your Google Gemini API key              |
| `AI_MODEL`     | No       | `gemini-2.0-flash`                                        | Gemini model ID to use                  |
| `AI_BASE_URL`  | No       | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatible endpoint base URL     |
| `PORT`         | No       | `3000`                                                     | Port for the Express server             |

### Using a different AI provider

Because the backend uses the **OpenAI-compatible API format**, you can point it at any compatible provider:

```env
# OpenRouter (access many models)
AI_BASE_URL=https://openrouter.ai/api/v1
GEMINI_API_KEY=your_openrouter_key
AI_MODEL=anthropic/claude-3-haiku

# Local Ollama
AI_BASE_URL=http://localhost:11434/v1
GEMINI_API_KEY=ollama
AI_MODEL=llama3
```

---

## Error Handling

The app handles these failure modes gracefully:

| Scenario                        | Behaviour                                      |
|---------------------------------|------------------------------------------------|
| Invalid / too-short input       | Client-side validation error before any fetch  |
| URL returns 4xx/5xx             | Structured error from scraper shown to user    |
| Site blocks scrapers            | Clear error: "may require JavaScript..."       |
| AI API key missing              | 502 with message to check `.env`               |
| AI returns malformed JSON       | Fallback JSON parsing strips markdown fences   |
| AI schema mismatch              | Validation error with field details            |
| Network timeout (URL >10s)      | AbortSignal.timeout surfaces as user error     |
| Network timeout (AI >30s)       | AbortSignal.timeout surfaces as user error     |

---

## Development Notes

- **`"type": "module"`** in `package.json` means ES Module syntax (`import`/`export`) is used throughout `server.js`. All `require()` calls would need to become `import`.
- The `npm run dev` script uses Node's built-in `--watch` flag (Node 18+) — no nodemon needed.
- Text is truncated to ~12 000 characters before being sent to the AI to avoid token limit errors.
- The frontend uses `Ctrl+Enter` / `Cmd+Enter` as a keyboard shortcut to submit.

---

## License

MIT — free to use, modify, and distribute.
