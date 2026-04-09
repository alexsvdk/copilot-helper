/*---------------------------------------------------------------------------------------------
 *  Zed Handler
 *  Handles LLM token exchange, model listing, completions, and streaming for Zed cloud API.
 *  Supports anthropic, open_ai, google, and x_ai sub-providers.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Logger } from '../../utils';
import type {
    ZedAccount,
    ZedCloudProvider,
    ZedModelInfo,
    ZedModelCacheEntry,
    ZedTokenCacheEntry,
    ZedCompletionContentBlock,
    ZedCompletionResult,
} from './zedTypes';

// ─── Constants ───────────────────────────────────────────────────────────────

const ZED_DEFAULT_SERVER_URL = 'https://zed.dev';
const ZED_MODELS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ZED_LLM_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ZED_REQUEST_TIMEOUT_MS = 8_000;
const ZED_MODELS_TIMEOUT_MS = 8_000;
const ZED_COMPLETION_TIMEOUT_MS = 90_000;

// ─── Module-level caches ─────────────────────────────────────────────────────

const zedModelCache = new Map<string, ZedModelCacheEntry>();
const zedModelInFlight = new Map<string, Promise<ZedModelInfo[]>>();
const zedTokenCache = new Map<string, ZedTokenCacheEntry>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function accountKey(account: ZedAccount): string {
    return `${account.serverUrl || ZED_DEFAULT_SERVER_URL}:${account.id}`;
}

function cloudBase(serverUrl: string): string {
    if (serverUrl === 'https://zed.dev') { return 'https://cloud.zed.dev'; }
    if (serverUrl === 'https://staging.zed.dev') { return 'https://cloud.zed.dev'; }
    if (serverUrl === 'http://localhost:3000') { return 'http://localhost:8787'; }
    return serverUrl;
}

function cloudUrl(account: ZedAccount, path: string): string {
    return `${cloudBase(account.serverUrl || ZED_DEFAULT_SERVER_URL)}${path}`;
}

function authHeader(account: ZedAccount): string {
    return `${account.id} ${account.accessToken}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(`Zed request timed out after ${timeoutMs}ms: ${url}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function requestJson(
    url: string,
    init: RequestInit,
    timeoutMs = ZED_REQUEST_TIMEOUT_MS
): Promise<{ response: Response; text: string; data: unknown }> {
    const response = await fetchWithTimeout(url, init, timeoutMs);
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { response, text, data };
}

function maybeRefreshableToken(response: Response): boolean {
    return response.headers.has('x-zed-expired-token') || response.headers.has('x-zed-outdated-token');
}

function normalizeModels(models: ZedModelInfo[]): ZedModelInfo[] {
    const seen = new Map<string, ZedModelInfo>();
    for (const m of models || []) {
        const id = m?.id?.trim();
        if (!id || seen.has(id)) { continue; }
        seen.set(id, { ...m, id });
    }
    return Array.from(seen.values());
}

// ─── LLM Token exchange ───────────────────────────────────────────────────────

export async function getZedLlmToken(account: ZedAccount, forceRefresh = false): Promise<string> {
    const key = accountKey(account);
    const cached = zedTokenCache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < ZED_LLM_TOKEN_TTL_MS) {
        return cached.token;
    }

    const { response, text, data } = await requestJson(
        cloudUrl(account, '/client/llm_tokens'),
        {
            method: 'POST',
            headers: {
                Authorization: authHeader(account),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ organization_id: account.organizationId || undefined }),
        },
        ZED_REQUEST_TIMEOUT_MS
    );

    const d = data as { token?: string } | null;
    if (!response.ok || !d?.token) {
        throw new Error(`Zed LLM token request failed (${response.status}): ${text}`);
    }

    zedTokenCache.set(key, { fetchedAt: Date.now(), token: d.token });
    return d.token;
}

// ─── Models listing ───────────────────────────────────────────────────────────

export async function listZedModels(account: ZedAccount): Promise<ZedModelInfo[]> {
    const key = accountKey(account);
    const cached = zedModelCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < ZED_MODELS_TTL_MS) {
        return cached.models;
    }
    const inFlight = zedModelInFlight.get(key);
    if (inFlight) { return inFlight; }

    const task = (async () => {
        let llmToken = await getZedLlmToken(account);
        let refreshed = false;

        while (true) {
            const response = await fetchWithTimeout(
                cloudUrl(account, '/models'),
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${llmToken}`,
                        'x-zed-client-supports-x-ai': 'true',
                    },
                },
                ZED_MODELS_TIMEOUT_MS
            );
            const text = await response.text();

            if (response.ok) {
                let data: { models?: ZedModelInfo[] } | null = null;
                try { data = text ? JSON.parse(text) : null; } catch { data = null; }
                const models = normalizeModels(data?.models || []);
                zedModelCache.set(key, { fetchedAt: Date.now(), models });
                return models;
            }

            if (!refreshed && maybeRefreshableToken(response)) {
                llmToken = await getZedLlmToken(account, true);
                refreshed = true;
                continue;
            }

            throw new Error(`Zed models request failed (${response.status}): ${text}`);
        }
    })();

    zedModelInFlight.set(key, task);
    try {
        return await task;
    } finally {
        zedModelInFlight.delete(key);
    }
}

export function invalidateZedModelCache(account: ZedAccount): void {
    zedModelCache.delete(accountKey(account));
}

// ─── VS Code message → internal format ───────────────────────────────────────

interface InternalMessage {
    role: 'user' | 'assistant' | 'system';
    content: InternalContentPart[];
}

type InternalContentPart =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string };

function convertVsCodeMessages(messages: readonly vscode.LanguageModelChatMessage[]): InternalMessage[] {
    const result: InternalMessage[] = [];

    for (const msg of messages) {
        let role: 'user' | 'assistant' | 'system';
        if (msg.role === vscode.LanguageModelChatMessageRole.User) {
            role = 'user';
        } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
            role = 'assistant';
        } else {
            role = 'system';
        }

        const content: InternalContentPart[] = [];
        for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value) { content.push({ type: 'text', text: part.value }); }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                content.push({
                    type: 'tool_use',
                    id: part.callId,
                    name: part.name,
                    input: part.input,
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const textContent = part.content
                    .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
                    .map(p => p.value)
                    .join('\n');
                content.push({
                    type: 'tool_result',
                    tool_use_id: part.callId,
                    content: textContent,
                });
            }
        }

        if (content.length === 0) { continue; }

        // Merge consecutive messages with same role
        const last = result[result.length - 1];
        if (last && last.role === role) {
            last.content.push(...content);
        } else {
            result.push({ role, content });
        }
    }
    return result;
}

// ─── Request builders ─────────────────────────────────────────────────────────

function buildAnthropicRequest(
    model: ZedModelInfo,
    messages: InternalMessage[],
    tools: vscode.LanguageModelChatTool[],
    maxTokens?: number
): unknown {
    let system: string | undefined;
    const anthropicMessages: unknown[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            system = msg.content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
            continue;
        }
        const content = msg.content.map(p => {
            if (p.type === 'text') { return { type: 'text', text: p.text }; }
            if (p.type === 'tool_use') { return { type: 'tool_use', id: p.id, name: p.name, input: p.input }; }
            if (p.type === 'tool_result') { return { type: 'tool_result', tool_use_id: p.tool_use_id, content: p.content }; }
            return null;
        }).filter(Boolean);

        anthropicMessages.push({ role: msg.role, content });
    }

    const anthropicTools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: normalizeToolParameters(t.inputSchema),
    }));

    return {
        model: model.id,
        messages: anthropicMessages,
        system: system || undefined,
        max_tokens: maxTokens || model.max_output_tokens || 4096,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        tool_choice: anthropicTools.length > 0 ? { type: 'auto' } : undefined,
    };
}

function buildOpenAiChatRequest(
    model: ZedModelInfo,
    messages: InternalMessage[],
    tools: vscode.LanguageModelChatTool[],
    maxTokens?: number
): unknown {
    const openaiMessages = messages.map(msg => ({
        role: msg.role,
        content: msg.content.map(p => {
            if (p.type === 'text') { return p.text; }
            return '';
        }).join('\n'),
    }));

    const openaiTools = tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: normalizeToolParameters(t.inputSchema),
        },
    }));

    return {
        model: model.id,
        stream: true,
        max_tokens: maxTokens || undefined,
        temperature: 1,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        parallel_tool_calls: model.supports_parallel_tool_calls === true,
    };
}

function buildGoogleRequest(
    model: ZedModelInfo,
    messages: InternalMessage[],
    tools: vscode.LanguageModelChatTool[],
    maxTokens?: number
): unknown {
    const toolIdToName = new Map<string, string>();
    const contents = messages
        .filter(m => m.role !== 'system')
        .map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: msg.content.map(p => {
                if (p.type === 'text') { return { text: p.text }; }
                if (p.type === 'tool_use') {
                    toolIdToName.set(p.id, p.name);
                    return { functionCall: { id: p.id, name: p.name, args: p.input } };
                }
                if (p.type === 'tool_result') {
                    const name = toolIdToName.get(p.tool_use_id) || p.tool_use_id;
                    return { functionResponse: { name, response: { output: p.content } } };
                }
                return null;
            }).filter(Boolean),
        }));

    return {
        model: { model_id: model.id },
        contents,
        generation_config: {
            candidate_count: 1,
            max_output_tokens: maxTokens || model.max_output_tokens || undefined,
            temperature: 1,
        },
        tools: tools.length > 0
            ? [{
                function_declarations: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    parameters: normalizeToolParameters(t.inputSchema),
                })),
            }]
            : undefined,
    };
}

function buildProviderRequest(
    model: ZedModelInfo,
    messages: InternalMessage[],
    tools: vscode.LanguageModelChatTool[],
    maxTokens?: number
): unknown {
    if (model.provider === 'anthropic') {
        return buildAnthropicRequest(model, messages, tools, maxTokens);
    }
    if (model.provider === 'google') {
        return buildGoogleRequest(model, messages, tools, maxTokens);
    }
    // open_ai and x_ai — use OpenAI chat completions format
    return buildOpenAiChatRequest(model, messages, tools, maxTokens);
}

function normalizeToolParameters(schema: unknown): unknown {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }
    const s = schema as Record<string, unknown>;
    if (s.type !== 'object') { s.type = 'object'; }
    if (!s.properties) { s.properties = {}; }
    return s;
}

// ─── NDJSON response parsers ──────────────────────────────────────────────────

function parseJsonSafe(value: string): unknown {
    try { return JSON.parse(value); } catch { return {}; }
}

function appendText(blocks: ZedCompletionContentBlock[], text: string): void {
    if (!text) { return; }
    const last = blocks[blocks.length - 1];
    if (last?.type === 'text') { last.text = (last.text || '') + text; return; }
    blocks.push({ type: 'text', text });
}

function unwrapCompletionLines(text: string, includesStatusMessages: boolean): unknown[] {
    const events: unknown[] = [];
    for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }

        if (!includesStatusMessages) { events.push(parsed); continue; }

        const p = parsed as Record<string, unknown>;
        if ('event' in p) { events.push(p.event); continue; }
        if ('status' in p) {
            const status = p.status as Record<string, unknown>;
            if (status.failed) {
                const f = status.failed as Record<string, unknown>;
                throw new Error(`Zed completion failed: ${f.message || 'unknown error'}`);
            }
        }
    }
    return events;
}

function parseAnthropicEvents(events: unknown[]): ZedCompletionResult {
    const blocks: ZedCompletionContentBlock[] = [];
    const toolMap = new Map<number, { id: string; name: string; input: string }>();
    let stopReason: ZedCompletionResult['stopReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    for (const ev of events) {
        const e = ev as Record<string, unknown>;
        const type = String(e?.type || '');

        if (type === 'message_start') {
            const usage = (e.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
            inputTokens = usage?.input_tokens || inputTokens;
            outputTokens = usage?.output_tokens || outputTokens;
        } else if (type === 'content_block_start') {
            const block = e.content_block as Record<string, unknown> | undefined;
            if (block?.type === 'text' && typeof block.text === 'string') {
                appendText(blocks, block.text);
            } else if (block?.type === 'tool_use') {
                toolMap.set(Number(e.index), {
                    id: String(block.id || `tool_${crypto.randomUUID().slice(0, 8)}`),
                    name: String(block.name || 'tool'),
                    input: '',
                });
            }
        } else if (type === 'content_block_delta') {
            const delta = e.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                appendText(blocks, delta.text);
            } else if (delta?.type === 'input_json_delta') {
                const t = toolMap.get(Number(e.index));
                if (t && typeof delta.partial_json === 'string') { t.input += delta.partial_json; }
            }
        } else if (type === 'content_block_stop') {
            const t = toolMap.get(Number(e.index));
            if (t) {
                blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: parseJsonSafe(t.input || '{}') });
                toolMap.delete(Number(e.index));
            }
        } else if (type === 'message_delta') {
            const delta = e.delta as Record<string, unknown> | undefined;
            if (delta?.stop_reason === 'tool_use') { stopReason = 'tool_use'; }
            else if (delta?.stop_reason === 'max_tokens') { stopReason = 'max_tokens'; }
            outputTokens = (e.usage as Record<string, number>)?.output_tokens || outputTokens;
        }
    }

    if (blocks.length === 0) { blocks.push({ type: 'text', text: '' }); }
    return { contentBlocks: blocks, stopReason, usage: { inputTokens, outputTokens } };
}

function parseOpenAiChatEvents(events: unknown[]): ZedCompletionResult {
    const blocks: ZedCompletionContentBlock[] = [];
    const toolMap = new Map<number, { id: string; name: string; input: string }>();
    let stopReason: ZedCompletionResult['stopReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    for (const ev of events) {
        const e = ev as Record<string, unknown>;
        const usage = e.usage as Record<string, number> | undefined;
        if (usage) {
            inputTokens = usage.prompt_tokens || inputTokens;
            outputTokens = usage.completion_tokens || outputTokens;
        }
        const choices = e.choices as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        const delta = choice?.delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === 'string') { appendText(blocks, delta.content); }

        const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
        for (const tc of toolCalls || []) {
            const idx = Number(tc.index || 0);
            const entry = toolMap.get(idx) || { id: '', name: '', input: '' };
            if (tc.id) { entry.id = String(tc.id); }
            const fn = tc.function as Record<string, string> | undefined;
            if (fn?.name) { entry.name = fn.name; }
            if (fn?.arguments) { entry.input += fn.arguments; }
            toolMap.set(idx, entry);
        }

        if (choice?.finish_reason === 'tool_calls') {
            for (const t of toolMap.values()) {
                if (t.id && t.name) {
                    blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: parseJsonSafe(t.input || '{}') });
                }
            }
            toolMap.clear();
            stopReason = 'tool_use';
        } else if (choice?.finish_reason === 'length') {
            stopReason = 'max_tokens';
        }
    }

    if (blocks.length === 0) { blocks.push({ type: 'text', text: '' }); }
    return { contentBlocks: blocks, stopReason, usage: { inputTokens, outputTokens } };
}

function parseGoogleEvents(events: unknown[]): ZedCompletionResult {
    const blocks: ZedCompletionContentBlock[] = [];
    let stopReason: ZedCompletionResult['stopReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    for (const ev of events) {
        const e = ev as Record<string, unknown>;
        const usage = (e.usageMetadata || e.usage_metadata) as Record<string, number> | undefined;
        if (usage) {
            inputTokens = usage.promptTokenCount || usage.prompt_token_count || inputTokens;
            outputTokens = usage.candidatesTokenCount || usage.candidates_token_count || outputTokens;
        }
        for (const candidate of (e.candidates as Array<Record<string, unknown>>) || []) {
            const reason = candidate.finishReason || candidate.finish_reason;
            if (reason === 'MAX_TOKENS') { stopReason = 'max_tokens'; }
            const parts = (candidate.content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;
            for (const part of parts || []) {
                if (typeof part.text === 'string') {
                    appendText(blocks, part.text);
                } else {
                    const call = (part.functionCall || part.function_call) as Record<string, unknown> | undefined;
                    if (call) {
                        blocks.push({
                            type: 'tool_use',
                            id: String(call.id || `tool_${crypto.randomUUID().slice(0, 8)}`),
                            name: String(call.name || 'tool'),
                            input: call.args || {},
                        });
                        stopReason = 'tool_use';
                    }
                }
            }
        }
    }

    if (blocks.length === 0) { blocks.push({ type: 'text', text: '' }); }
    return { contentBlocks: blocks, stopReason, usage: { inputTokens, outputTokens } };
}

function parseCompletionResponse(
    bodyText: string,
    includesStatusMessages: boolean,
    subProvider: ZedCloudProvider
): ZedCompletionResult {
    const events = unwrapCompletionLines(bodyText, includesStatusMessages);
    if (subProvider === 'anthropic') { return parseAnthropicEvents(events); }
    if (subProvider === 'google') { return parseGoogleEvents(events); }
    return parseOpenAiChatEvents(events);
}

// ─── Main completion entry point ──────────────────────────────────────────────

export async function createZedCompletion(
    account: ZedAccount,
    model: ZedModelInfo,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken
): Promise<void> {
    const internalMessages = convertVsCodeMessages(messages);
    const tools = options.tools ? [...options.tools] : [];
    const maxTokens = options.modelOptions?.modelMaxOutputTokens || model.max_output_tokens;

    const providerRequest = buildProviderRequest(model, internalMessages, tools, maxTokens);

    let llmToken = await getZedLlmToken(account);
    let refreshed = false;

    while (true) {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const response = await fetchWithTimeout(
            cloudUrl(account, '/completions'),
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${llmToken}`,
                    'Content-Type': 'application/json',
                    'x-zed-client-supports-status-messages': 'true',
                    'x-zed-client-supports-stream-ended-request-completion-status': 'true',
                },
                body: JSON.stringify({
                    provider: model.provider,
                    model: model.id,
                    provider_request: providerRequest,
                }),
            },
            ZED_COMPLETION_TIMEOUT_MS
        );

        const bodyText = await response.text();

        if (!refreshed && response.status === 401 && maybeRefreshableToken(response)) {
            llmToken = await getZedLlmToken(account, true);
            refreshed = true;
            continue;
        }

        if (!response.ok) {
            throw new Error(`Zed completion failed (${response.status}): ${bodyText}`);
        }

        const includesStatusMessages =
            response.headers.has('x-zed-server-supports-status-messages');

        const result = parseCompletionResponse(bodyText, includesStatusMessages, model.provider);

        // Stream content blocks to VS Code
        for (const block of result.contentBlocks) {
            if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
            if (block.type === 'text' && block.text) {
                progress.report(new vscode.LanguageModelTextPart(block.text));
            } else if (block.type === 'tool_use' && block.id && block.name) {
                progress.report(
                    new vscode.LanguageModelToolCallPart(
                        block.id,
                        block.name,
                        (block.input && typeof block.input === 'object') ? block.input as Record<string, unknown> : {}
                    )
                );
            }
        }

        Logger.debug(
            `[Zed] Completion done — model=${model.id} stop=${result.stopReason} ` +
            `in=${result.usage.inputTokens} out=${result.usage.outputTokens}`
        );
        return;
    }
}
