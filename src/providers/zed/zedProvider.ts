/*---------------------------------------------------------------------------------------------
 *  Zed Provider
 *  VS Code LM Chat Provider for Zed cloud AI models.
 *  macOS only — reads credentials from the Zed app Keychain entry.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import { Logger } from '../../utils';
import { GenericModelProvider } from '../common/genericModelProvider';
import { ZedAuth, zedLoginCommand } from './zedAuth';
import { listZedModels, invalidateZedModelCache, createZedCompletion } from './zedHandler';
import type { ZedModelInfo, ZedAccount } from './zedTypes';
import { type ProviderConfig } from '../../types/sharedTypes';

const ZED_VENDOR = 'chp.zed';
const ZED_PROVIDER_KEY = 'zed';

const ZED_VIRTUAL_CONFIG: ProviderConfig = {
    displayName: 'Zed',
    baseUrl: 'https://cloud.zed.dev',
    apiKeyTemplate: '',
    models: [],
};

export class ZedProvider extends GenericModelProvider implements LanguageModelChatProvider {
    private cachedModelInfos: ZedModelInfo[] = [];

    constructor(context: vscode.ExtensionContext) {
        super(context, ZED_PROVIDER_KEY, ZED_VIRTUAL_CONFIG);
        ZedAuth.initialize(context);
    }

    static createAndActivate(
        context: vscode.ExtensionContext
    ): { provider: ZedProvider; disposables: vscode.Disposable[] } {
        Logger.info('[Zed] Provider activating (macOS only)');

        const provider = new ZedProvider(context);

        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(ZED_VENDOR, provider);

        // Fire an initial model-change event so VS Code picks up models on startup
        setTimeout(() => {
            ZedAuth.isLoggedIn().then(async loggedIn => {
                if (loggedIn) {
                    Logger.info('[Zed] User is logged in, firing model change event');
                    // Ensure existing account is registered in AccountManager (e.g. after upgrade)
                    const account = await ZedAuth.getAccount();
                    if (account) {
                        await ZedAuth.saveAccount(account);
                    }
                    provider._onDidChangeLanguageModelChatInformation.fire();
                }
            }).catch(() => undefined);
        }, 200);

        const loginCmd = vscode.commands.registerCommand('chp.zed.login', async () => {
            await zedLoginCommand();
            await provider.modelInfoCache?.invalidateCache(ZED_PROVIDER_KEY);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const logoutCmd = vscode.commands.registerCommand('chp.zed.logout', async () => {
            await ZedAuth.logout();
            await provider.modelInfoCache?.invalidateCache(ZED_PROVIDER_KEY);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, loginCmd, logoutCmd];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    getProviderConfig(): ProviderConfig {
        return ZED_VIRTUAL_CONFIG;
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // Zed is macOS only
        if (process.platform !== 'darwin') { return []; }

        try {
            const isLoggedIn = await ZedAuth.isLoggedIn();
            if (!isLoggedIn) {
                if (!options.silent) {
                    const action = await vscode.window.showInformationMessage(
                        'Zed requires importing your credentials. Would you like to do that now?',
                        'Import from Keychain',
                        'Cancel'
                    );
                    if (action === 'Import from Keychain') {
                        await zedLoginCommand();
                    }
                }
                return [];
            }

            const account = await ZedAuth.getAccount();
            if (!account) { return []; }

            const models = await listZedModels(account);
            if (models.length === 0) {
                Logger.warn('[Zed] No models returned from Zed API');
                return [];
            }

            this.cachedModelInfos = models;

            return models.map(m => ({
                id: m.id,
                name: m.display_name || m.id,
                vendor: ZED_VENDOR,
                family: 'zed',
                version: '1.0',
                maxInputTokens: 200_000,
                maxOutputTokens: m.max_output_tokens || 16_384,
                capabilities: {
                    toolCalling: m.supports_tools ?? true,
                    imageInput: false,
                },
            }));
        } catch (error) {
            Logger.error('[Zed] Failed to get models:', error);
            return [];
        }
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart2>,
        token: CancellationToken
    ): Promise<void> {
        const modelInfo = this.cachedModelInfos.find(m => m.id === model.id);
        if (!modelInfo) {
            throw new Error(`[Zed] Model not found in cache: ${model.id}`);
        }

        const account = await ZedAuth.getAccount();
        if (!account) {
            throw new Error('[Zed] Not logged in. Use the "Zed Login" command to import credentials.');
        }

        try {
            await createZedCompletion(account, modelInfo, messages, options, progress, token);
        } catch (error) {
            // On auth error, invalidate model cache so the next request re-fetches
            if (error instanceof Error && (error.message.includes('401') || error.message.includes('403'))) {
                invalidateZedModelCache(account as ZedAccount);
            }
            Logger.error('[Zed] Completion error:', error);
            throw error;
        }
    }
}
