const STATUS_EVENT = 'koda-local-ai-status';
const WORKER_URL = new URL('./ai-worker.js', import.meta.url);
const MAX_CONTEXT_TOOLS = 5;
const MAX_HISTORY_MESSAGES = 6;
const MAX_SESSION_HISTORY_MESSAGES = 80;
const MAX_PROMPT_LENGTH = 4000;
const PROMPT_REWRITE_MODE = 'prompt-rewrite';
const FILE_GENERATION_MODE = 'file-generation';
const CONVERSATION_MODE = 'conversation';
const MODEL_IDLE_TIMEOUT_MS = 30000;
const FILE_MODEL_IDLE_TIMEOUT_MS = 60000;
const WASM_MODEL_IDLE_TIMEOUT_MS = 300000;
const MAX_ARTIFACT_CONTENT = 24000;
const MODEL_PROMPT_LEAKAGE = /\b(verifaxed|verifydraft|verified draft|verified database records|database records|user request|raw prompt to rewrite)\b/i;

const hasLocalInference = () => typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';

let status = {
    state: 'idle',
    progress: null,
    supported: hasLocalInference()
};
let worker = null;
let workerUnavailable = false;
let requestSequence = 0;
const pendingRequests = new Map();

const refreshRequestTimeout = requestId => {
    const request = pendingRequests.get(requestId);
    if (!request) return;
    clearTimeout(request.timeoutId);
    request.timeoutId = setTimeout(() => {
        const activeRequest = pendingRequests.get(requestId);
        if (!activeRequest) return;
        pendingRequests.delete(requestId);
        activeRequest.reject(new Error('LOCAL_MODEL_TIMEOUT'));
        disableWorker('LOCAL_MODEL_TIMEOUT');
    }, request.idleTimeoutMs || MODEL_IDLE_TIMEOUT_MS);
};

const updateStatus = nextStatus => {
    status = { ...status, ...nextStatus };
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { ...status } }));
    }
};

const disableWorker = reason => {
    workerUnavailable = true;
    if (worker) worker.terminate();
    worker = null;
    updateStatus({ state: 'fallback', progress: null, reason: String(reason || '') });
    for (const request of pendingRequests.values()) {
        clearTimeout(request.timeoutId);
        request.reject(new Error(String(reason || 'LOCAL_MODEL_UNAVAILABLE')));
    }
    pendingRequests.clear();
};

const ensureWorker = () => {
    if (!hasLocalInference()) {
        updateStatus({ state: 'fallback', supported: false, reason: 'LOCAL_INFERENCE_UNAVAILABLE' });
        throw new Error('LOCAL_INFERENCE_UNAVAILABLE');
    }
    if (workerUnavailable) throw new Error('LOCAL_MODEL_UNAVAILABLE');
    if (worker) return worker;

    worker = new Worker(WORKER_URL, { type: 'module', name: 'koda-local-ai' });
    worker.addEventListener('message', event => {
        const data = event.data || {};
        if (data.type === 'status') {
            updateStatus({
                state: data.state || status.state,
                progress: data.progress === null ? null : Number.isFinite(data.progress) ? data.progress : status.progress,
                file: typeof data.file === 'string' ? data.file : '',
                backend: typeof data.backend === 'string' ? data.backend : status.backend,
                dtype: typeof data.dtype === 'string' ? data.dtype : status.dtype,
                storageBindingLimit: Number.isFinite(data.storageBindingLimit) ? data.storageBindingLimit : status.storageBindingLimit,
                supported: true
            });
            for (const [requestId, request] of pendingRequests.entries()) {
                if (data.backend === 'wasm') request.idleTimeoutMs = Math.max(request.idleTimeoutMs || 0, WASM_MODEL_IDLE_TIMEOUT_MS);
                refreshRequestTimeout(requestId);
            }
            return;
        }
        if (data.type === 'preload-error') {
            updateStatus({ state: 'fallback', progress: null, reason: data.message || 'LOCAL_MODEL_PRELOAD_ERROR' });
            return;
        }

        if (typeof data.requestId !== 'string') return;
        const request = pendingRequests.get(data.requestId);
        if (!request) return;
        pendingRequests.delete(data.requestId);
        clearTimeout(request.timeoutId);

        if (data.type === 'result' && typeof data.text === 'string') {
            request.resolve(data.text);
        } else if (data.type === 'error') {
            request.reject(new Error(data.message || 'LOCAL_MODEL_ERROR'));
            disableWorker(data.message || 'LOCAL_MODEL_ERROR');
        }
    });
    worker.addEventListener('error', event => {
        event.preventDefault();
        disableWorker(event.message || 'LOCAL_MODEL_WORKER_ERROR');
    });
    return worker;
};

const preloadLocalModel = () => {
    try {
        ensureWorker().postMessage({ type: 'preload' });
        return true;
    } catch (error) {
        return false;
    }
};

const generateWithModel = (messages, { maxNewTokens = 160, idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
    let activeWorker;
    try {
        activeWorker = ensureWorker();
    } catch (error) {
        reject(error);
        return;
    }

    const requestId = `local-ai-${Date.now()}-${++requestSequence}`;
    pendingRequests.set(requestId, { resolve, reject, timeoutId: null, idleTimeoutMs });
    refreshRequestTimeout(requestId);
    activeWorker.postMessage({ type: 'generate', requestId, messages, maxNewTokens });
});

const normalizeText = value => String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const detectResponseLanguage = (message, fallback = 'it') => {
    const normalized = normalizeText(message);
    if (/^(hello|hi|hey|thanks|thank you|yes|no)\b/.test(normalized)) return 'en';
    if (/^(ciao|salve|grazie|si|no)\b/.test(normalized)) return 'it';
    if (/^(compare|recommend|suggest|find|tell|explain|show|create|generate|prepare|write|help)\b/.test(normalized)) return 'en';
    if (/^(confronta|confrontami|compara|paragona|consiglia|consigliami|trova|dimmi|spiega|mostra|crea|genera|prepara|scrivi|aiutami)\b/.test(normalized)) return 'it';

    const englishMarkers = normalized.match(/\b(i|you|your|we|my|me|the|and|what|which|who|where|when|why|how|can|could|would|please|give|list|tell|write|create|make|find|recommend|suggest|compare|about|for|with|from|this|that|is|are|do|does|need|want|help|show|explain|best|tool|tools|image|images|answer|question|email)\b/g) || [];
    const italianMarkers = normalized.match(/\b(il|lo|la|gli|le|che|chi|cosa|come|dove|quando|perche|quale|puoi|potresti|vorrei|scrivi|crea|fammi|trova|consiglia|consigliami|confronta|dimmi|spiega|mostra|aiutami|per|con|sono|questo|questa|dalla|delle)\b/g) || [];
    if (englishMarkers.length > italianMarkers.length) return 'en';
    if (italianMarkers.length > englishMarkers.length) return 'it';
    return fallback === 'en' ? 'en' : 'it';
};

const compactText = value => normalizeText(value).replace(/\s+/g, '');

const localizedValue = (value, lang) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    return value[lang] || value.en || value.it || Object.values(value).find(item => typeof item === 'string') || '';
};

const stopWords = new Set([
    'a', 'ai', 'al', 'all', 'alla', 'anche', 'and', 'are', 'che', 'con', 'da', 'dei', 'del', 'della', 'di',
    'do', 'e', 'for', 'gli', 'ho', 'i', 'il', 'in', 'is', 'it', 'la', 'le', 'mi', 'of', 'on', 'o', 'per',
    'piu', 'puoi', 'the', 'to', 'un', 'una', 'uno', 'use', 'voglio', 'what', 'which', 'with'
]);

const conceptAliases = new Map([
    ['immagine', ['immagini', 'foto', 'grafica', 'design', 'arte', 'image', 'photo', 'visual']],
    ['immagini', ['immagine', 'foto', 'grafica', 'design', 'arte', 'image', 'photo', 'visual']],
    ['video', ['filmato', 'montaggio', 'editing', 'animation', 'animazione']],
    ['audio', ['voce', 'musica', 'sound', 'voice', 'music']],
    ['musica', ['audio', 'sound', 'music']],
    ['presentazione', ['presentazioni', 'slide', 'slides', 'powerpoint']],
    ['documento', ['documenti', 'pdf', 'document', 'documents']],
    ['automatizzare', ['automazione', 'automation', 'workflow', 'produttivita']],
    ['automation', ['automazione', 'automatizzare', 'workflow', 'productivity']]
]);

const queryTerms = query => {
    const original = normalizeText(query).split(/\s+/).filter(term => term.length > 1 && !stopWords.has(term));
    const expanded = new Set(original);
    for (const term of original) {
        for (const alias of conceptAliases.get(term) || []) expanded.add(alias);
    }
    return [...expanded];
};

const getToolFields = (tool, lang) => {
    const name = String(tool?.name || '').trim();
    const description = localizedValue(tool?.description, lang).trim();
    const category = localizedValue(tool?.category, lang).trim();
    const alternatives = Array.isArray(tool?.alternatives) ? tool.alternatives.map(String) : [];
    return {
        tool,
        name,
        description,
        category,
        alternatives,
        pricing: normalizeText(tool?.pricing),
        nameNorm: normalizeText(name),
        nameCompact: compactText(name),
        descriptionNorm: normalizeText(description),
        categoryNorm: normalizeText(category),
        alternativesNorm: normalizeText(alternatives.join(' '))
    };
};

const detectPricing = query => {
    const normalized = normalizeText(query);
    if (/\bfreemium\b/.test(normalized)) return 'freemium';
    if (/\b(a pagamento|pagamento|paid|premium)\b/.test(normalized)) return 'paid';
    if (/\b(gratis|gratuito|gratuita|free)\b/.test(normalized)) return 'free';
    return '';
};

const rankTools = (query, tools, lang) => {
    const normalizedQuery = normalizeText(query);
    const compactQuery = compactText(query);
    const terms = queryTerms(query);
    const requestedPricing = detectPricing(query);

    return tools.map(tool => {
        const fields = getToolFields(tool, lang);
        if (!fields.name) return { ...fields, score: 0 };

        let score = 0;
        if (normalizedQuery === fields.nameNorm) score += 1000;
        if (fields.nameNorm.length > 2 && (` ${normalizedQuery} `).includes(` ${fields.nameNorm} `)) score += 140;
        if (fields.nameCompact.length > 3 && compactQuery.includes(fields.nameCompact)) score += 90;

        for (const term of terms) {
            if (fields.nameNorm.split(' ').includes(term)) score += 28;
            else if (fields.nameNorm.includes(term)) score += 14;
            if (fields.categoryNorm.includes(term)) score += 10;
            if (fields.descriptionNorm.includes(term)) score += 5;
            if (fields.alternativesNorm.includes(term)) score += 3;
        }

        if (requestedPricing) {
            score += fields.pricing === requestedPricing ? 35 : -25;
        }
        return { ...fields, score };
    }).filter(item => item.score >= 8)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
        .slice(0, MAX_CONTEXT_TOOLS);
};

const findReferencedTools = (query, tools, lang) => {
    const compactQuery = compactText(query);
    const candidates = tools.flatMap(tool => {
        const fields = getToolFields(tool, lang);
        if (fields.nameNorm.length <= 2 || fields.nameCompact.length <= 3) return [];
        const matches = [];
        let referenceIndex = compactQuery.indexOf(fields.nameCompact);
        while (referenceIndex >= 0) {
            matches.push({
                ...fields,
                referenceIndex,
                referenceEnd: referenceIndex + fields.nameCompact.length
            });
            referenceIndex = compactQuery.indexOf(fields.nameCompact, referenceIndex + 1);
        }
        return matches;
    }).sort((left, right) => left.referenceIndex - right.referenceIndex || right.nameCompact.length - left.nameCompact.length);

    const nonOverlapping = [];
    for (const candidate of candidates) {
        const overlaps = nonOverlapping.some(selected =>
            candidate.referenceIndex < selected.referenceEnd && candidate.referenceEnd > selected.referenceIndex);
        if (!overlaps) nonOverlapping.push(candidate);
    }

    return nonOverlapping
        .sort((left, right) => left.referenceIndex - right.referenceIndex)
        .filter((fields, index, all) => {
            const key = String(fields.tool?.id ?? fields.nameNorm);
            return all.findIndex(item => String(item.tool?.id ?? item.nameNorm) === key) === index;
        });
};

const shorten = (value, maxLength = 170) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength - 1);
    const lastSpace = truncated.lastIndexOf(' ');
    return `${truncated.slice(0, Math.max(lastSpace, 40))}.`;
};

const toolDescription = (fields, lang) => shorten(fields.description || (
    lang === 'it' ? 'Strumento AI presente nel catalogo Koda.' : 'AI tool in the Koda catalog.'
));

const pricingLabel = (pricing, lang) => {
    const labels = lang === 'it'
        ? { free: 'Gratuito', freemium: 'Freemium', paid: 'A pagamento' }
        : { free: 'Free', freemium: 'Freemium', paid: 'Paid' };
    return labels[pricing] || pricing;
};

const formatToolList = (heading, fields, lang, showPricing = false) => {
    const lines = fields.map(item => {
        const price = showPricing && item.pricing ? ` [${pricingLabel(item.pricing, lang)}]` : '';
        return `\u2022 **${item.name}**: ${toolDescription(item, lang)}${price}`;
    });
    return `${heading}\n${lines.join('\n')}`;
};

const isToolComparisonRequest = query => /\b(vs|versus|confronta|confrontare|confrontami|confronto|compara|comparare|paragona|paragonare|differenza|differenze|compare|comparison|difference|differences|quale e meglio|qual e meglio|quale scegliere|which is better)\b/.test(normalizeText(query));

const formatToolComparison = (left, right, lang) => {
    const missing = lang === 'it' ? 'Non indicato' : 'Not specified';
    const leftCategory = left.category || missing;
    const rightCategory = right.category || missing;
    const leftPricing = left.pricing ? pricingLabel(left.pricing, lang) : missing;
    const rightPricing = right.pricing ? pricingLabel(right.pricing, lang) : missing;
    const leftDescription = toolDescription(left, lang);
    const rightDescription = toolDescription(right, lang);
    const pricingDifference = leftPricing === rightPricing
        ? (lang === 'it'
            ? `Il modello di prezzo indicato è lo stesso: **${leftPricing}**.`
            : `The listed pricing model is the same: **${leftPricing}**.`)
        : (lang === 'it'
            ? `Sul prezzo, **${left.name}** è ${leftPricing}; **${right.name}** è ${rightPricing}.`
            : `For pricing, **${left.name}** is ${leftPricing}; **${right.name}** is ${rightPricing}.`);

    if (lang === 'it') {
        return [
            `**Confronto: ${left.name} vs ${right.name}**`,
            '',
            `**${left.name}**`,
            `Categoria: ${leftCategory}`,
            `Prezzo: ${leftPricing}`,
            `Funzione: ${leftDescription}`,
            '',
            `**${right.name}**`,
            `Categoria: ${rightCategory}`,
            `Prezzo: ${rightPricing}`,
            `Funzione: ${rightDescription}`,
            '',
            '**Differenze principali**',
            `${left.name} è orientato a: ${leftDescription}`,
            `${right.name} è orientato a: ${rightDescription}`,
            pricingDifference,
            '',
            '**Come scegliere**',
            `Scegli **${left.name}** se la sua funzione corrisponde meglio al tuo obiettivo; scegli **${right.name}** se ti serve soprattutto la seconda funzione descritta.`
        ].join('\n');
    }

    return [
        `**Comparison: ${left.name} vs ${right.name}**`,
        '',
        `**${left.name}**`,
        `Category: ${leftCategory}`,
        `Pricing: ${leftPricing}`,
        `Purpose: ${leftDescription}`,
        '',
        `**${right.name}**`,
        `Category: ${rightCategory}`,
        `Pricing: ${rightPricing}`,
        `Purpose: ${rightDescription}`,
        '',
        '**Main differences**',
        `${left.name} is designed for: ${leftDescription}`,
        `${right.name} is designed for: ${rightDescription}`,
        pricingDifference,
        '',
        '**How to choose**',
        `Choose **${left.name}** if its purpose better matches your goal; choose **${right.name}** if you mainly need the second purpose described.`
    ].join('\n');
};

const isSimpleGreeting = query => /^(ciao|salve|hey|hello|hi|buongiorno|buonasera)[!. ]*$/.test(normalizeText(query));
const isSocialQuestion = query => /\b(come stai|come va|tutto bene|how are you|how is it going|whats up)\b/.test(normalizeText(query));
const isCapabilityQuestion = query => /\b(che fai|cosa fai|cosa sai fare|come puoi aiutarmi|come mi puoi aiutare|in cosa puoi aiutarmi|chi sei|what can you do|how can you help|who are you)\b/.test(normalizeText(query));
const isThanks = query => /^(grazie|perfetto|ok grazie|thanks|thank you|perfect)[!. ]*$/.test(normalizeText(query));
const isPositiveReply = query => /^(si|yes|esatto|correct|ok|giusto)$/.test(normalizeText(query));
const isVague = query => /^(aiutami|help me|non so|boh|help)[!. ]*$/.test(normalizeText(query));

const conversationFallback = lang => lang === 'it'
    ? 'Posso aiutarti a sviluppare questa richiesta. Aggiungi il contesto o il risultato che vuoi ottenere e continueremo da lì; quando serve, posso anche proporti strumenti reali del catalogo.'
    : 'I can help you develop this request. Add the context or result you want and we can continue from there; when useful, I can also suggest real tools from the catalog.';

const findExactRequest = (query, tools, lang) => {
    const stripped = normalizeText(query).replace(/^(cos e|cosa e|parlami di|dimmi di|what is|tell me about)\s+/, '');
    return tools.map(tool => getToolFields(tool, lang)).find(fields => fields.nameNorm === stripped) || null;
};

const findSimilarName = (query, tools, lang) => {
    const stripped = normalizeText(query).replace(/^(cos e|cosa e|parlami di|dimmi di|what is|tell me about)\s+/, '');
    const compact = compactText(stripped);
    if (compact.length < 4) return null;
    return tools.map(tool => getToolFields(tool, lang)).find(fields => fields.nameCompact === compact && fields.nameNorm !== stripped) || null;
};

const alternativeTools = (source, tools, lang) => {
    const indexed = tools.map(tool => getToolFields(tool, lang));
    const namedAlternatives = source.alternatives
        .map(name => indexed.find(candidate => candidate.nameNorm === normalizeText(name)))
        .filter(Boolean);
    if (namedAlternatives.length) return namedAlternatives.slice(0, MAX_CONTEXT_TOOLS);

    if (!source.categoryNorm) return [];
    return indexed.filter(candidate => candidate.nameNorm !== source.nameNorm && candidate.categoryNorm === source.categoryNorm)
        .slice(0, MAX_CONTEXT_TOOLS);
};

const createResponsePlan = (chat, message, tools) => {
    const lang = chat.lang;
    const normalized = normalizeText(message);
    const ranked = rankTools(message, tools, lang);
    const referenced = findReferencedTools(message, tools, lang);

    if (chat.pendingComparisonTool && referenced.length === 1) {
        const pending = getToolFields(chat.pendingComparisonTool, lang);
        const candidate = referenced[0];
        const directReply = normalized.replace(/^(?:con|e|vs|versus|with|and)\s+/, '');
        const isDirectNameReply = directReply === candidate.nameNorm || compactText(directReply) === candidate.nameCompact;
        if (isDirectNameReply && candidate.nameNorm !== pending.nameNorm) {
            chat.pendingComparisonTool = null;
            return {
                text: formatToolComparison(pending, candidate, lang),
                context: [pending, candidate],
                useModel: false
            };
        }
    }

    if (isPositiveReply(message) && chat.pendingTool) {
        const pending = getToolFields(chat.pendingTool, lang);
        chat.pendingTool = null;
        return {
            text: formatToolList(lang === 'it' ? 'Ecco lo strumento richiesto.' : 'Here is the requested tool.', [pending], lang),
            context: [pending],
            useModel: false
        };
    }
    if (isSimpleGreeting(message)) {
        return {
            text: lang === 'it'
                ? 'Ciao! Raccontami pure cosa vuoi fare o di cosa vuoi parlare. Se ti serve, posso anche consigliarti strumenti del catalogo.'
                : 'Hi! Tell me what you want to do or talk about. I can also recommend tools from the catalog when useful.',
            context: [],
            useModel: false
        };
    }
    if (isSocialQuestion(message)) {
        return {
            text: lang === 'it'
                ? "Bene, grazie. Di cosa vuoi parlare? Posso aiutarti a sviluppare un'idea o trovare uno strumento adatto."
                : 'Doing well, thanks. What would you like to talk about? I can help develop an idea or find a suitable tool.',
            context: [],
            useModel: false
        };
    }
    if (isCapabilityQuestion(message)) {
        return {
            text: lang === 'it'
                ? 'Posso dialogare con te, rispondere a domande, sviluppare idee, consigliare e confrontare strumenti del catalogo, migliorare prompt e creare file scaricabili. Dimmi cosa vuoi ottenere.'
                : 'I can talk things through with you, answer questions, develop ideas, recommend and compare catalog tools, improve prompts, and create downloadable files. Tell me what you want to accomplish.',
            context: [],
            useModel: false
        };
    }
    if (isThanks(message)) {
        return {
            text: lang === 'it'
                ? "Prego. Possiamo continuare da qui oppure passare a un'altra idea."
                : 'You are welcome. We can continue from here or move to another idea.',
            context: [],
            useModel: false
        };
    }
    if (/\b(cosa significa|cos e|differenza tra|what is|difference between)\b/.test(normalized) && /\b(free|gratis|gratuito|freemium|paid|pagamento)\b/.test(normalized)) {
        const text = lang === 'it'
            ? '**Free** e gratuito; **freemium** offre una base gratis con funzioni a pagamento; **paid** richiede un pagamento.'
            : '**Free** costs nothing; **freemium** has a free tier with paid features; **paid** requires payment.';
        return { text, context: [], useModel: false };
    }
    if (/\b(alternative|alternativa|alternative a|simili a|similar to|alternatives to|sostituti)\b/.test(normalized) && referenced[0]) {
        const alternatives = alternativeTools(referenced[0], tools, lang);
        if (alternatives.length) {
            return {
                text: formatToolList(
                    lang === 'it' ? `Alternative a ${referenced[0].name}:` : `Alternatives to ${referenced[0].name}:`,
                    alternatives,
                    lang
                ),
                context: alternatives,
                useModel: false
            };
        }
    }
    if (isToolComparisonRequest(message)) {
        if (referenced.length >= 2) {
            const compared = referenced.slice(0, 2);
            chat.pendingComparisonTool = null;
            return {
                text: formatToolComparison(compared[0], compared[1], lang),
                context: compared,
                useModel: false
            };
        }
        if (referenced.length === 1) {
            chat.pendingComparisonTool = referenced[0].tool;
            return {
                text: lang === 'it'
                    ? `Hai indicato **${referenced[0].name}**. Qual è il secondo strumento da confrontare?`
                    : `You named **${referenced[0].name}**. Which second tool should I compare it with?`,
                context: referenced,
                useModel: false
            };
        }
        if (ranked.length >= 2) {
            const compared = ranked.slice(0, 2);
            chat.pendingComparisonTool = null;
            return {
                text: formatToolComparison(compared[0], compared[1], lang),
                context: compared,
                useModel: false
            };
        }
        return {
            text: lang === 'it'
                ? 'Indicami i nomi di due strumenti del catalogo da confrontare.'
                : 'Tell me the names of two catalog tools to compare.',
            context: [],
            useModel: false
        };
    }

    const exact = findExactRequest(message, tools, lang);
    if (exact) {
        return {
            text: formatToolList(lang === 'it' ? `Ecco ${exact.name}:` : `Here is ${exact.name}:`, [exact], lang, true),
            context: [exact],
            useModel: false
        };
    }

    const similar = findSimilarName(message, tools, lang);
    if (similar && normalized.split(' ').length <= 6) {
        chat.pendingTool = similar.tool;
        return {
            text: lang === 'it' ? `Intendi **${similar.name}**?` : `Do you mean **${similar.name}**?`,
            context: [similar],
            useModel: false
        };
    }
    if (isVague(message)) {
        return {
            text: lang === 'it'
                ? 'Certo. Raccontami cosa vuoi ottenere, anche in modo semplice: ti farò le domande necessarie e, se utile, ti proporrò gli strumenti adatti.'
                : 'Of course. Tell me what you want to achieve, even in simple terms: I will ask what is needed and suggest suitable tools when useful.',
            context: [],
            useModel: false
        };
    }
    if (ranked.length) {
        const requestedPricing = detectPricing(message);
        return {
            text: formatToolList(
                lang === 'it' ? 'Questi strumenti sono i piu pertinenti:' : 'These are the most relevant tools:',
                ranked,
                lang,
                Boolean(requestedPricing)
            ),
            context: ranked,
            useModel: false
        };
    }
    return {
        kind: CONVERSATION_MODE,
        text: conversationFallback(lang),
        context: [],
        useModel: true
    };
};

const directPromptInstruction = (message, lang) => {
    let text = String(message).replace(/\s+/g, ' ').trim();
    if (lang === 'it') {
        text = text
            .replace(/^(?:ciao[,!.]?\s*)?(?:per favore[, ]*|gentilmente[, ]*)/i, '')
            .replace(/^(?:mi\s+)?(?:puoi|potresti|riesci a)\s+/i, '')
            .replace(/^(?:vorrei|mi serve|ho bisogno di)\s+/i, 'Crea ')
            .replace(/^scrivermi\s+/i, 'Scrivi ')
            .replace(/^crearmi\s+/i, 'Crea ')
            .replace(/^consigliarmi\s+/i, 'Consiglia ');
    } else {
        text = text
            .replace(/^(?:hello[,!.]?\s*)?(?:please[, ]*|kindly[, ]*)/i, '')
            .replace(/^(?:can|could|would) you\s+/i, '')
            .replace(/^(?:i want|i would like|i need)\s+/i, 'Create ');
    }
    text = text.replace(/[?.!]+$/, '').trim();
    if (!text) return String(message).trim();
    return `${text.charAt(0).toLocaleUpperCase(lang) + text.slice(1)}.`;
};

const promptRewriteKind = message => {
    const normalized = normalizeText(message);
    if (/\b(lettera|letter)\b/.test(normalized) && /\b(babbo natale|santa claus|father christmas)\b/.test(normalized)) return 'santa-letter';
    if (/\b(lettera|letter)\b/.test(normalized)) return 'letter';
    if (/\b(email|e mail|mail)\b/.test(normalized)) return 'email';
    if (/\b(codice|script|programma|software|app|sito|code|developer|website)\b/.test(normalized)) return 'code';
    if (/\b(immagine|foto|logo|grafica|image|photo|visual)\b/.test(normalized)) return 'image';
    if (/\b(post|social|linkedin|instagram|facebook|campagna|pubblicita|copy)\b/.test(normalized)) return 'social';
    if (/\b(presentazione|slide|slides|powerpoint|pitch deck)\b/.test(normalized)) return 'presentation';
    if (/\b(analisi|report|ricerca|dati|analysis|research|data)\b/.test(normalized)) return 'analysis';
    return 'generic';
};

const inferPromptRole = (message, lang, kind = promptRewriteKind(message)) => {
    const normalized = normalizeText(message);
    const role = kind === 'santa-letter'
        ? (lang === 'it' ? 'scrittore creativo specializzato in lettere natalizie personali e coinvolgenti' : 'creative writer specializing in personal and engaging Christmas letters')
        : kind === 'letter'
            ? (lang === 'it' ? 'autore esperto di corrispondenza personale' : 'writer specializing in personal correspondence')
            : /\b(codice|script|programma|software|app|sito|code|developer|website)\b/.test(normalized)
        ? (lang === 'it' ? 'ingegnere software senior' : 'senior software engineer')
        : /\b(email|e mail|mail|comunicato|lettera)\b/.test(normalized)
            ? (lang === 'it' ? 'specialista della comunicazione professionale' : 'professional communications specialist')
            : /\b(immagine|foto|logo|grafica|image|photo|visual)\b/.test(normalized)
                ? (lang === 'it' ? 'direttore creativo e visual designer' : 'creative director and visual designer')
                : /\b(marketing|post|social|campagna|pubblicita|copy)\b/.test(normalized)
                    ? (lang === 'it' ? 'stratega di marketing e copywriter senior' : 'marketing strategist and senior copywriter')
                    : /\b(analisi|report|ricerca|dati|analysis|research|data)\b/.test(normalized)
                        ? (lang === 'it' ? 'analista e ricercatore esperto' : 'expert analyst and researcher')
                        : (lang === 'it' ? 'esperto della materia e autore professionale' : 'subject-matter expert and professional writer');
    return lang === 'it' ? `Agisci come ${role}.` : `Act as a ${role}.`;
};

const inferPromptAudience = (message, lang, kind = promptRewriteKind(message)) => {
    if (kind === 'santa-letter') {
        return lang === 'it'
            ? 'Il destinatario e Babbo Natale. Scrivi dalla prospettiva del mittente e adatta lessico, spontaneita e profondita alla sua eta, usando segnaposto quando questi dati non sono disponibili.'
            : 'The recipient is Santa Claus. Write from the sender\'s perspective and adapt vocabulary, spontaneity, and depth to their age, using placeholders when those details are unavailable.';
    }
    if (kind === 'letter') {
        return lang === 'it'
            ? 'Rivolgiti direttamente al destinatario indicato o implicito nella richiesta, adattando il linguaggio al rapporto con il mittente senza inventare informazioni personali.'
            : 'Address the recipient stated or implied in the request directly, adapting the language to their relationship with the sender without inventing personal information.';
    }
    const normalized = normalizeText(message);
    const audience = /\b(team|colleghi|coworkers)\b/.test(normalized)
        ? (lang === 'it' ? 'il team e i colleghi coinvolti' : 'the team and involved colleagues')
        : /\b(clienti|cliente|customers|customer|clients|client)\b/.test(normalized)
            ? (lang === 'it' ? 'clienti attuali o potenziali' : 'current or prospective customers')
            : /\b(studenti|studentesse|students|student)\b/.test(normalized)
                ? (lang === 'it' ? 'studenti interessati all\'argomento' : 'students interested in the subject')
                : /\b(bambini|ragazzi|children|kids|teenagers)\b/.test(normalized)
                    ? (lang === 'it' ? 'un pubblico giovane' : 'a young audience')
                    : /\b(esperti|professionisti|experts|professionals)\b/.test(normalized)
                        ? (lang === 'it' ? 'professionisti con conoscenze del settore' : 'professionals with domain knowledge')
                        : (lang === 'it' ? 'un pubblico generalista interessato all\'argomento' : 'a general audience interested in the subject');
    return lang === 'it'
        ? `Rivolgiti a ${audience}, adattando terminologia e livello di dettaglio.`
        : `Address ${audience}, adapting terminology and level of detail.`;
};

const inferPromptTone = (message, lang, kind = promptRewriteKind(message)) => {
    const normalized = normalizeText(message);
    const knownTones = lang === 'it'
        ? ['professionale', 'formale', 'informale', 'amichevole', 'persuasivo', 'empatico', 'tecnico', 'autorevole', 'ironico', 'conciso']
        : ['professional', 'formal', 'informal', 'friendly', 'persuasive', 'empathetic', 'technical', 'authoritative', 'ironic', 'concise'];
    const requested = knownTones.find(tone => new RegExp(`\\b${tone}\\b`).test(normalized));
    if (kind === 'santa-letter') {
        return lang === 'it'
            ? 'Usa un tono caldo, sincero, affettuoso e festoso, con un senso di meraviglia naturale e senza risultare artificiale o eccessivamente formale.'
            : 'Use a warm, sincere, affectionate, and festive tone, with a natural sense of wonder and no artificial or overly formal language.';
    }
    if (kind === 'letter' && !requested) {
        return lang === 'it'
            ? 'Usa un tono personale, naturale e sincero, coerente con il rapporto tra mittente e destinatario.'
            : 'Use a personal, natural, and sincere tone consistent with the relationship between sender and recipient.';
    }
    if (lang === 'it') return `Usa un tono ${requested || 'professionale, chiaro e diretto'}, coerente con il pubblico e con l'obiettivo.`;
    return `Use a ${requested || 'professional, clear, and direct'} tone consistent with the audience and objective.`;
};

const promptOutputInstruction = (message, lang, kind = promptRewriteKind(message)) => {
    if (kind === 'santa-letter') {
        return lang === 'it'
            ? 'Produci una lettera personale completa e pronta da consegnare, con saluto a Babbo Natale, breve presentazione del mittente, pensiero sull\'anno trascorso, desideri, ringraziamento, augurio finale e firma.'
            : 'Produce a complete personal letter ready to deliver, with a greeting to Santa, a short introduction of the sender, a reflection on the past year, wishes, thanks, a closing holiday greeting, and signature.';
    }
    if (kind === 'letter') {
        return lang === 'it'
            ? 'Produci una lettera completa e pronta all\'uso, con apertura, corpo organizzato in paragrafi, chiusura coerente e firma o segnaposto per il mittente.'
            : 'Produce a complete ready-to-use letter with an opening, a body organized into paragraphs, a suitable closing, and a signature or sender placeholder.';
    }
    const normalized = normalizeText(message);
    if (/\b(email|e mail|mail)\b/.test(normalized)) {
        return lang === 'it' ? "Restituisci oggetto e corpo dell'email, pronti per l'invio." : 'Return the subject and email body, ready to send.';
    }
    if (/\b(codice|script|programma|code)\b/.test(normalized)) {
        return lang === 'it' ? 'Restituisci codice completo e pronto da eseguire, seguito solo dalle istruzioni indispensabili.' : 'Return complete runnable code followed only by essential usage instructions.';
    }
    if (/\b(immagine|foto|image|photo)\b/.test(normalized)) {
        return lang === 'it' ? 'Restituisci un unico prompt visivo dettagliato, senza spiegazioni introduttive.' : 'Return one detailed visual prompt without introductory commentary.';
    }
    if (/\b(post|social|linkedin|instagram|facebook)\b/.test(normalized)) {
        return lang === 'it' ? 'Restituisci il testo finale del post, pronto da pubblicare.' : 'Return the final post copy, ready to publish.';
    }
    return lang === 'it'
        ? 'Restituisci direttamente un risultato completo, chiaro e utilizzabile.'
        : 'Return a complete, clear, ready-to-use result directly.';
};

const inferPromptObjective = (message, lang, kind = promptRewriteKind(message)) => {
    if (kind === 'santa-letter') {
        return lang === 'it'
            ? 'Scrivi una lettera a Babbo Natale che esprima in modo autentico i desideri del mittente, racconti brevemente qualcosa di significativo dell\'anno e comunichi gratitudine, entusiasmo e spirito natalizio.'
            : 'Write a letter to Santa that authentically expresses the sender\'s wishes, briefly shares something meaningful about the past year, and conveys gratitude, excitement, and Christmas spirit.';
    }
    if (kind === 'letter') {
        return lang === 'it'
            ? `${directPromptInstruction(message, lang)} Sviluppa il messaggio in modo completo, facendo emergere con chiarezza lo scopo della lettera e la risposta desiderata dal destinatario.`
            : `${directPromptInstruction(message, lang)} Develop the message fully, making the letter's purpose and the desired response from the recipient clear.`;
    }
    return directPromptInstruction(message, lang);
};

const inferPromptConstraints = (lang, kind) => {
    if (kind === 'santa-letter') {
        return lang === 'it'
            ? 'Non inventare nome, eta, comportamenti o desideri del mittente. Quando mancano, usa i segnaposto [NOME], [ETA], [EPISODIO DELL\'ANNO] e [DESIDERI]. Mantieni la lettera scorrevole, senza spiegazioni, note redazionali o domande di follow-up.'
            : 'Do not invent the sender\'s name, age, behavior, or wishes. When missing, use [NAME], [AGE], [MOMENT FROM THE YEAR], and [WISHES]. Keep the letter flowing, with no explanations, editorial notes, or follow-up questions.';
    }
    if (kind === 'letter') {
        return lang === 'it'
            ? 'Mantieni tutti i dettagli forniti e non inventare dati personali. Usa segnaposto chiari per le informazioni indispensabili mancanti. Restituisci solo la lettera finale, senza spiegazioni o domande di follow-up.'
            : 'Preserve all supplied details and do not invent personal information. Use clear placeholders for essential missing details. Return only the final letter, with no explanations or follow-up questions.';
    }
    return lang === 'it'
        ? 'Mantieni tutti i nomi, i dati e i requisiti espliciti. Non inventare fatti. Non fare domande di follow-up. Fornisci esclusivamente il risultato richiesto, completo e utilizzabile.'
        : 'Preserve every explicit name, fact, and requirement. Do not invent facts. Do not ask follow-up questions. Return only the requested result in a complete, ready-to-use form.';
};

const inferPromptReferences = (message, lang, kind = promptRewriteKind(message)) => {
    if (kind === 'santa-letter') {
        return lang === 'it'
            ? 'Usa come riferimenti l\'atmosfera del Natale, il rapporto immaginario e affettuoso con Babbo Natale e tutti i dettagli eventualmente forniti dal mittente. Integra i segnaposto in modo naturale quando il prompt originale non contiene esempi o informazioni personali.'
            : 'Use the Christmas atmosphere, the affectionate imaginary relationship with Santa, and all details supplied by the sender as references. Integrate placeholders naturally when the original prompt contains no examples or personal information.';
    }
    if (kind === 'letter') {
        return lang === 'it'
            ? 'Usa il contesto, il rapporto tra mittente e destinatario e gli eventuali esempi presenti nella richiesta. Se questi elementi non sono specificati, mantieni formulazioni adattabili tramite segnaposto.'
            : 'Use the context, the relationship between sender and recipient, and any examples in the request. If these elements are unspecified, keep the wording adaptable through placeholders.';
    }
    return lang === 'it'
        ? 'Usa tutto il contesto e gli eventuali esempi presenti nella richiesta come riferimento. Se manca un dato indispensabile, inserisci un segnaposto chiaro senza aggiungere informazioni non verificate.'
        : 'Use all context and examples in the request as references. If essential information is missing, insert a clear placeholder without adding unverified information.';
};

const buildPromptRewriteDraft = (message, lang) => {
    const kind = promptRewriteKind(message);
    const objective = inferPromptObjective(message, lang, kind);
    const output = promptOutputInstruction(message, lang, kind);
    if (lang === 'it') {
        return [
            '1. RUOLO',
            inferPromptRole(message, lang, kind),
            '',
            '2. PUBBLICO',
            inferPromptAudience(message, lang, kind),
            '',
            '3. TIPO DI CONTENUTO',
            output,
            '',
            '4. OBIETTIVO',
            objective,
            '',
            '5. TONO',
            inferPromptTone(message, lang, kind),
            '',
            '6. VINCOLI',
            inferPromptConstraints(lang, kind),
            '',
            '7. RIFERIMENTI',
            inferPromptReferences(message, lang, kind)
        ].join('\n');
    }
    return [
        '1. ROLE',
        inferPromptRole(message, lang, kind),
        '',
        '2. AUDIENCE',
        inferPromptAudience(message, lang, kind),
        '',
        '3. CONTENT TYPE',
        output,
        '',
        '4. OBJECTIVE',
        objective,
        '',
        '5. TONE',
        inferPromptTone(message, lang, kind),
        '',
        '6. CONSTRAINTS',
        inferPromptConstraints(lang, kind),
        '',
        '7. REFERENCES',
        inferPromptReferences(message, lang, kind)
    ].join('\n');
};

const createPromptRewritePlan = (chat, message) => {
    if (message.length > MAX_PROMPT_LENGTH) {
        return {
            text: chat.lang === 'it'
                ? `Il prompt supera ${MAX_PROMPT_LENGTH} caratteri. Riducilo e riprova.`
                : `The prompt exceeds ${MAX_PROMPT_LENGTH} characters. Shorten it and try again.`,
            context: [],
            kind: 'validation',
            useModel: false
        };
    }
    return {
        text: buildPromptRewriteDraft(message, chat.lang),
        context: [],
        kind: PROMPT_REWRITE_MODE,
        useModel: true
    };
};

const looksLikeFileRequest = message => {
    const normalized = normalizeText(message);
    const action = /\b(crea|creare|creami|genera|generare|generami|prepara|preparare|produci|esporta|salva|scrivi|redigi|compila|create|generate|make|prepare|produce|export|save|write)\b/.test(normalized);
    const file = /\b(file|documento|document|report|relazione|lettera|memo|word|doc|docx|pdf|testo|txt|markdown|md|html|pagina web|csv|excel|xlsx|foglio|spreadsheet|json)\b/.test(normalized);
    return action && file;
};

const detectFileType = message => {
    const normalized = normalizeText(message);
    if (/\b(xlsx|excel|spreadsheet|foglio excel|foglio di calcolo)\b/.test(normalized)) return 'xlsx';
    if (/\bcsv\b/.test(normalized)) return 'csv';
    if (/\bhtml\b|\bpagina web\b/.test(normalized)) return 'html';
    if (/\bjson\b/.test(normalized)) return 'json';
    if (/\b(markdown|md)\b/.test(normalized)) return 'md';
    if (/\bpdf\b/.test(normalized)) return 'pdf';
    if (/\b(word|doc|docx)\b/.test(normalized)) return 'doc';
    if (/\b(testo|txt|plain text)\b/.test(normalized)) return 'txt';
    return 'md';
};

const fileLabels = Object.freeze({
    txt: 'TXT',
    md: 'Markdown',
    html: 'HTML',
    csv: 'CSV',
    json: 'JSON',
    doc: 'Word',
    pdf: 'PDF',
    xlsx: 'Excel'
});

const fileTitle = message => {
    const cleaned = String(message)
        .replace(/\b(crea|creare|creami|genera|generare|generami|prepara|preparare|produci|esporta|salva|scrivi|redigi|compila|create|generate|make|prepare|produce|export|save|write)\b/gi, ' ')
        .replace(/\b(file|documento|document|word|doc|docx|pdf|testo|txt|markdown|md|html|csv|excel|xlsx|spreadsheet|json)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return shorten(cleaned || 'Koda document', 72).replace(/[.!?]+$/, '');
};

const artifactFileName = (message, type) => {
    const stem = fileTitle(message)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 44) || 'koda-document';
    return `${stem}.${type}`;
};

const csvCell = value => `"${String(value).replace(/"/g, '""')}"`;

const buildFileFallback = (message, type, lang) => {
    const title = fileTitle(message);
    if (type === 'html') {
        return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.replace(/[<>&"]/g, '')}</title>
  <style>body{max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.6 Arial,sans-serif;color:#202124}h1{line-height:1.2;color:#146c35}.brief{padding:16px;border-left:4px solid #1db954;background:#f3f7f4}</style>
</head>
<body>
  <main>
    <h1>${title.replace(/[<>&]/g, '')}</h1>
    <p class="brief">${String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
  </main>
</body>
</html>`;
    }
    if (type === 'json') {
        return JSON.stringify({ title, request: message, generatedBy: 'Koda AI' }, null, 2);
    }
    if (type === 'csv' || type === 'xlsx') {
        const headings = lang === 'it' ? 'campo,valore' : 'field,value';
        const request = lang === 'it' ? 'richiesta' : 'request';
        return `${headings}\n${request},${csvCell(message)}`;
    }
    if (type === 'txt') return `${title}\n\n${message}`;
    const requestHeading = lang === 'it' ? 'Richiesta' : 'Request';
    return `# ${title}\n\n## ${requestHeading}\n\n${message}`;
};

const isConversationExportRequest = message => /\b(conversazione|questa chat|nostra chat|cronologia(?: della chat)?|conversation|this chat|our chat|chat history)\b/.test(normalizeText(message));

const buildConversationExport = (chat, lang) => {
    const messages = chat.history
        .filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string' && item.content.trim())
        .slice(-MAX_SESSION_HISTORY_MESSAGES);
    const title = lang === 'it' ? 'Conversazione con Koda AI' : 'Conversation with Koda AI';
    if (!messages.length) {
        return `# ${title}\n\n${lang === 'it' ? 'La conversazione non contiene ancora messaggi da esportare.' : 'The conversation does not contain any messages to export yet.'}`;
    }
    const userLabel = lang === 'it' ? 'Utente' : 'User';
    const assistantLabel = 'Koda AI';
    return [
        `# ${title}`,
        '',
        ...messages.flatMap(item => [
            `## ${item.role === 'user' ? userLabel : assistantLabel}`,
            '',
            item.content.trim(),
            ''
        ])
    ].join('\n').trim();
};

const createFileGenerationPlan = (chat, message) => {
    const type = detectFileType(message);
    const conversationExport = isConversationExportRequest(message);
    return {
        text: conversationExport ? buildConversationExport(chat, chat.lang) : buildFileFallback(message, type, chat.lang),
        context: [],
        kind: FILE_GENERATION_MODE,
        file: {
            type,
            label: fileLabels[type],
            name: conversationExport ? `conversazione-koda.${type}` : artifactFileName(message, type)
        },
        directExport: conversationExport,
        useModel: !conversationExport
    };
};

const stripGeneratedFileContent = value => {
    const text = String(value || '').trim()
        .replace(/<\|(?:system|assistant|user|endoftext)\|>/gi, '')
        .trim();
    const fenced = text.match(/^```[^\n]*\n([\s\S]*?)```\s*$/);
    return (fenced ? fenced[1] : text.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '')).trim();
};

const validateFileContent = (content, plan) => {
    const text = String(content || '').trim();
    if (text.length < 12 || text.length > MAX_ARTIFACT_CONTENT || /<\|(?:system|assistant|user)\|>/i.test(text)) return false;
    if (plan.file.type === 'html') return /<!doctype html>|<html[\s>]/i.test(text) && /<\/html>/i.test(text);
    if (plan.file.type === 'json') {
        try {
            JSON.parse(text);
            return true;
        } catch (error) {
            return false;
        }
    }
    if (plan.file.type === 'csv' || plan.file.type === 'xlsx') {
        const lines = text.split(/\r?\n/).filter(Boolean);
        return lines.length >= 2 && /[,;\t]/.test(lines[0]);
    }
    return true;
};

const fileConfirmation = (plan, lang, usedModel) => lang === 'it'
    ? `${usedModel || plan.directExport ? 'Ho creato' : 'Ho preparato una bozza di'} **${plan.file.name}**. Puoi scaricarlo o aprire l'anteprima qui sotto.`
    : `${usedModel || plan.directExport ? 'I created' : 'I prepared a draft of'} **${plan.file.name}**. You can download it or open the preview below.`;

const contextForPrompt = (context, lang) => context.map(item => [
    `Name: ${item.name}`,
    `Description: ${toolDescription(item, lang)}`,
    item.category ? `Category: ${item.category}` : '',
    item.pricing ? `Pricing: ${item.pricing}` : ''
].filter(Boolean).join(' | ')).join('\n');

const buildModelMessages = (chat, message, plan) => {
    const outputLanguage = chat.lang === 'it' ? 'Italian' : 'English';
    if (plan.kind === PROMPT_REWRITE_MODE) {
        const headings = chat.lang === 'it'
            ? '1. RUOLO; 2. PUBBLICO; 3. TIPO DI CONTENUTO; 4. OBIETTIVO; 5. TONO; 6. VINCOLI; 7. RIFERIMENTI'
            : '1. ROLE; 2. AUDIENCE; 3. CONTENT TYPE; 4. OBJECTIVE; 5. TONE; 6. CONSTRAINTS; 7. REFERENCES';
        const system = [
            'You are an expert prompt engineer.',
            'Analyze the request internally, then replace it with a highly optimized professional prompt; never perform the requested task.',
            `Return only the optimized prompt in ${outputLanguage}.`,
            `Use exactly these seven numbered headings, in this order, each as a separate paragraph: ${headings}.`,
            'Each section must contain concrete downstream instructions for the role, target audience, content type and format, objective, tone, constraints, and relevant context or examples.',
            'Preserve all explicit facts and intent. Infer missing details conservatively without asking follow-up questions or requesting advice.',
            'Do not include analysis, explanations, prefaces, conclusions, or anything before section 1 or after section 7.'
        ].join(' ');
        return [
            { role: 'system', content: system },
            {
                role: 'user',
                content: `RAW REQUEST:\n${message}\n\nCONTENT-SPECIFIC DRAFT:\n${plan.text}\n\nImprove this draft without removing its concrete details.`
            }
        ];
    }
    if (plan.kind === FILE_GENERATION_MODE) {
        const formatRules = {
            html: 'Return one complete HTML5 document with inline CSS, no scripts, no external assets, and all tags closed.',
            json: 'Return strictly valid JSON.',
            csv: 'Return valid comma-separated rows. The first row must contain column names.',
            xlsx: 'Return valid comma-separated rows. The first row must contain column names; this text will be converted to XLSX.',
            doc: 'Return well-structured Markdown that will be converted to a Word-compatible document.',
            pdf: 'Return well-structured Markdown that will be converted to PDF.',
            md: 'Return well-structured Markdown.',
            txt: 'Return plain text.'
        };
        const system = [
            'You generate the complete body of a downloadable file.',
            `Write in ${outputLanguage}.`,
            formatRules[plan.file.type],
            'Return only the file content without a Markdown code fence or commentary.',
            'Follow the user brief exactly and do not invent facts.',
            'The verified draft is a minimal safe fallback; replace it with a more useful complete result when possible.'
        ].join(' ');
        return [
            { role: 'system', content: system },
            {
                role: 'user',
                content: `USER BRIEF:\n${message}\n\nVERIFIED DRAFT:\n${plan.text}`
            }
        ];
    }
    if (plan.kind === CONVERSATION_MODE) {
        const recentHistory = chat.history.slice(-MAX_HISTORY_MESSAGES)
            .filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string')
            .map(item => ({ role: item.role, content: item.content.slice(0, 1200) }));
        const system = [
            'You are Koda, a helpful conversational assistant running locally in the browser.',
            `Reply only in ${outputLanguage}.`,
            'Answer the actual question directly and naturally, using recent messages to understand references and follow-up questions.',
            'You can explain, brainstorm, help write short content, and help the user clarify a goal.',
            'Keep the answer concise unless the user asks for detail.',
            'Do not claim to browse the web or know live information.',
            'Never invent AI tool names, features, prices, or URLs. Discuss a named tool only when it already appears in the conversation.'
        ].join(' ');
        return [
            { role: 'system', content: system },
            ...recentHistory,
            { role: 'user', content: message }
        ];
    }
    const records = contextForPrompt(plan.context, chat.lang) || 'No matching database records.';
    const system = [
        'You are Koda, a concise assistant for discovering AI tools.',
        `Reply only in ${outputLanguage}, using at most two short sentences before any tool list.`,
        'Use only the verified database records supplied by the user message.',
        'Never invent a tool, feature, price, URL, or comparison.',
        'Keep every tool name exactly as written. Use bullet lines in the form: \u2022 **Exact Name**: description.',
        'The verified draft is factually correct. Improve its wording only; do not add facts.'
    ].join(' ');
    return [
        { role: 'system', content: system },
        {
            role: 'user',
            content: `CATALOG DATA:\n${records}\n\nQUESTION:\n${message}`
        }
    ];
};

const validateModelAnswer = (answer, plan, allTools, lang) => {
    const text = String(answer || '').trim();
    if (text.length < 5 || text.length > 1200 || /<\/?(system|assistant|user)>/i.test(text) || MODEL_PROMPT_LEAKAGE.test(text)) return false;

    const allowedTools = plan.context.length ? plan.context : allTools.map(tool => getToolFields(tool, lang));
    const knownNames = new Set(allowedTools.map(tool => tool.nameNorm));
    const bulletNames = [...text.matchAll(/^[\u2022*-]\s+\*\*([^*]+)\*\*/gm)].map(match => normalizeText(match[1]));
    if (bulletNames.some(name => !knownNames.has(name))) return false;

    if (plan.context.length && plan.text.includes('\u2022')) {
        if (!text.includes('\u2022')) return false;
        const includesKnownContext = plan.context.some(item => normalizeText(text).includes(item.nameNorm));
        if (!includesKnownContext) return false;
    }

    if (lang === 'it') {
        const normalized = normalizeText(text);
        const italianMarker = /\b(ecco|per|puoi|strumento|strumenti|gratuito|pagamento|confronto|scelta|creare|offre|consiglio)\b/.test(normalized);
        const englishMarker = /\b(here are|you can|tools are|best for|choose this|the tool)\b/.test(normalized);
        if (englishMarker && !italianMarker) return false;
    }
    return true;
};

const validatePromptRewrite = (answer, source, draft, lang) => {
    const text = String(answer || '').trim();
    if (text.length < 40 || text.length > 5000 || /<\/?(system|assistant|user)>/i.test(text) || MODEL_PROMPT_LEAKAGE.test(text)) return false;

    const normalizedAnswer = normalizeText(text);
    if (normalizedAnswer === normalizeText(source)) return false;

    if (promptRewriteKind(source) === 'santa-letter') {
        const requiredConcepts = [
            /\b(saluto|apertura|greeting|opening)\b/,
            /\b(mittente|sender)\b/,
            /\b(anno|year)\b/,
            /\b(desideri|wishes)\b/,
            /\b(ringraziamento|gratitudine|grazie|thanks|gratitude)\b/,
            /\b(firma|chiusura|signature|closing)\b/,
            /\b(natalizio|natale|christmas|festoso|festive|meraviglia|wonder|affettuoso|warm)\b/
        ];
        const placeholderPatterns = [
            /\[(?:nome|name)\]/i,
            /\[(?:eta|age)\]/i,
            /\[(?:episodio dell'anno|moment from the year)\]/i,
            /\[(?:desideri|wishes)\]/i
        ];
        const preservedConcepts = requiredConcepts.filter(pattern => pattern.test(normalizedAnswer)).length;
        const preservedPlaceholders = placeholderPatterns.filter(pattern => pattern.test(text)).length;
        if (!/\b(babbo natale|santa claus|father christmas)\b/.test(normalizedAnswer)
            || !/\b(lettera|letter)\b/.test(normalizedAnswer)
            || preservedConcepts < 5
            || preservedPlaceholders < 3) return false;
    }

    const labels = lang === 'en'
        ? ['role', 'audience', 'content type', 'objective', 'tone', 'constraints', 'references']
        : ['ruolo', 'pubblico', 'tipo di contenuto', 'obiettivo', 'tono', 'vincoli', 'riferimenti'];
    const lines = text.split(/\r?\n/).map(line => normalizeText(line)).filter(Boolean);
    let previousHeading = -1;
    const hasOrderedHeadings = labels.every((label, index) => {
        const heading = lines.findIndex((line, lineIndex) => lineIndex > previousHeading && line.startsWith(`${index + 1} ${label}`));
        if (heading < 0) return false;
        previousHeading = heading;
        return true;
    });
    if (!hasOrderedHeadings || !lines[0].startsWith(`1 ${labels[0]}`) || text.split(/\n\s*\n/).filter(Boolean).length < 7) return false;

    const sourceTerms = [...new Set(normalizeText(source).split(/\s+/)
        .filter(term => term.length >= 4 && !stopWords.has(term)))];
    if (!sourceTerms.length) return true;

    const preservedTerms = sourceTerms.filter(term => normalizedAnswer.includes(term));
    const minimumPreserved = Math.max(1, Math.ceil(sourceTerms.length * 0.5));
    if (preservedTerms.length < minimumPreserved) return false;

    const draftTerms = [...new Set(normalizeText(draft).split(/\s+/)
        .filter(term => term.length >= 5 && !stopWords.has(term)))];
    const preservedDraftTerms = draftTerms.filter(term => normalizedAnswer.includes(term));
    return preservedDraftTerms.length >= Math.max(3, Math.ceil(draftTerms.length * 0.35));
};

const sessionTools = chat => {
    if (Array.isArray(chat.tools) && chat.tools.length) return chat.tools;
    if (typeof window !== 'undefined' && typeof window.getAllToolsForCurrentUser === 'function') {
        return window.getAllToolsForCurrentUser();
    }
    return [];
};

const restoreChatHistory = messages => (Array.isArray(messages) ? messages : [])
    .map(item => {
        const role = item?.role === 'user' || item?.sender === 'user'
            ? 'user'
            : item?.role === 'assistant' || item?.sender === 'model'
                ? 'assistant'
                : null;
        const content = typeof item?.content === 'string' ? item.content : typeof item?.text === 'string' ? item.text : '';
        return role && content.trim() ? { role, content: content.trim() } : null;
    })
    .filter(Boolean)
    .slice(-MAX_SESSION_HISTORY_MESSAGES);

export const createLocalChatSession = (lang, tools = [], mode = 'catalog', messages = []) => ({
    lang: lang === 'en' ? 'en' : 'it',
    tools: Array.isArray(tools) ? tools : [],
    mode: mode === PROMPT_REWRITE_MODE ? PROMPT_REWRITE_MODE : 'catalog',
    history: restoreChatHistory(messages),
    pendingTool: null,
    pendingComparisonTool: null,
    responseMetadata: null
});

export const takeLocalResponseMetadata = chat => {
    const metadata = chat?.responseMetadata || { sources: [], artifacts: [] };
    if (chat) chat.responseMetadata = null;
    return metadata;
};

export async function* sendLocalMessageStream(chat, message) {
    if (!chat || typeof message !== 'string' || !message.trim()) {
        throw new Error('INVALID_LOCAL_CHAT_REQUEST');
    }

    const tools = sessionTools(chat);
    const cleanMessage = message.trim();
    const responseLanguage = detectResponseLanguage(cleanMessage, chat.lang);
    const responseChat = responseLanguage === chat.lang ? chat : { ...chat, lang: responseLanguage };
    const promptRewrite = responseChat.mode === PROMPT_REWRITE_MODE;
    const fileRequest = !promptRewrite && looksLikeFileRequest(cleanMessage);

    const plan = promptRewrite
        ? createPromptRewritePlan(responseChat, cleanMessage)
        : fileRequest
            ? createFileGenerationPlan(responseChat, cleanMessage)
            : createResponsePlan(responseChat, cleanMessage, tools);
    chat.pendingTool = responseChat.pendingTool;
    chat.pendingComparisonTool = responseChat.pendingComparisonTool;

    chat.responseMetadata = {
        artifacts: []
    };

    let answer = plan.text;
    let usedModel = false;

    if (plan.useModel && hasLocalInference() && !workerUnavailable) {
        try {
            const fileGeneration = plan.kind === FILE_GENERATION_MODE;
            const promptOptimization = plan.kind === PROMPT_REWRITE_MODE;
            const generationOptions = fileGeneration
                ? { maxNewTokens: 480, idleTimeoutMs: FILE_MODEL_IDLE_TIMEOUT_MS }
                : promptOptimization
                    ? { maxNewTokens: 420 }
                    : undefined;
            const generated = await generateWithModel(buildModelMessages(responseChat, cleanMessage, plan), generationOptions);
            const candidate = fileGeneration ? stripGeneratedFileContent(generated) : generated.trim();
            const isValid = plan.kind === PROMPT_REWRITE_MODE
                ? validatePromptRewrite(candidate, cleanMessage, plan.text, responseChat.lang)
                : fileGeneration
                        ? validateFileContent(candidate, plan)
                        : validateModelAnswer(candidate, plan, tools, responseChat.lang);
            if (isValid) {
                answer = candidate;
                usedModel = true;
            }
        } catch (error) {
            updateStatus({ state: 'fallback', progress: null, reason: error instanceof Error ? error.message : String(error) });
        }
    } else if (plan.useModel && !hasLocalInference()) {
        updateStatus({ state: 'fallback', progress: null, supported: false, reason: 'LOCAL_INFERENCE_UNAVAILABLE' });
    }

    if (plan.kind === FILE_GENERATION_MODE) {
        const artifact = {
            id: `artifact-${Date.now()}`,
            name: plan.file.name,
            type: plan.file.type,
            content: String(answer).slice(0, MAX_ARTIFACT_CONTENT),
            createdAt: Date.now()
        };
        chat.responseMetadata.artifacts = [artifact];
        answer = fileConfirmation(plan, responseChat.lang, usedModel);
    }

    chat.history.push({ role: 'user', content: cleanMessage }, { role: 'assistant', content: answer });
    if (chat.history.length > MAX_SESSION_HISTORY_MESSAGES) {
        chat.history.splice(0, chat.history.length - MAX_SESSION_HISTORY_MESSAGES);
    }

    const chunkSize = 18;
    for (let index = 0; index < answer.length; index += chunkSize) {
        yield answer.slice(index, index + chunkSize);
        await new Promise(resolve => setTimeout(resolve, 8));
    }
}

export const localAI = Object.freeze({
    statusEvent: STATUS_EVENT,
    getStatus: () => ({ ...status }),
    preload: preloadLocalModel,
    takeResponseMetadata: takeLocalResponseMetadata,
    isModelSupported: hasLocalInference,
    promptRewriteMode: PROMPT_REWRITE_MODE,
    fileGenerationMode: FILE_GENERATION_MODE
});