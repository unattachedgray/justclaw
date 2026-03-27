/** Login page HTML and auth helpers. */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const PASSWORD = process.env.DASHBOARD_PASSWORD || '88888888';
// Derive secret from password so sessions survive restarts
const SECRET = createHmac('sha256', 'justclaw-session-key').update(PASSWORD).digest('hex');
const COOKIE_NAME = 'justclaw_session';
const COOKIE_MAX_AGE = 86400 * 7; // 7 days

export function makeSessionToken(): string {
  const ts = Date.now().toString();
  const sig = createHmac('sha256', SECRET).update(ts).digest('hex').slice(0, 16);
  return `${ts}.${sig}`;
}

export function isValidSession(token: string): boolean {
  const [ts, sig] = token.split('.');
  if (!ts || !sig) return false;
  const expected = createHmac('sha256', SECRET).update(ts).digest('hex').slice(0, 16);
  if (sig !== expected) return false;
  // Expire after COOKIE_MAX_AGE
  const age = (Date.now() - parseInt(ts, 10)) / 1000;
  return age < COOKIE_MAX_AGE;
}

export function checkPassword(input: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function getSessionFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

export const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="midnight">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>justclaw — Login</title>
<style>
[data-theme="midnight"] {
  --bg: #0d1117; --surface: #161b22; --surface2: #1c2129;
  --border: #30363d; --text: #e6edf3; --text2: #8b949e;
  --accent: #58a6ff; --red: #f85149;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5;
  display: flex; align-items: center; justify-content: center;
  height: 100vh;
}
.login-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 40px; width: 340px;
  text-align: center;
}
.login-card h1 {
  font-size: 1.5rem; font-weight: 600; margin-bottom: 8px;
}
.login-card p {
  font-size: 0.85rem; color: var(--text2); margin-bottom: 24px;
}
.login-input {
  width: 100%; padding: 10px 14px; font-size: 1rem;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); outline: none;
  text-align: center; letter-spacing: 4px; font-family: monospace;
  margin-bottom: 16px;
}
.login-input:focus { border-color: var(--accent); }
.login-input::placeholder { letter-spacing: normal; color: var(--text2); }
.login-btn {
  width: 100%; padding: 10px; font-size: 0.9rem; font-weight: 600;
  background: var(--accent); color: #000; border: none;
  border-radius: 8px; cursor: pointer; transition: opacity 0.15s;
}
.login-btn:hover { opacity: 0.85; }
.error {
  color: var(--red); font-size: 0.8rem; margin-top: 12px;
  display: none;
}
.error.show { display: block; }
</style>
</head>
<body>
<div class="login-card">
  <h1>justclaw</h1>
  <p>Enter password to access the dashboard</p>
  <form method="POST" action="/login" id="login-form">
    <input class="login-input" type="password" name="password"
      placeholder="Password" autocomplete="current-password" autofocus />
    <button class="login-btn" type="submit">Sign In</button>
  </form>
  <div class="error" id="error">Wrong password.</div>
</div>
<script>
const params = new URLSearchParams(window.location.search);
if (params.get('error') === '1') {
  document.getElementById('error').classList.add('show');
}
</script>
</body>
</html>`;
