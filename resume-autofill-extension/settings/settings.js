(function () {
  'use strict';
  const core = ResumeEnhancementsCore;
  const $ = id => document.getElementById(id);
  const status = (text, error = false) => { $('status').textContent = text; $('status').style.color = error ? '#b42318' : '#21653c'; };
  async function message(data) {
    const result = await chrome.runtime.sendMessage(data);
    if (result?.error) throw new Error(result.error);
    return result;
  }
  function button(label, action) {
    const element = document.createElement('button'); element.textContent = label;
    element.addEventListener('click', async () => { element.disabled = true; try { await action(); } catch (error) { status(error.message, true); } finally { element.disabled = false; } });
    return element;
  }
  async function renderRules() {
    const stored = await chrome.storage.local.get(core.RULES_KEY);
    const rules = Array.isArray(stored[core.RULES_KEY]) ? stored[core.RULES_KEY] : [];
    $('rules').replaceChildren();
    if (!rules.length) $('rules').textContent = '还没有保存规则。可在网页推荐面板中选择“记住对应”。';
    for (const rule of rules) {
      const item = document.createElement('div'); item.className = 'item';
      const text = document.createElement('div'); text.textContent = `${rule.host} · ${rule.section} · ${rule.label} → ${rule.group}.${rule.fieldKey}`;
      const actions = document.createElement('div'); actions.className = 'actions';
      const update = async remove => {
        const latest = await chrome.storage.local.get(core.RULES_KEY);
        const next = (latest[core.RULES_KEY] || []).flatMap(entry => entry.key !== rule.key ? [entry] : remove ? [] : [{ ...entry, enabled: !entry.enabled }]);
        await chrome.storage.local.set({ [core.RULES_KEY]: next }); await renderRules(); status(remove ? '规则已删除' : '规则状态已更新');
      };
      actions.append(button(rule.enabled ? '停用' : '启用', () => update(false)), button('删除', () => update(true)));
      item.append(text, actions); $('rules').append(item);
    }
  }
  async function renderBackups() {
    const { backups } = await message({ type: 'ENHANCEMENT_LIST_BACKUPS' });
    $('backups').replaceChildren();
    if (!backups.length) $('backups').textContent = '尚无备份。导入简历前会自动创建。';
    for (const backup of backups) {
      const item = document.createElement('div'); item.className = 'item';
      const text = document.createElement('p'); text.textContent = `${new Date(backup.createdAt).toLocaleString()} · ${backup.reason}`;
      item.append(text, button('恢复这份简历', async () => {
        if (!confirm('用这份备份恢复简历？当前简历会先备份，投递记录和模型配置保持不变。')) return;
        await message({ type: 'ENHANCEMENT_RESTORE', id: backup.id }); await renderBackups(); status('简历已恢复，请重新打开插件弹窗查看');
      })); $('backups').append(item);
    }
  }
  async function init() {
    const stored = await chrome.storage.local.get(core.SETTINGS_KEY), current = core.settings(stored[core.SETTINGS_KEY]);
    $('protect-manual').checked = current.protectManual; $('ai-enhanced').checked = current.aiEnhanced;
    for (const id of ['protect-manual', 'ai-enhanced']) $(id).addEventListener('change', async () => {
      try { await chrome.storage.local.set({ [core.SETTINGS_KEY]: { protectManual: $('protect-manual').checked, aiEnhanced: $('ai-enhanced').checked } }); status('设置已保存；运行中的填写保持本次设置'); }
      catch (error) { status(error.message, true); }
    });
    $('refresh-backups').addEventListener('click', () => renderBackups().catch(error => status(error.message, true)));
    await renderRules(); await renderBackups();
  }
  init().catch(error => status(error.message, true));
})();
