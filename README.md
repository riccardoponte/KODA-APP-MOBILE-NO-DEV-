# Koda AI

Koda AI is a static progressive web app for discovering and comparing AI tools, rewriting prompts, and creating downloadable files. The language model runs in the browser. The app does not require an AI API key or an application server.

## Features

- Firestore-backed catalog search with deterministic ranking by specialization and declared create/read/edit capabilities.
- Structured, logo-based tool comparisons with responsive capability matrices.
- Manually authored Italian and English news with exactly three hashtags per item.
- Local text generation through WebGPU and a dedicated Web Worker.
- A bilingual deterministic router for common knowledge, calculations, percentages, unit conversions, local date/time, text metrics, summaries, templates, safety boundaries, and structured writing tasks.
- An inline Prompt Optimizer mode that rewrites a prompt without leaving the current conversation.
- Browser-side generation, preview, and download of TXT, Markdown, HTML, CSV, JSON, Word-compatible DOC, PDF, and XLSX files.
- Local conversation history, preferences, generated-file content, and PWA caching.
- Italian and English interface.

## Run Locally

The app uses JavaScript modules, a service worker, and WebGPU. Serve the directory over HTTP instead of opening `index.html` directly.

```powershell
python -m http.server 8080
```

Open `http://localhost:8080/` in a current browser. SmolLM2 uses WebGPU when available and falls back to WASM. Catalog retrieval, prompt templates, comparisons, and basic file drafts also remain available through deterministic fallbacks.

There is no package installation or build step.

## Test

The local AI regression suite uses Node's built-in test runner and a simulated Worker. It does not download or execute SmolLM2.

```powershell
node --test tests/local-ai.test.mjs
```

The suite covers Italian and English routing, catalog capabilities and comparisons, Prompt Optimizer, transformations, open conversation validation, safe file generation, and rejected model output.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html` | Application UI, React chat, Firestore catalog, local persistence, privacy UI |
| `local-ai.js` | Deterministic routing, catalog RAG, tool comparison, prompt rewriting, model prompts, validation, and fallback logic |
| `ai-worker.js` | SmolLM2 loading, caching, and inference outside the UI thread |
| `browser-artifacts.js` | Blob downloads, XLSX/PDF construction, and sandboxed previews |
| `sw.js` | PWA shell and runtime caching |

The detailed model specification is in [AI-MODEL.md](AI-MODEL.md).

## Firestore Data Contracts

Tool records can declare supported formats and operations. Stable specialization keys are `excel`, `word`, `pptx`, `pdf`, `images`, `video`, `audio`, `code`, `data`, and `automation`.

```json
{
	"specializations": [
		{
			"type": "pptx",
			"capabilities": {
				"create": true,
				"read": true,
				"edit": false
			}
		}
	]
}
```

Generic catalog requests such as "create an Excel file" or "edit a PPTX" are matched against these fields. If tools exist for the requested specialization but none confirms the requested operation, Koda reports that gap instead of presenting an unverified capability. Older tool records without `specializations` remain readable and can still be found through name, category, and description matching.

News records store manually entered Italian and English text plus three distinct hashtags:

```json
{
	"title": { "it": "Titolo italiano", "en": "English title" },
	"content": { "it": "Contenuto italiano", "en": "English content" },
	"hashtags": ["AI", "News", "Tecnologia"]
}
```

Legacy news records whose `title` and `content` are strings remain supported.

## Generated Files

File creation is selected only when a request includes both a creation action and a file or document format. Catalog-discovery requests such as "recommend a tool to create Excel files" remain catalog requests. Conversation exports are assembled directly from local chat history; for other requests, the local model can replace a deterministic draft only after format validation succeeds. `browser-artifacts.js` creates every download entirely on the device.

Fallback spreadsheets infer useful columns for contacts, expenses, projects, and inventory. Report, memo, and letter drafts use explicit sections and placeholders rather than invented facts. Generated HTML cannot contain scripts, frames, forms, event handlers, or remote assets, and CSV/XLSX source rows must have a consistent column count.

| Requested format | Download implementation |
| --- | --- |
| TXT, Markdown, HTML, CSV, JSON | Text Blob with the matching MIME type |
| Word | Word-compatible HTML saved as `.doc` |
| PDF | Locally built, text-oriented PDF |
| Excel | Real OOXML `.xlsx` package built in the browser |

HTML previews run in a sandboxed iframe. Scripts, forms, embedded frames, event handlers, and external assets are removed from the preview. PDF output uses a compact built-in renderer and transliterates accented and other non-ASCII characters to ASCII. Generated files should be reviewed before professional or legal use.

## Privacy

Normal chat, catalog retrieval, prompt rewriting, model inference, file conversion, and previews run in the browser. Conversation history and generated-file source content are stored in browser local storage.

Network requests are still required for the application shell, Firestore catalog, runtime, and the first SmolLM2 download. Chat prompts are not sent with those requests. Koda does not include a private AI key in the static site.

## Deployment

The workflow in `.github/workflows/deploy.yml` publishes the repository root to GitHub Pages. All application paths are relative, so deployment under a repository subpath is supported.

After changing a cached application module, increment `CACHE_VERSION` in `sw.js` so installed PWAs receive the new shell.

## Known Limits

- SmolLM2 135M is the sole local model and can run through WebGPU or WASM.
- Generated text can be incomplete, inconsistent, or factually wrong. Important information must be checked independently.
- The first generated response downloads approximately 118 MB and stores it through streaming OPFS where available.
- SmolLM2 is primarily English and has limited Italian and general-knowledge quality. Topic, language, and repetition validation can replace rejected output with a deterministic fallback.
- Open-ended translation, rewriting, conversation, and file generation may return a verified draft when model output changes protected names or numbers, invents a URL, leaks prompt text, repeats itself, switches language, or fails the requested format.
- Catalog refresh and uncached model loading require a network connection. Previously cached app resources can work offline.