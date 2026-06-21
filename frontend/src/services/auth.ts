import { BroadcastChannel } from 'broadcast-channel';

const TOKEN_REFRESH_CHANNEL = 'token-refresh';

class AuthService {
    private static instance: AuthService;
    private refreshInProgress: boolean = false;
    private broadcastChannel: BroadcastChannel;

    private constructor() {
        this.broadcastChannel = new BroadcastChannel(TOKEN_REFRESH_CHANNEL);
        this.broadcastChannel.onmessage = this.handleTokenUpdate.bind(this);
    }

    public static getInstance(): AuthService {
        if (!AuthService.instance) {
            AuthService.instance = new AuthService();
        }
        return AuthService.instance;
    }

    public async refreshTokens(): Promise<void> {
        if (this.refreshInProgress) {
            return;
        }

        this.refreshInProgress = true;

        try {
            const response = await fetch('/auth/refresh', { method: 'POST' });
            if (!response.ok) {
                throw new Error('Failed to refresh tokens');
            }
            const tokens = await response.json();
            this.storeTokens(tokens);
            this.broadcastChannel.postMessage(tokens);
        } catch (error) {
            console.error('Token refresh error:', error);
        } finally {
            this.refreshInProgress = false;
        }
    }

    private handleTokenUpdate(tokens: any): void {
        this.storeTokens(tokens);
    }

    private storeTokens(tokens: any): void {
        localStorage.setItem('accessToken', tokens.accessToken);
        localStorage.setItem('refreshToken', tokens.refreshToken);
    }
}

export default AuthService.getInstance();