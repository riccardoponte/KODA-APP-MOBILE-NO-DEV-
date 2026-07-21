import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

const DEFAULT_MODEL_KEY = 'smollm2-135m';
const MODEL_CATALOG = Object.freeze({
    'smollm2-135m': Object.freeze({
        id: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        downloadBytes: 118000000,
        loader: 'pipeline',
        webgpuDtype: 'q4f16',
        wasmDtype: 'q4',
        requiresWebGPU: false
    })
});
const DEFAULT_MAX_NEW_TOKENS = 120;
const MAX_REQUEST_TOKENS = 384;
const MAX_WASM_NEW_TOKENS = 128;
const OPFS_CACHE_DIRECTORY = 'koda-transformers-cache-smollm2-v1';
const RETIRED_OPFS_CACHE_DIRECTORY = 'koda-transformers-cache-v1';

class OPFSModelCache {
    constructor() {
        this.writeError = null;
        this.directoryPromise = self.navigator?.storage?.getDirectory
            ? self.navigator.storage.getDirectory().then(async root => {
                await root.removeEntry(RETIRED_OPFS_CACHE_DIRECTORY, { recursive: true }).catch(() => {});
                return root.getDirectoryHandle(OPFS_CACHE_DIRECTORY, { create: true });
            })
            : Promise.resolve(null);
        this.browserCachePromise = typeof caches === 'undefined'
            ? Promise.resolve(null)
            : caches.open('transformers-cache').then(async cache => {
                const requests = await cache.keys();
                await Promise.all(requests
                    .filter(request => /\/gemma-[34]-/i.test(request.url))
                    .map(request => cache.delete(request)));
                return cache;
            }).catch(() => null);
    }

    async getKey(request) {
        const bytes = new TextEncoder().encode(String(request));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    }

    async readMetadata(directory, key) {
        try {
            const handle = await directory.getFileHandle(`${key}.json`);
            return JSON.parse(await (await handle.getFile()).text());
        } catch (error) {
            return null;
        }
    }

    async match(request) {
        const directory = await this.directoryPromise;
        if (directory) {
            const key = await this.getKey(request);
            const metadata = await this.readMetadata(directory, key);
            if (metadata?.complete) {
                try {
                    const handle = await directory.getFileHandle(`${key}.bin`);
                    const file = await handle.getFile();
                    if (file.size === metadata.size) {
                        return new Response(file, {
                            status: metadata.status || 200,
                            statusText: metadata.statusText || '',
                            headers: metadata.headers || {}
                        });
                    }
                } catch (error) {
                    // Fall through to the legacy browser cache.
                }
            }
        }

        const browserCache = await this.browserCachePromise;
        return browserCache?.match(request);
    }

    async put(request, response, progressCallback) {
        try {
            const directory = await this.directoryPromise;
            if (!directory || !response?.body) {
                const browserCache = await this.browserCachePromise;
                if (!browserCache) throw new Error('MODEL_CACHE_UNAVAILABLE');
                await browserCache.put(request, response);
                return;
            }

            const key = await this.getKey(request);
            await directory.removeEntry(`${key}.json`).catch(() => {});
            const dataHandle = await directory.getFileHandle(`${key}.bin`, { create: true });
            const writable = await dataHandle.createWritable({ keepExistingData: false });
            const reader = response.body.getReader();
            const total = Number(response.headers.get('content-length')) || 0;
            let loaded = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(value);
                loaded += value.byteLength;
                if (typeof progressCallback === 'function' && total > 0) {
                    progressCallback({ progress: (loaded / total) * 100, loaded, total });
                }
            }
            await writable.close();

            const metadata = {
                complete: true,
                size: loaded,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries())
            };
            const metadataHandle = await directory.getFileHandle(`${key}.json`, { create: true });
            const metadataWritable = await metadataHandle.createWritable({ keepExistingData: false });
            await metadataWritable.write(JSON.stringify(metadata));
            await metadataWritable.close();
        } catch (error) {
            this.writeError = error instanceof Error ? error : new Error(String(error));
            throw error;
        }
    }

    resetWriteError() {
        this.writeError = null;
    }
}

const modelCache = new OPFSModelCache();
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useCustomCache = true;
env.customCache = modelCache;
env.useBrowserCache = false;
env.backends.onnx.wasm.numThreads = 1;

let activeModelKey = null;
let runtimePromise = null;

const postStatus = (state, detail = {}) => {
    self.postMessage({ type: 'status', state, ...detail });
};

const normalizeProgress = progress => {
    const loaded = Number(progress.loaded);
    const total = Number(progress.total);
    const reportedPercentage = Number(progress.progress);
    const percentage = Number.isFinite(reportedPercentage)
        ? reportedPercentage
        : Number.isFinite(loaded) && Number.isFinite(total) && total > 0
            ? (loaded / total) * 100
            : NaN;
    return {
        file: typeof progress.file === 'string' ? progress.file : '',
        loaded: Number.isFinite(loaded) ? Math.max(0, loaded) : null,
        total: Number.isFinite(total) ? Math.max(0, total) : null,
        progress: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : null
    };
};

const getModelDefinition = modelKey => {
    const normalizedKey = typeof modelKey === 'string' ? modelKey : DEFAULT_MODEL_KEY;
    const definition = MODEL_CATALOG[normalizedKey];
    if (!definition) throw new Error('UNKNOWN_LOCAL_MODEL');
    return { key: normalizedKey, ...definition };
};

const selectExecution = async modelDefinition => {
    let storageBindingLimit = 0;
    if (self.navigator?.gpu) {
        try {
            const adapter = await self.navigator.gpu.requestAdapter();
            storageBindingLimit = Number(adapter?.limits?.maxStorageBufferBindingSize || 0);
            if (adapter) {
                return {
                    device: 'webgpu',
                    dtype: modelDefinition.webgpuDtype,
                    backend: 'webgpu',
                    storageBindingLimit
                };
            }
        } catch (error) {
            console.warn('WebGPU adapter unavailable, using WASM.', error);
        }
    }
    if (modelDefinition.requiresWebGPU) throw new Error('WEBGPU_REQUIRED');
    return { device: 'wasm', dtype: modelDefinition.wasmDtype, backend: 'wasm', storageBindingLimit };
};

const loadRuntime = async requestedModelKey => {
    const modelDefinition = getModelDefinition(requestedModelKey);
    if (activeModelKey && activeModelKey !== modelDefinition.key) {
        throw new Error('MODEL_SWITCH_REQUIRES_WORKER_RESTART');
    }

    if (!runtimePromise) {
        activeModelKey = modelDefinition.key;
        modelCache.resetWriteError();
        runtimePromise = selectExecution(modelDefinition).then(async execution => {
            const modelDetail = { modelKey: modelDefinition.key, model: modelDefinition.id };
            postStatus('loading', { progress: 0, ...modelDetail, ...execution });
            const loadedBytesByFile = new Map();
            let lastProgressValue = -1;
            let lastProgressAt = 0;
            const progressCallback = progress => {
                if (progress?.status === 'progress' || progress?.status === 'progress_total') {
                    const normalized = normalizeProgress(progress);
                    if (normalized.file && Number.isFinite(normalized.loaded)) {
                        const previousLoaded = loadedBytesByFile.get(normalized.file) || 0;
                        loadedBytesByFile.set(normalized.file, Math.max(previousLoaded, normalized.loaded));
                    }
                    const aggregateLoaded = [...loadedBytesByFile.values()].reduce((sum, loaded) => sum + loaded, 0);
                    const aggregateProgress = aggregateLoaded > 0 && modelDefinition.downloadBytes > 0
                        ? Math.min(99, (aggregateLoaded / modelDefinition.downloadBytes) * 100)
                        : Number.isFinite(normalized.progress)
                            ? Math.min(99, normalized.progress)
                            : null;
                    const progressValue = Number.isFinite(aggregateProgress) ? Math.floor(aggregateProgress) : -1;
                    const now = Date.now();
                    if (progressValue > lastProgressValue || now - lastProgressAt >= 300) {
                        lastProgressValue = Math.max(lastProgressValue, progressValue);
                        lastProgressAt = now;
                        postStatus('loading', {
                            file: normalized.file,
                            progress: Math.max(0, lastProgressValue),
                            ...modelDetail,
                            ...execution
                        });
                    }
                }
            };

            const generator = await pipeline('text-generation', modelDefinition.id, {
                device: execution.device,
                dtype: execution.dtype,
                progress_callback: progressCallback
            });
            return { generator, modelDefinition, execution };
        }).catch(error => {
            activeModelKey = null;
            runtimePromise = null;
            throw error;
        });
    }

    return runtimePromise;
};

const getGeneratedText = output => {
    const generated = output?.[0]?.generated_text;
    if (Array.isArray(generated)) {
        const lastMessage = generated.at(-1);
        return typeof lastMessage?.content === 'string' ? lastMessage.content.trim() : '';
    }
    return typeof generated === 'string' ? generated.trim() : '';
};

const normalizeTokenLimit = value => Number.isFinite(value)
    ? Math.max(32, Math.min(MAX_REQUEST_TOKENS, Math.round(value)))
    : DEFAULT_MAX_NEW_TOKENS;

const generate = async (requestId, messages, requestedTokens, requestedModelKey) => {
    try {
        const runtime = await loadRuntime(requestedModelKey);
        const { execution, modelDefinition } = runtime;
        const tokenLimit = execution.backend === 'wasm'
            ? Math.min(MAX_WASM_NEW_TOKENS, normalizeTokenLimit(requestedTokens))
            : normalizeTokenLimit(requestedTokens);
        const modelDetail = { modelKey: modelDefinition.key, model: modelDefinition.id };
        postStatus('generating', { progress: null, ...modelDetail, ...execution });
        const text = getGeneratedText(await runtime.generator(messages, {
            max_new_tokens: tokenLimit,
            do_sample: false,
            repetition_penalty: 1.16,
            return_full_text: false
        }));
        if (!text) throw new Error('EMPTY_MODEL_RESPONSE');
        postStatus('ready', { progress: null, ...modelDetail, ...execution });
        self.postMessage({ type: 'result', requestId, text });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        self.postMessage({ type: 'error', requestId, message });
    }
};

self.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'preload') {
        void loadRuntime(data.modelKey).then(runtime => {
            if (modelCache.writeError) throw new Error('MODEL_CACHE_WRITE_FAILED');
            const modelDetail = { modelKey: runtime.modelDefinition.key, model: runtime.modelDefinition.id };
            postStatus('ready', { ...modelDetail, ...runtime.execution });
        }).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            self.postMessage({ type: 'preload-error', modelKey: data.modelKey, message });
        });
    } else if (data.type === 'generate' && typeof data.requestId === 'string' && Array.isArray(data.messages)) {
        void generate(data.requestId, data.messages, data.maxNewTokens, data.modelKey);
    }
});