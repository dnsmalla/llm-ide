import { send } from '../http.mjs';

export function healthRoutes(routes, ctx) {
  routes.set('GET /health', async (req, res) => {
    send(res, 200, { ok: true, service: 'account-service', signupOpen: ctx.config.signupOpen, directSignup: ctx.config.directSignup });
  });
}
