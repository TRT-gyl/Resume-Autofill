(function (root) {
  'use strict';
  const core = root.ResumeEnhancementsCore;
  async function review(incoming, existing) {
    const matches = incoming.map(record => core.possibleApplicationMatches(record, existing));
    if (!matches.some(list => list.length)) return { records: incoming, separateIds: new Set() };
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'application-diff-dialog';
      const heading = document.createElement('h2'); heading.textContent = '发现可能已有的投递记录';
      const intro = document.createElement('p'); intro.textContent = '逐条核对后选择保留、更新或另存。只更新勾选的字段。';
      dialog.append(heading, intro);
      const decisions = [];
      incoming.forEach((record, index) => {
        const candidates = matches[index]; if (!candidates.length) return;
        const section = document.createElement('section'); section.className = 'application-diff-item';
        const title = document.createElement('h3'); title.textContent = `${record.preferenceLabel || ''} ${record.companyName} · ${record.jobTitle}`;
        const picker = document.createElement('select'); picker.setAttribute('aria-label', '已有记录');
        candidates.forEach(old => { const option = document.createElement('option'); option.value = old.id;
          option.textContent = `${old.appliedAt} · ${old.organizationUnit || '未填单位'} · ${old.status}`; picker.append(option); });
        const operation = document.createElement('select'); operation.setAttribute('aria-label', '处理方式');
        [['keep', '保留已有记录'], ['update', '更新勾选字段'], ['separate', '另存一条记录']].forEach(([value, label]) => {
          const option = document.createElement('option'); option.value = value; option.textContent = label; operation.append(option);
        });
        const detail = document.createElement('div');
        const checks = new Map();
        function render() {
          detail.replaceChildren(); checks.clear();
          const old = candidates.find(item => item.id === picker.value) || candidates[0];
          for (const [key, label] of [['status', '投递状态'], ['location', '工作地点'], ['notes', '备注']]) {
            if ((old[key] || '') === (record[key] || '')) continue;
            const row = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox';
            check.checked = key === 'status'; check.disabled = operation.value !== 'update';
            const text = document.createElement('span'); text.textContent = `${label}：${old[key] || '空'} → ${record[key] || '空'}`;
            row.append(check, text); detail.append(row); checks.set(key, check);
          }
          if (!checks.size) detail.textContent = '状态、地点和备注均无变化。';
        }
        picker.addEventListener('change', render); operation.addEventListener('change', render);
        section.append(title, picker, operation, detail); dialog.append(section); render();
        decisions.push({ index, record, candidates, picker, operation, checks });
      });
      const error = document.createElement('p'); error.setAttribute('role', 'alert');
      const actions = document.createElement('div'); actions.className = 'dialog-actions';
      const cancel = document.createElement('button'), save = document.createElement('button');
      cancel.type = save.type = 'button'; cancel.className = 'button'; save.className = 'button button-primary';
      cancel.textContent = '返回核对'; save.textContent = '确认处理并保存';
      const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
      cancel.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      save.addEventListener('click', () => {
        const records = incoming.slice(), separateIds = new Set(), used = new Set();
        for (const decision of decisions) {
          const { index, record, candidates, picker, operation, checks } = decision;
          const old = candidates.find(item => item.id === picker.value) || candidates[0];
          if (operation.value === 'separate') {
            const id = crypto.randomUUID(); separateIds.add(id); records[index] = { ...record, id, createdAt: new Date().toISOString() };
          } else {
            if (used.has(old.id)) { error.textContent = '同一已有记录不能同时用于两个志愿，请调整处理方式。'; return; }
            used.add(old.id);
            records[index] = operation.value === 'update'
              ? core.applyApplicationUpdate(old, record, [...checks].filter(([, input]) => input.checked).map(([key]) => key)) : { ...old };
          }
        }
        finish({ records, separateIds });
      });
      actions.append(cancel, save); dialog.append(error, actions); document.body.append(dialog); dialog.showModal();
    });
  }
  root.ResumeRecordsEnhancements = { review };
})(globalThis);
