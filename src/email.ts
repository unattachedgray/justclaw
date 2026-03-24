/**
 * Email utility — send messages via SMTP (Gmail app password).
 *
 * Configured via env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * Used for alerts, notifications, and scheduled reports alongside
 * the Discord and Google Chat channels.
 */

import { createTransport, type Transporter } from 'nodemailer';
import { getLogger } from './logger.js';

const log = getLogger('email');

let transporter: Transporter | null = null;

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** Load SMTP config from env vars. Returns null if not configured. */
function loadSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  return {
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user,
    pass,
    from: process.env.SMTP_FROM || user,
  };
}

/** Get or create the SMTP transporter (lazy singleton). */
function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const config = loadSmtpConfig();
  if (!config) {
    log.warn('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
    return null;
  }

  transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });

  log.info('SMTP transporter created', { host: config.host, user: config.user });
  return transporter;
}

/** Get the configured "from" address. */
function getFromAddress(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'justclaw@localhost';
}

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Send an email. Returns true on success, false on failure (logs error).
 *
 * Fails silently (returns false) if SMTP is not configured — callers
 * don't need to check configuration before calling.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;

  const to = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;

  try {
    const info = await t.sendMail({
      from: getFromAddress(),
      to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    log.info('Email sent', { to, subject: opts.subject, messageId: info.messageId });
    return true;
  } catch (err) {
    log.error('Email send failed', { to, subject: opts.subject, error: String(err) });
    return false;
  }
}

/**
 * Verify SMTP connection. Returns true if credentials work.
 * Useful for health checks and setup verification.
 */
export async function verifySmtp(): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;

  try {
    await t.verify();
    log.info('SMTP connection verified');
    return true;
  } catch (err) {
    log.error('SMTP verification failed', { error: String(err) });
    return false;
  }
}
