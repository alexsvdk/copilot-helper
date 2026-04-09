/*---------------------------------------------------------------------------------------------
 *  Zed Authentication
 *  Imports Zed credentials from the macOS Keychain. macOS only.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as vscode from 'vscode';
import { Logger } from '../../utils';
import type { ZedAccount, ZedAuthenticatedUserResponse } from './zedTypes';

const ZED_APP_PATH = '/Applications/Zed.app';
const ZED_SERVER_URL = 'https://zed.dev';
const ZED_CLOUD_BASE = 'https://cloud.zed.dev';
const KEYCHAIN_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 8000;

const STORAGE_KEY_ID = 'zed.account.id';
const STORAGE_KEY_LOGIN = 'zed.account.login';
const STORAGE_KEY_LABEL = 'zed.account.label';
const STORAGE_KEY_ORG = 'zed.account.organizationId';
const STORAGE_KEY_ACCESS_TOKEN = 'zed.account.accessToken';

function runSecurity(args: string[], timeoutMs = KEYCHAIN_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(
                new Error(
                    'Timed out while reading Zed credentials from macOS Keychain. ' +
                        'Approve Keychain access for Copilot Helper Pro and try again.'
                )
            );
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', (error: Error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout || stderr);
            } else {
                reject(new Error((stderr || stdout || 'Failed to read Zed credentials').trim()));
            }
        });
    });
}

async function readZedKeychainAccountId(): Promise<string> {
    const output = await runSecurity(['find-internet-password', '-s', ZED_SERVER_URL]);
    const match = output.match(/"acct"<blob>="([^"]+)"/);
    const accountId = match?.[1]?.trim();
    if (!accountId) {
        throw new Error('Could not locate Zed account id in macOS Keychain.');
    }
    return accountId;
}

async function readZedKeychainAccessToken(): Promise<string> {
    const output = await runSecurity(['find-internet-password', '-s', ZED_SERVER_URL, '-w']);
    const token = output.trim();
    if (!token) {
        throw new Error('Could not read Zed access token from macOS Keychain.');
    }
    return token;
}

async function fetchZedUser(userId: string, accessToken: string): Promise<ZedAuthenticatedUserResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${ZED_CLOUD_BASE}/client/users/me`, {
            method: 'GET',
            headers: { Authorization: `${userId} ${accessToken}` },
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Zed user fetch failed (${response.status}): ${text}`);
        }
        const data = JSON.parse(text) as ZedAuthenticatedUserResponse;
        if (!data?.user) {
            throw new Error('Unexpected response from Zed user endpoint');
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

export class ZedAuth {
    private static context: vscode.ExtensionContext;

    static initialize(context: vscode.ExtensionContext): void {
        ZedAuth.context = context;
    }

    static async isLoggedIn(): Promise<boolean> {
        const token = await ZedAuth.context.secrets.get(STORAGE_KEY_ACCESS_TOKEN);
        return Boolean(token);
    }

    static async getAccount(): Promise<ZedAccount | undefined> {
        const [id, login, label, accessToken, organizationId] = await Promise.all([
            ZedAuth.context.secrets.get(STORAGE_KEY_ID),
            ZedAuth.context.secrets.get(STORAGE_KEY_LOGIN),
            ZedAuth.context.secrets.get(STORAGE_KEY_LABEL),
            ZedAuth.context.secrets.get(STORAGE_KEY_ACCESS_TOKEN),
            ZedAuth.context.secrets.get(STORAGE_KEY_ORG),
        ]);
        if (!id || !accessToken) {
            return undefined;
        }
        return {
            id,
            login: login || id,
            label: label || login || id,
            accessToken,
            organizationId: organizationId || undefined,
            serverUrl: ZED_SERVER_URL,
        };
    }

    static async importFromKeychain(): Promise<ZedAccount> {
        if (process.platform !== 'darwin') {
            throw new Error('Zed Keychain import is only supported on macOS.');
        }
        if (!existsSync(ZED_APP_PATH)) {
            throw new Error('Zed.app is not installed in /Applications.');
        }

        const userId = await readZedKeychainAccountId();
        const accessToken = await readZedKeychainAccessToken();
        const profile = await fetchZedUser(userId, accessToken);

        const account: ZedAccount = {
            id: String(profile.user.id),
            login: profile.user.github_login,
            label: profile.user.name || profile.user.github_login,
            accessToken,
            organizationId: profile.organizations?.[0]?.id,
            serverUrl: ZED_SERVER_URL,
        };

        await ZedAuth.saveAccount(account);
        Logger.info(`[Zed] Imported account: ${account.label} (${account.login})`);
        return account;
    }

    static async saveAccount(account: ZedAccount): Promise<void> {
        await Promise.all([
            ZedAuth.context.secrets.store(STORAGE_KEY_ID, account.id),
            ZedAuth.context.secrets.store(STORAGE_KEY_LOGIN, account.login),
            ZedAuth.context.secrets.store(STORAGE_KEY_LABEL, account.label),
            ZedAuth.context.secrets.store(STORAGE_KEY_ACCESS_TOKEN, account.accessToken),
            ZedAuth.context.secrets.store(
                STORAGE_KEY_ORG,
                account.organizationId || ''
            ),
        ]);
    }

    static async logout(): Promise<void> {
        await Promise.all([
            ZedAuth.context.secrets.delete(STORAGE_KEY_ID),
            ZedAuth.context.secrets.delete(STORAGE_KEY_LOGIN),
            ZedAuth.context.secrets.delete(STORAGE_KEY_LABEL),
            ZedAuth.context.secrets.delete(STORAGE_KEY_ACCESS_TOKEN),
            ZedAuth.context.secrets.delete(STORAGE_KEY_ORG),
        ]);
        Logger.info('[Zed] Logged out');
    }
}

export async function zedLoginCommand(): Promise<void> {
    if (process.platform !== 'darwin') {
        vscode.window.showErrorMessage('Zed provider is only available on macOS.');
        return;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Importing Zed credentials from Keychain…',
                cancellable: false,
            },
            async () => {
                const account = await ZedAuth.importFromKeychain();
                vscode.window.showInformationMessage(
                    `Zed: Signed in as ${account.label} (${account.login})`
                );
            }
        );
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        Logger.error('[Zed] Login failed:', error);
        vscode.window.showErrorMessage(`Zed login failed: ${msg}`);
    }
}
