# Koda AI

Koda AI is a static progressive web app for discovering and comparing AI tools, rewriting prompts, and creating downloadable files. The language model runs in the browser. The app does not require an AI API key or an application server.

## Features

- Firestore-backed catalog search with deterministic local ranking.
- Local text generation through WebGPU and a dedicated Web Worker.
- Prompt Optimizer sessions that rewrite a prompt without executing it.
- Browser-side generation, preview, and download of TXT, Markdown, HTML, CSV, JSON, Word-compatible DOC, PDF, and XLSX files.
- Local conversation history, preferences, generated-file content, and PWA caching.
- Italian and English interface.

## Run Locally

The app uses JavaScript modules, a service worker, and WebGPU. Serve the directory over HTTP instead of opening `index.html` directly.

```powershell
python -m http.server 8080
```

Open `http://localhost:8080/` in a current Chromium-based browser. WebGPU is required for model inference. When WebGPU is unavailable, catalog retrieval, prompt templates, comparisons, and basic file drafts continue to work through deterministic fallbacks.

There is no package installation or build step.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html` | Application UI, React chat, Firestore catalog, local persistence, privacy UI |
| `local-ai.js` | Catalog RAG, tool comparison, prompt rewriting, file routing, validation, fallback logic |
| `ai-worker.js` | SmolLM2 loading and inference outside the UI thread |
| `browser-artifacts.js` | Blob downloads, XLSX/PDF construction, and sandboxed previews |
| `sw.js` | PWA shell and runtime caching |

The detailed model specification is in [AI-MODEL.md](AI-MODEL.md).

## Generated Files

File creation is selected only when a request includes both a creation action and a file or document format. Conversation exports are assembled directly from local chat history; for other requests, the local model produces the source content. `browser-artifacts.js` creates every download entirely on the device.

| Requested format | Download implementation |
| --- | --- |
| TXT, Markdown, HTML, CSV, JSON | Text Blob with the matching MIME type |
| Word | Word-compatible HTML saved as `.doc` |
| PDF | Locally built, text-oriented PDF |
| Excel | Real OOXML `.xlsx` package built in the browser |

HTML previews run in a sandboxed iframe. Scripts, forms, embedded frames, event handlers, and external assets are removed from the preview. PDF output uses a compact built-in renderer and transliterates accented and other non-ASCII characters to ASCII. Generated files should be reviewed before professional or legal use.

## Privacy

Normal chat, catalog retrieval, prompt rewriting, model inference, file conversion, and previews run in the browser. Conversation history and generated-file source content are stored in browser local storage.

Network requests are still required for the application shell, Firestore catalog, runtime, and first model download. Chat prompts are not sent with those requests. Koda does not include a private AI key in the static site.

## Deployment

The workflow in `.github/workflows/deploy.yml` publishes the repository root to GitHub Pages. All application paths are relative, so deployment under a repository subpath is supported.

After changing a cached application module, increment `CACHE_VERSION` in `sw.js` so installed PWAs receive the new shell.

## Known Limits

- SmolLM2-135M-Instruct is very small and primarily understands English. Italian output is validated and may fall back to deterministic text.
- Generated text can be incomplete, inconsistent, or factually wrong. Important information must be checked independently.
- The model download is approximately 118 MB on first use and is cached by the browser.
- Local storage quotas vary by browser. Long generated documents stored in many conversations can consume that quota.
- Catalog refresh and first-run model loading require a network connection. Previously cached app resources can work offline.