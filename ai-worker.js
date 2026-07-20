import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.min.js';

const MODEL_ID = 'HuggingFaceTB/SmolLM2-135M-Instruct';
const DEFAULT_MAX_NEW_TOKENS = 160;
const MAX_REQUEST_TOKENS = 640;
const MAX_WASM_NEW_TOKENS = 192;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;

let generatorPromise = null;

const postStatus = (state, detail = {}) => {
    self.postMessage({ type: 'status', state, ...detail });
};

const normalizeProgress = progress => {
    const percentage = Number(progress.progress);
    return {
        file: typeof progress.file === 'string' ? progress.file : '',
        progress: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : null
    };
};

const selectExecution = async () => {
    let storageBindingLimit = 0;
    if (self.navigator?.gpu) {
        try {
            const adapter = await self.navigator.gpu.requestAdapter();
            storageBindingLimit = Number(adapter?.limits?.maxStorageBufferBindingSize || 0);
            if (adapter) return { device: 'webgpu', dtype: 'q4', backend: 'webgpu', storageBindingLimit };
        } catch (error) {
            console.warn('WebGPU adapter unavailable, using WASM.', error);
        }
    }
    return { device: 'wasm', dtype: 'q4', backend: 'wasm', storageBindingLimit };
};

const loadGenerator = async () => {
    if (!generatorPromise) {
        generatorPromise = selectExecution().then(async execution => {
            postStatus('loading', { progress: 0, ...execution });
            let lastProgressFile = '';
            let lastProgressValue = -1;
            let lastProgressAt = 0;
            const generator = await pipeline('text-generation', MODEL_ID, {
                device: execution.device,
                dtype: execution.dtype,
                progress_callback: progress => {
                    if (progress?.status === 'progress') {
                        const normalized = normalizeProgress(progress);
                        const progressValue = Number.isFinite(normalized.progress) ? Math.floor(normalized.progress) : -1;
                        const now = Date.now();
                        if (normalized.file !== lastProgressFile || progressValue > lastProgressValue || now - lastProgressAt >= 500) {
                            lastProgressFile = normalized.file;
                            lastProgressValue = progressValue;
                            lastProgressAt = now;
                            postStatus('loading', { ...normalized, ...execution });
                        }
                    }
                }
            });
            postStatus('ready', { model: MODEL_ID, ...execution });
            return { generator, execution };
        }).catch(error => {
            generatorPromise = null;
            throw error;
        });
    }

    return generatorPromise;
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

const generate = async (requestId, messages, requestedTokens) => {
    try {
        const { generator, execution } = await loadGenerator();
        const tokenLimit = execution.backend === 'wasm'
            ? Math.min(MAX_WASM_NEW_TOKENS, normalizeTokenLimit(requestedTokens))
            : normalizeTokenLimit(requestedTokens);
        postStatus('generating', { progress: null, ...execution });
        const output = await generator(messages, {
            max_new_tokens: tokenLimit,
            do_sample: false,
            repetition_penalty: 1.12,
            return_full_text: false
        });
        const text = getGeneratedText(output);
        if (!text) throw new Error('EMPTY_MODEL_RESPONSE');
        postStatus('ready', { progress: null, model: MODEL_ID, ...execution });
        self.postMessage({ type: 'result', requestId, text });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        self.postMessage({ type: 'error', requestId, message });
    }
};

self.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'preload') {
        void loadGenerator().catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            self.postMessage({ type: 'preload-error', message });
        });
    } else if (data.type === 'generate' && typeof data.requestId === 'string' && Array.isArray(data.messages)) {
        void generate(data.requestId, data.messages, data.maxNewTokens);
    }
});