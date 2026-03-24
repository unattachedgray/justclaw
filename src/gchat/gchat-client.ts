/**
 * Google Chat API client — service account auth + REST API calls.
 *
 * Uses the Chat API directly to avoid heavy SDK dependencies.
 * Auth flow: service account JSON key → JWT → access token (auto-refreshed).
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';
import { getLogger } from '../logger.js';

const log = getLogger('gchat-client');

export class GChatClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private serviceAccount: {
    client_email: string;
    private_key: string;
    project_id: string;
  } | null = null;

  constructor(private keyPath: string | null) {
    if (keyPath) {
      try {
        this.serviceAccount = JSON.parse(readFileSync(keyPath, 'utf-8'));
        log.info('Service account loaded', { email: this.serviceAccount!.client_email });
      } catch (err) {
        log.error('Failed to load service account key', { path: keyPath, error: String(err) });
      }
    }
  }

  /** Get a valid access token, refreshing if needed. */
  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    if (!this.serviceAccount) {
      throw new Error('No service account configured — set GCHAT_SERVICE_ACCOUNT_KEY');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: this.serviceAccount.client_email,
      sub: this.serviceAccount.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/chat.bot',
    })).toString('base64url');

    const sign = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(this.serviceAccount.private_key, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Token exchange failed: ${resp.status} ${body}`);
    }

    const data = await resp.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    log.info('Access token refreshed', { expiresIn: data.expires_in });
    return this.accessToken;
  }

  /** Send a text message to a space. Returns the message resource name. */
  async sendMessage(spaceName: string, text: string, threadKey?: string): Promise<string> {
    const token = await this.getToken();
    const body: Record<string, unknown> = { text };
    if (threadKey) {
      body.thread = { threadKey };
    }

    let url = `https://chat.googleapis.com/v1/${spaceName}/messages`;
    if (threadKey) {
      url += '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`sendMessage failed: ${resp.status} ${errBody}`);
    }

    const msg = await resp.json() as { name: string };
    return msg.name;
  }

  /** Update an existing message (for progress display). */
  async updateMessage(messageName: string, text: string): Promise<void> {
    const token = await this.getToken();
    const resp = await fetch(
      `https://chat.googleapis.com/v1/${messageName}?updateMask=text`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      },
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      log.warn('updateMessage failed', { status: resp.status, error: errBody.slice(0, 200) });
    }
  }

  /** Delete a message. */
  async deleteMessage(messageName: string): Promise<void> {
    const token = await this.getToken();
    const resp = await fetch(
      `https://chat.googleapis.com/v1/${messageName}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
    );
    if (!resp.ok) {
      log.warn('deleteMessage failed', { status: resp.status });
    }
  }
}
