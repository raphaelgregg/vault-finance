/**
 * Função da Vercel: GET /api/docs — playbook de manutenção (VF-DOC-01). SOMENTE administradores.
 * Toda a lógica está em `server/docs/playbook.mjs`; aqui só se adapta req/res.
 */
import { handleDocs } from '../server/docs/playbook.mjs';

export default async function handler(req, res) {
  const result = await handleDocs({ method: req.method, headers: req.headers });
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
}
