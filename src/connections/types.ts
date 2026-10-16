export interface ConnectionTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface SlackConnection {
  version: 1; id: string; provider: 'slack'; clientId: string; enabled: boolean;
  status: 'disconnected' | 'connected' | 'sign_in_required';
  teamId?: string; teamName?: string; userId?: string; userName?: string;
  tools: ConnectionTool[]; restrictions?: { include?: string[]; exclude?: string[] };
  scopes: string[]; createdAt: number; updatedAt: number; retired?: boolean;
}
export interface ConnectionGrant { connectionId: string; teamId: string; userId: string; tools: ConnectionTool[] }
export interface SlackTokens { accessToken: string; refreshToken?: string; expiresAt?: number; scopes: string[] }
export interface CredentialStore {
  get(id: string): Promise<SlackTokens | undefined>;
  set(id: string, tokens: SlackTokens): Promise<void>;
  delete(id: string): Promise<void>;
}
export interface ConnectionLogin {
  id: string; status: 'waiting' | 'working' | 'complete' | 'error' | 'cancelled';
  url?: string; error?: string; expiresAt: number;
}
export interface ConnectionView { login?: ConnectionLogin; connection?: Omit<SlackConnection, 'tools'> & { toolCount: number }; defaultClientId: string; callbackUrl: string; usesClaudeApp: boolean }
