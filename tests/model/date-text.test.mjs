/** Datas em formato brasileiro ⇄ ISO (puro): máscara de digitação e conversões dos campos de data. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isoToBr, monthIsoToBr, brToIso, brToMonthIso, maskDateText } from '../../js/utils/dateText.js';

describe('dateText — DD/MM/AAAA e MM/AAAA', () => {
  it('ISO → BR', () => {
    assert.equal(isoToBr('2026-11-05'), '05/11/2026');
    assert.equal(isoToBr(''), '');
    assert.equal(isoToBr(undefined), '');
    assert.equal(monthIsoToBr('2026-11'), '11/2026');
    assert.equal(isoToBr('lixo'), 'lixo');
  });
  it('BR → ISO só com dia real do calendário; aceita ISO e dia/mês sem zero', () => {
    assert.equal(brToIso('05/11/2026'), '2026-11-05');
    assert.equal(brToIso('5/1/2026'), '2026-01-05');
    assert.equal(brToIso('29/02/2028'), '2028-02-29');
    assert.equal(brToIso('2026-11-05'), '2026-11-05');
    for (const bad of ['31/02/2026', '29/02/2027', '00/01/2026', '12/13/2026', '1/2', '', 'abc', '2026-02-30']) assert.equal(brToIso(bad), null, bad);
    assert.equal(brToMonthIso('11/2026'), '2026-11');
    assert.equal(brToMonthIso('2026-11'), '2026-11');
    for (const bad of ['13/2026', '00/2026', '11/26', '', '2026-13']) assert.equal(brToMonthIso(bad), null, bad);
  });
  it('máscara ao digitar', () => {
    assert.equal(maskDateText('1'), '1');
    assert.equal(maskDateText('120'), '12/0');
    assert.equal(maskDateText('12032026'), '12/03/2026');
    assert.equal(maskDateText('12/03/20269999'), '12/03/2026');
    assert.equal(maskDateText('12/'), '12');
    assert.equal(maskDateText('0326', 'month'), '03/26');
    assert.equal(maskDateText('032026', 'month'), '03/2026');
    assert.equal(maskDateText('2026-03-12'), '2026-03-12'); // ISO não é mexido (colado / testes)
  });
});
