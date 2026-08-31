export type StoredTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  tokenType: string;
  /** The client this token belongs to, so a client change forces re-auth. */
  clientId: string;
};

export interface TokenStore {
  read(): Promise<StoredTokens | null>;
  write(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
  /** Where the tokens live, for `/archive:status` and for error messages. */
  readonly location: string;
}
