/*---------------------------------------------------------------------------------------------
 *  Zed Provider Types
 *  Types for the Zed cloud AI API (cloud.zed.dev)
 *--------------------------------------------------------------------------------------------*/

export type ZedCloudProvider = 'anthropic' | 'open_ai' | 'google' | 'x_ai';

export interface ZedModelInfo {
    id: string;
    display_name?: string;
    provider: ZedCloudProvider;
    supports_tools?: boolean;
    supports_thinking?: boolean;
    supports_parallel_tool_calls?: boolean;
    max_output_tokens?: number;
}

export interface ZedModelsResponse {
    models?: ZedModelInfo[];
    default_model?: string | null;
    default_fast_model?: string | null;
    recommended_models?: string[];
}

export interface ZedAuthenticatedUserResponse {
    user: {
        id: number;
        github_login: string;
        name?: string | null;
    };
    organizations?: Array<{
        id: string;
        name: string;
    }>;
    plan?: {
        plan_v3?: string;
        usage?: {
            edit_predictions?: {
                used?: number;
                limit?: number | string;
            };
        };
        subscription_period?: {
            started_at?: string;
            ended_at?: string;
        } | null;
    };
}

export interface ZedAccount {
    id: string;
    login: string;
    label: string;
    accessToken: string;
    organizationId?: string;
    serverUrl: string;
}

export interface ZedCompletionContentBlock {
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
}

export interface ZedCompletionResult {
    contentBlocks: ZedCompletionContentBlock[];
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
    usage: { inputTokens: number; outputTokens: number };
}

export interface ZedModelCacheEntry {
    fetchedAt: number;
    models: ZedModelInfo[];
}

export interface ZedTokenCacheEntry {
    fetchedAt: number;
    token: string;
}
