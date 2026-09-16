(function (root) {
  'use strict';
  const core = root.ResumeEnhancementsCore;
  function create(hooks) {
    let settings = core.settings(), rules = [], active = null, report = null, panel = null;
    let lastUrl = location.href;
    const manual = new Map();
    const revisions = new Map();
    const ids = field => hooks.identity(field);
    const fieldByElement = element => hooks.fields().find(field => {
      const node = hooks.find(field.selector);
      const choice = field.componentType === 'native-radio' || field.componentType === 'native-checkbox';
      return node && (node === element || node.contains?.(element) || (choice && hooks.choiceElements?.(node)?.includes(element)));
    });
    const readSettings = async () => {
      try {
        const stored = await chrome.storage.local.get([core.SETTINGS_KEY, core.RULES_KEY]);
        settings = core.settings(stored[core.SETTINGS_KEY]);
        rules = Array.isArray(stored[core.RULES_KEY]) ? stored[core.RULES_KEY] : [];
      } catch { /* 缺少增强设置不影响原有填写 */ }
    };
    const ready = readSettings();
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && (changes[core.SETTINGS_KEY] || changes[core.RULES_KEY])) readSettings();
    });
    function config() { return active?.settings || settings; }
    function mark(field) {
      if (!field) return;
      const key = ids(field);
      manual.set(key, field);
      revisions.set(key, (revisions.get(key) || 0) + 1);
      // 一个 radio 组只有一个业务值，改选时保护同组全部选项。
      if (field.componentType === 'native-radio') {
        const node = hooks.find(field.selector);
        for (const other of hooks.fields()) if (other.componentType === 'native-radio' && node?.name &&
          hooks.find(other.selector)?.name === node.name && other.recordGroupKey === field.recordGroupKey && other.recordIndex === field.recordIndex) {
          manual.set(ids(other), other); revisions.set(ids(other), (revisions.get(ids(other)) || 0) + 1);
        }
      }
    }
    function track(event) {
      if (!event.isTrusted || event.composedPath?.().some(node => /^resume-(autofill|quick|record)/.test(node.id || ''))) return;
      mark(fieldByElement(event.target));
    }
    document.addEventListener('input', track, true);
    document.addEventListener('change', track, true);
    let focused = null;
    document.addEventListener('focusin', event => { if (event.isTrusted) focused = fieldByElement(event.target); }, true);
    document.addEventListener('click', event => {
      if (!event.isTrusted || event.composedPath?.().some(node => /^resume-(autofill|quick|record)/.test(node.id || ''))) return;
      const control = event.target.tagName === 'INPUT' ? event.target : event.target.closest?.('label')?.control;
      // 在旧推荐点击监听器之前识别用户选项，避免自动推荐抢先改回单选/复选值。
      if (control && /^(radio|checkbox)$/.test(control.type)) mark(fieldByElement(control));
      if (focused && event.target.closest?.('[role="option"], .phoenix-select__option, .ant-select-dropdown-menu-item')) mark(focused);
    }, true);
    function blocked(field) { return !!(config().protectManual && manual.has(ids(field))); }
    function unprotect(field) {
      const node = hooks.find(field.selector);
      for (const [key, other] of manual) {
        if (key === ids(field) || (field.componentType === 'native-radio' && other.componentType === 'native-radio' && node?.name &&
          hooks.find(other.selector)?.name === node.name && other.recordGroupKey === field.recordGroupKey && other.recordIndex === field.recordIndex)) manual.delete(key);
      }
    }
    function blockedMapping(mapping) {
      if (!config().protectManual) return false;
      const field = [...(active?.fields.values() || hooks.fields())].find(field =>
        ids(field) === mapping.fieldIdentity || field.selector === mapping.selector);
      if (!field || !blocked(field)) return false;
      active?.results.set(ids(field), { status: '手动修改已保护' });
      return true;
    }
    function check() {
      if (active?.cancelled) { const error = new Error('填写已停止'); error.name = 'ResumeFillStopped'; throw error; }
    }
    function stop() {
      if (!active || active.cancelled) return;
      active.cancelled = true;
      for (const listener of active.cancelListeners) listener();
      chrome.runtime.sendMessage({ type: 'ENHANCEMENT_CANCEL_FILL', sessionId: active.id }).catch(() => {});
      const button = document.getElementById('resume-autofill-stop');
      if (button) { button.textContent = '正在停止…'; button.disabled = true; }
    }
    function onCancel(listener) {
      const task = active;
      if (!task) return () => {};
      if (task.cancelled) listener(); else task.cancelListeners.add(listener);
      return () => task.cancelListeners.delete(listener);
    }
    function control(id, label, action) {
      let element = document.getElementById(id);
      if (!element) {
        element = document.createElement('button'); element.type = 'button'; element.id = id;
        element.className = 'resume-autofill-action'; element.textContent = label;
        element.addEventListener('click', action); hooks.dock().append(element);
      }
      return element;
    }
    async function begin(profile, onlyFields) {
      await ready;
      const fields = onlyFields || hooks.fields();
      active = { id: crypto.randomUUID(), url: location.href, settings: { ...settings }, profile, fields: new Map(),
        results: new Map(), mappings: new Map(), sourceInfo: new Map(), cancelled: false, cancelListeners: new Set(), initial: new Set(fields.map(ids)),
        previousReport: onlyFields && report?.url === location.href ? report : null };
      panel?.remove(); panel = null;
      document.getElementById('resume-autofill-report')?.remove();
      const button = control('resume-autofill-stop', '停止', stop); button.disabled = false; button.textContent = '停止';
      observe(fields, true);
      return active;
    }
    function observe(fields, initial = false) {
      if (!active) return;
      for (const field of fields || []) {
        const key = ids(field);
        active.fields.set(key, field);
        if (blocked(field)) active.results.set(key, { status: '手动修改已保护' });
        else if (initial && !hooks.empty(field)) active.results.set(key, { status: '原有内容保留' });
      }
    }
    function localResult(fields, profile, result) {
      if (active) observe(fields);
      const mappings = result.mappings.slice(), remaining = [];
      for (const field of result.remaining) {
        if (active?.sourceInfo.get(ids(field))?.sourceRefs?.length) { remaining.push(field); continue; }
        const hit = rules.map(rule => core.ruleMapping(rule, location.href, field, profile)).find(Boolean);
        if (hit && !blocked(field)) mappings.push(hit); else remaining.push(field);
      }
      return { ...result, mappings, remaining };
    }
    function note(mappings, fields, source = '本地规则') {
      if (!active) return;
      const bySelector = new Map(fields.map(field => [field.selector, field]));
      for (const mapping of mappings || []) {
        const field = bySelector.get(mapping.selector) || [...active.fields.values()].find(field => ids(field) === mapping.fieldIdentity);
        if (!field) continue;
        active.fields.set(ids(field), field);
        active.mappings.set(ids(field), { ...mapping, source: mapping.sourceRef || (source === 'AI' ? 'AI 匹配 · 来源未核实' : mapping.label || source) });
      }
    }
    function aiFields(fields, profile) {
      if (!config().aiEnhanced) return fields;
      return fields.map(field => ({ ...field, ...active?.sourceInfo.get(ids(field)) })).filter(field => {
        if (field.sourceMissing === true) {
          active?.results.set(ids(field), { status: '简历缺少数据' }); return false;
        }
        return true;
      });
    }
    function sourceInfo(field, info) {
      if (!active) return;
      active.sourceInfo.set(ids(field), info);
      if (info.sourceMissing) active.results.set(ids(field), { status: '简历缺少数据' });
    }
    function aiResult(fields, result) {
      if (!active) return;
      for (const field of fields) {
        const rejected = result?.rejectedMappings?.find(item => item.selector === field.selector);
        const failed = result?.failedFields?.find(item => item.selector === field.selector);
        if (rejected) active.results.set(ids(field), { status: '来源无法核实', detail: rejected.reason });
        else if (failed) active.results.set(ids(field), { status: 'AI 请求失败', detail: failed.reason });
        else if (result?.error || result?.__commError) active.results.set(ids(field), { status: 'AI 请求失败', detail: result.error || result.__commError });
      }
      note(result?.mappings || [], fields, 'AI');
    }
    function completed(mapping, ok) {
      if (!active) return;
      const key = mapping.fieldIdentity || [...active.fields.entries()].find(([, field]) => field.selector === mapping.selector)?.[0];
      if (key) active.results.set(key, { status: ok ? '核验成功' : '写入失败' });
    }
    function finish() {
      const task = active;
      if (!task) return;
      document.getElementById('resume-autofill-stop')?.remove();
      if (task.url === location.href) {
        const latest = hooks.fields();
        for (const field of latest) if (task.initial.has(ids(field)) || task.fields.has(ids(field))) task.fields.set(ids(field), field);
        const rows = [...task.fields].map(([key, field]) => {
          const result = task.results.get(key), mapping = task.mappings.get(key);
          let status = result?.status || (task.cancelled ? '已停止' : field.sourceMissing ? '简历缺少数据' : '未匹配');
          if (mapping && !['原有内容保留', '手动修改已保护'].includes(status)) {
            const current = latest.find(item => ids(item) === key), node = current && hooks.find(current.selector);
            status = node && hooks.satisfied(mapping, node, current.componentType) ? '核验成功' : task.cancelled ? '已停止' : '写入失败';
          }
          return { key, field, status, source: mapping?.source || '', detail: result?.detail || '', mapping, revision: revisions.get(key) || 0 };
        });
        const previous = task.previousReport?.rows || [];
        const updated = new Map(rows.map(row => [row.key, row]));
        const merged = previous.map(row => updated.get(row.key) || row);
        rows.forEach(row => { if (!previous.some(old => old.key === row.key)) merged.push(row); });
        report = { rows: merged, profile: task.profile, url: task.url, cancelled: task.cancelled };
        control('resume-autofill-report', '填写结果', showReport);
      }
      active = null;
    }
    function locate(row) {
      const matches = hooks.fields().filter(field => ids(field) === row.key);
      if (matches.length !== 1) return null;
      const field = matches[0];
      const node = field && hooks.find(field.selector);
      if (!node) return null;
      node.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); hooks.highlight(node);
      return field;
    }
    function action(label, fn) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await fn(); } catch (error) { button.textContent = error.message; }
        finally { button.disabled = false; }
      }); return button;
    }
    function showReport() {
      if (!report || report.url !== location.href) return;
      panel?.remove(); panel = document.createElement('div'); panel.id = 'resume-autofill-report-panel';
      const shadow = panel.attachShadow({ mode: 'open' });
      const style = document.createElement('style'); style.textContent = `:host{all:initial;position:fixed;z-index:2147483647;right:24px;top:40px;width:min(540px,calc(100vw - 32px));font:14px/1.55 system-ui,sans-serif;color:#223249}section{background:white;border:1px solid #c7d4e8;border-radius:12px;box-shadow:0 12px 44px #19315033;padding:20px;max-height:80vh;overflow:auto}header{display:flex;justify-content:space-between;align-items:center}h2{font-size:20px;margin:0}h3{font-size:15px;margin:6px 0}p{margin:4px 0;color:#5c6d80;overflow-wrap:anywhere}.row{padding:14px 0;border-top:1px solid #e6edf5}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}button{font:inherit;background:#f5f8fc;color:#245491;border:1px solid #c7d4e8;border-radius:6px;padding:5px 10px;cursor:pointer}.summary{margin:12px 0}.status{font-weight:600;color:#245491}`;
      const section = document.createElement('section'), header = document.createElement('header');
      const title = document.createElement('h2'); title.textContent = report.cancelled ? '填写结果 · 已停止' : '填写结果';
      header.append(title, action('关闭', () => { panel?.remove(); panel = null; })); section.append(header);
      const summary = document.createElement('p'); summary.className = 'summary';
      summary.textContent = `核验成功 ${report.rows.filter(row => row.status === '核验成功').length} 项 / 本次检查 ${report.rows.length} 项`;
      section.append(summary);
      for (const row of report.rows) {
        const item = document.createElement('div'); item.className = 'row';
        const label = document.createElement('h3'); label.textContent = [row.field.section, Number.isInteger(row.field.recordIndex) ? `第 ${row.field.recordIndex + 1} 条` : '', row.field.label || row.field.placeholder || row.field.name || '未命名字段'].filter(Boolean).join(' · ');
        const status = document.createElement('p'); status.className = 'status'; status.textContent = row.status;
        const source = document.createElement('p'); source.textContent = row.source ? `来源：${row.source}` : '';
        const detail = document.createElement('p'); detail.textContent = row.detail;
        const actions = document.createElement('div'); actions.className = 'actions';
        actions.append(action('定位', () => { if (!locate(row)) throw new Error('字段已变化，请重新扫描'); }));
        if (manual.has(row.key)) actions.append(action('解除保护', () => {
          unprotect(row.field);
          for (const entry of report.rows) if (entry.status === '手动修改已保护' && !manual.has(entry.key)) entry.status = '未匹配';
          showReport();
        }));
        if (!['核验成功', '原有内容保留', '手动修改已保护'].includes(row.status)) {
          actions.append(action('重试此项', async () => {
            const field = locate(row); if (!field) throw new Error('字段已变化，请重新扫描');
            if (blocked(field) || !hooks.empty(field) || (revisions.get(row.key) || 0) !== row.revision) throw new Error('字段已有内容、已手动修改或受保护，未覆盖');
            panel?.remove(); panel = null; await hooks.retry(field);
          }));
          actions.append(action('手动推荐', async () => { const field = locate(row); if (!field) throw new Error('字段已变化'); await hooks.recommend(hooks.find(field.selector)); }));
        }
        item.append(label, status, source, detail, actions); section.append(item);
      }
      shadow.append(style, section); document.body.append(panel);
    }
    async function remember(element, item, append) {
      if (append) throw new Error('追加内容不生成字段规则');
      if (item.value == null || !String(item.value).trim()) throw new Error('简历来源为空，不能保存规则');
      const field = fieldByElement(element);
      if (!field) throw new Error('无法定位当前业务字段');
      const rule = core.makeRule(location.href, field, { group: item.groupKey, fieldKey: item.fieldKey || item.groupKey });
      const latest = await chrome.storage.local.get(core.RULES_KEY);
      rules = (latest[core.RULES_KEY] || []).filter(entry => entry.key !== rule.key).concat(rule);
      await chrome.storage.local.set({ [core.RULES_KEY]: rules });
    }
    function routeChanged() {
      if (lastUrl === location.href) return;
      lastUrl = location.href; stop(); report = null; manual.clear(); revisions.clear(); focused = null;
      panel?.remove(); panel = null; document.getElementById('resume-autofill-report')?.remove();
    }
    return { begin, check, blocked, blockedMapping, onCancel, stop, finish, observe, localResult, note, aiFields, aiResult, completed, remember, sourceInfo,
      manualPick: element => mark(fieldByElement(element)), routeChanged,
      get sessionId() { return active?.id; }, get aiEnhanced() { return config().aiEnhanced; }, get cancelled() { return active?.cancelled === true; },
      get report() { return report; } };
  }
  root.ResumeContentEnhancements = { create };
})(globalThis);
