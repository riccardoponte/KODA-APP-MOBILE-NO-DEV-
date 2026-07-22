# Local AI Model

## Model

| Model | Model ID | Execution | Quantization | Approximate download |
| --- | --- | --- | --- | --- |
| SmolLM2 135M | `HuggingFaceTB/SmolLM2-135M-Instruct` | WebGPU or WASM | `q4f16` on WebGPU, `q4` on WASM | 118 MB |

Koda uses Transformers.js 4.2.0 and the text-generation pipeline in a dedicated Web Worker. SmolLM2 is the only selectable runtime internally; the application does not expose a model picker.

Model card:

- <https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct>

Review each model card and linked license before redistribution. This document is a technical summary, not legal advice. Koda does not send prompts to a hosted model endpoint.

## Runtime Flow

```mermaid
flowchart LR
    U[User message] --> R{Local router}
    R --> S[Guided state machine]
    R --> D[Deterministic handlers]
    R --> C[Firestore catalog RAG]
    R --> P[Prompt Optimizer]
    R --> T[Translation or rewrite]
    R --> G[Open conversation]
    S --> O
    D --> O[Rendered response]
    C --> O
    P --> O
    T --> W[Web Worker]
    G --> W
    W --> V[Local validation]
    V -->|Accepted| O
    V -->|Invalid or unavailable| B[Verified fallback]
    B --> O
```

`local-ai.js` creates a verified draft before model inference. Model output replaces that draft only when mode-specific validation succeeds.

## Response Hardening

Common, bounded requests bypass SmolLM2. Deterministic handlers cover conversation controls, safety and high-stakes boundaries, live-data limitations, arithmetic and percentages, local date/time, text counts, common unit conversions, selected stable definitions and comparisons, extractive summaries, outlines, checklists, agendas, plans, email and social templates, and common Italian/English translations.

Open-ended conversation is limited to AI, models, prompts, and the verified catalog. It has a separate system prompt requiring a direct first sentence, stable knowledge, concise structure, explicit uncertainty, and no invented live data, sources, URLs, or actions. Validation checks topic overlap, language, informative content, prompt leakage, repeated segments, degenerate token repetition, and unapproved URLs. Unrelated conversation is redirected to the guided menu without model inference.

Arbitrary translation and rewriting use a transformation-only prompt. Accepted output must preserve source numbers, URLs, email addresses, placeholders, acronyms, and proper-name tokens. Translation also enforces the target language and rejects unchanged or excessively expanded text.

## Guided Interaction

Greetings and short or incomplete messages open a deterministic menu with two paths: find an AI tool or compare two AI tools. Each path is an explicit JavaScript state machine and exposes optional quick-reply buttons. Comparison suggestions are read from the full live catalog, ordered with featured records first and then alphabetically, and paged four at a time through `Show more`/`Mostra altri`. Suggestions that represent catalog tools include their live catalog logo, with initials as a loading or error fallback. The same choices also accept typed labels and numbered answers. Users can still type a freeform question about AI or the catalog without a dedicated menu button.

An active path owns the next message. Invalid or unrelated replies repeat the current question and valid choices instead of falling through to open conversation. `back`/`indietro`, `menu`, and `cancel`/`annulla` provide deterministic navigation. Complete supported requests can still bypass the menu.

Guided recommendations use only declared Firestore specializations and create/read/edit capabilities. All compatible records are available in pages of four through `Show more`/`Mostra altri`; each card preloads its catalog logo and keeps initials visible while loading or after an image error. Guided comparisons use verified catalog records. No guided step invokes SmolLM2.

## Retrieval and Grounding

### Catalog RAG

Catalog entries come from Firestore and are ranked locally. Name matches, category and description terms, aliases, alternatives, requested pricing, structured specializations, and declared capabilities contribute to the score. Controlled family aliases resolve common shorthand such as `GPT` to `ChatGPT` and `Gemini` to `Google Gemini`; full catalog names take precedence on overlaps, so `Zero GPT` remains distinct. Guided tool selection also accepts a very close spelling error only when one catalog name is the unique match, and displays the interpreted name before continuing. The router detects both the requested area (`excel`, `word`, `pptx`, `pdf`, `images`, `video`, `audio`, `code`, `data`, or `automation`) and the requested operation (`create`, `read`, or `edit`).

When structured candidates exist, only tools with a compatible declared capability are recommended. If the specialization exists but the operation is not confirmed for any tool, the deterministic response states that no compatible capability is recorded. Legacy records without structured metadata retain the previous text-based ranking fallback when no structured candidate is available.

Tool comparisons are deterministic and use only Firestore fields. They include logos in the UI, descriptions, categories, pricing, websites, specialization badges, and a create/read/edit matrix. Missing values are labeled as not specified; the recommendation distinguishes declared coverage from output quality. At most five verified records are placed in a model prompt. Unknown tool names and unverified bullet entries are rejected.

### Prompt Optimizer

Prompt Optimizer is an inline mode in the existing conversation. Toggling it does not clear messages or open a separate chat. With SmolLM2 it uses the deterministic seven-section rewrite directly, avoiding a slower model attempt that is unlikely to pass validation.

### File Requests

Explicit requests to generate files return a deterministic unavailable response. They do not invoke SmolLM2 and do not attach downloadable content. Requests to find catalog tools capable of creating or editing a format remain supported.

## Loading, Caching, and Timeouts

- No model download starts automatically when the application opens.
- The first request that needs generation downloads SmolLM2 lazily. There is no model selector or download panel.
- Transformers.js downloads model assets from Hugging Face and its runtime from jsDelivr.
- Transformers.js uses a custom OPFS cache that streams weights to local browser storage. Existing Cache API entries remain readable as a compatibility fallback. The service worker caches application modules, not model weights.
- The SmolLM2 cache uses a dedicated directory. On first migration it removes the retired Gemma OPFS directory, related Cache API entries, and the old dual-model marker.
- WebGPU is preferred. SmolLM2 falls back to single-threaded WASM when WebGPU is unavailable.
- Normal model requests use a 120-second inactivity timeout. WASM requests use 240 seconds.
- The worker aggregates downloaded bytes across concurrent files and emits monotonic progress at a limited rate.

If WebGPU is unavailable or the worker fails, Koda switches to the verified deterministic result. A failed worker is not repeatedly recreated during the same page session.

## Regression Tests

Run the local suite from the application directory:

```powershell
node --test tests/local-ai.test.mjs
```

The suite uses a simulated Worker and controlled outputs, so it tests model acceptance and rejection without loading model weights. It also covers multi-turn guided recommendations, comparisons, blocked file requests, quick-reply metadata, and focus recovery. Intent and strategy metadata distinguish deterministic, accepted-model, and verified-fallback paths.

## Limitations

SmolLM2 135M is optimized for size and speed. It primarily understands English and has limited factual recall, reasoning, context handling, and Italian quality. Raw output may be irrelevant, repetitive, incomplete, or switch language.

Koda mitigates these limits with short prompts, reduced history, deterministic drafts, verified catalog records, language and topic validation, repetition checks, and mode-specific fallbacks. Invalid model output is discarded. These controls reduce risk but do not make generated content authoritative. Users should verify important factual, financial, medical, legal, or security-related output.