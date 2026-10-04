import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export function deploymentConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const baseURL =
    env.BETTER_AUTH_URL || env.RENDER_EXTERNAL_URL || (production ? '' : 'http://localhost:5173');
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw Error('A valid public origin is required');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (production && url.protocol !== 'https:')
  ) {
    throw Error('Public URL must be an origin (HTTPS in production)');
  }
  const secret = env.BETTER_AUTH_SECRET || '';
  if (secret.length < 32) throw Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT');
  const trustRenderProxy = env.TRUST_RENDER_PROXY === 'true';
  if (trustRenderProxy && env.RENDER !== 'true') throw Error('TRUST_RENDER_PROXY requires Render');
  return {
    baseURL: url.origin,
    secret,
    port,
    trustRenderProxy,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
  };
}

// Opt in only behind Render's public edge; never trust arbitrary forwarding lists.
export function clientIP(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  trustRenderProxy: boolean,
) {
  const edgeIP = req.headers['cf-connecting-ip'];
  return trustRenderProxy && typeof edgeIP === 'string' && isIP(edgeIP)
    ? edgeIP
    : (req.socket.remoteAddress ?? 'unknown');
}

// Never print arbitrary Error messages: providers may include credentials or input.
export function logFailure(event: string) {
  console.error(JSON.stringify({ level: 'error', event }));
}
