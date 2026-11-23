/**
 * Função da Vercel: /api/admin-claims — GET lista usuários/administradores; POST promove/revoga (VF-2-03aa/03ab).
 * Toda a lógica e as garantias de segurança estão em `server/admin/claims.mjs`; aqui só se adapta req/res.
 */
import { handleAdminClaims } from '../server/admin/claims.mjs';

export default async function handler(req, res) {
  const result = await handleAdminClaims({ method: req.method, headers: req.headers, body: req.body });
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
}
