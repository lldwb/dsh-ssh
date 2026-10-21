/**
 * The settings page's only route back to the Host.
 *
 * ## Why a hand-written channel
 *
 * The browser half of a third-party plugin cannot declare a Remote namespace:
 * `dsh-api-remotes` fixes its capability set at build time, from packages that a
 * `link:`-installed plugin cannot resolve. `ctx.connection.rpc.call(channel,
 * method, payload)` is the supported escape hatch, and it needs a matching
 * server-side route.
 *
 * ## Why not `connection.rpc.handle`
 *
 * Measured, not guessed (`dsh-plugin-development.md` §24): the shipped helper
 * registers its route through `owner.webServer`, where `owner` is the caller's
 * fiber ctx. A plugin that does not inject `webServer` fails that property access
 * with `cannot get property "webServer" without inject`, the route is never
 * registered, and the browser sees **405** (the SPA fallback answering), not a
 * helpful error. So this module registers a prefix route on `webServer` directly
 * and reuses `connection.admit` for authentication.
 *
 * ## The envelope
 *
 * A request is `{ type: 'client-request', rpcId, method, payload }`; the reply is
 * `{ type: 'server-response', rpcId, result }` where `result` is
 * `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
 * `error.details` **must be an object** — the browser's `parseConnectionResponse`
 * throws `invalid server-response failure` otherwise.
 *
 * @module dsh-ssh/lib/rpc
 */

/** The channel path the client half calls. */
export const RPC_CHANNEL = '/dsh-ssh';

/**
 * Wrap a success value in the connection envelope.
 *
 * @param {unknown} value - the payload.
 * @returns {{ ok: true, value: unknown }} the result.
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * Wrap a failure in the connection envelope.
 *
 * @param {string} code - a short machine-readable code.
 * @param {string} message - the user-facing message.
 * @returns {{ ok: false, error: { code: string, message: string, details: Record<string, unknown> } }} the result.
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * Read the request body.
 *
 * @param {any} req - the Node request.
 * @returns {Promise<string>} the body text.
 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Register the settings page's RPC channel.
 *
 * The dependency object is the whole Host API the page is allowed to use; it is
 * built by `index.js` from the same modules the tools use, so the page and the
 * tools can never disagree about what a profile is.
 *
 * @param {any} ctx - the Cordis plugin context.
 * @param {{
 *   handlers: Record<string, (payload: Record<string, any>) => Promise<unknown>>,
 * }} deps - method table.
 * @returns {void}
 */
export function mountRpc(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['connection', 'webServer'], (rpcCtx) => {
    rpcCtx.effect(
      () =>
        rpcCtx.webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: async (req, res) => {
            /** @param {number} status - HTTP status. @param {unknown} payload - JSON body. */
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(payload));
            };

            let admission;
            try {
              admission = rpcCtx.connection.admit(req);
            } catch (error) {
              send(500, { error: error instanceof Error ? error.message : String(error) });
              return;
            }
            if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
              res.writeHead(/** @type {any} */ (admission).rejection);
              res.end();
              return;
            }
            if (req.method !== 'POST') {
              send(405, { error: 'method not allowed' });
              return;
            }

            let request;
            try {
              request = JSON.parse(await readBody(req));
            } catch {
              send(400, { error: 'invalid JSON body' });
              return;
            }
            if (request === null || typeof request !== 'object' || typeof request.rpcId !== 'string') {
              send(400, { error: 'expected {type,rpcId,method,payload}' });
              return;
            }

            const method = String(request.method ?? '');
            const handler = deps.handlers[method];
            /** @type {unknown} */
            let result;
            if (handler === undefined) {
              result = fail('UNKNOWN_METHOD', `unknown method ${JSON.stringify(method)}`);
            } else {
              try {
                const payload = request.payload !== null && typeof request.payload === 'object' ? request.payload : {};
                result = ok(await handler(payload));
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result = fail('OPERATION_FAILED', message);
              }
            }
            send(200, { type: 'server-response', rpcId: request.rpcId, result });
          },
        }),
      'dsh-ssh: settings rpc channel',
    );
  });
}
