/**
 * Diálogo de ESTORNO (VF-ARQ-02): pede o motivo e envia ao servidor com uma `operationId` gerada ao abrir
 * (duplo clique/retry não estornam duas vezes). Mostra o erro real do servidor; a tela só atualiza após confirmação.
 */
import { el, toast } from './dom.js';
import { formModal, field } from './form-kit.js';
import { createReversal, REVERSAL_KINDS } from '../services/reversals.js';
import { newOperationId } from '../services/financeApi.js';
import { formatCents } from '../core/model.js';

/**
 * `kind`/`targetId`: lançamento a estornar; `summary`: texto curto ("Luz — R$ 129,90"); `amountCents` (informativo);
 * `onDone(result)` roda após o estorno confirmado pelo servidor.
 */
export function openReversalModal({ user, kind, targetId, summary, amountCents, onDone }) {
  const operationId = newOperationId();
  formModal({
    title: `Estornar ${REVERSAL_KINDS[kind] ?? 'lançamento'}`,
    formId: 'reversal-form',
    submitLabel: 'Estornar',
    focusId: 'reason',
    fields: [
      el('p', { text: summary ?? '' }),
      el('p', { class: 'card__hint', text: `O lançamento original é preservado; um estorno compensatório${amountCents ? ` de ${formatCents(amountCents)}` : ''} é registrado e os saldos/status são ajustados. Cada lançamento só pode ser estornado uma vez.` }),
      field('Motivo do estorno *', 'reason', el('textarea', { id: 'reason', name: 'reason', maxlength: 300, rows: 3, placeholder: 'Ex.: lançado por engano' })),
    ],
    submit: (data) => createReversal(user.uid, kind, targetId, { reason: data.get('reason'), operationId }),
    onDone: async (result) => {
      toast('Estorno registrado.');
      await onDone?.(result);
    },
  });
}
