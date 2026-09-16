(function (root) {
  'use strict';
  const core = root.ResumeEnhancementsCore;
  const sessions = new Map();
  const cancelled = new Map();
  const keyFor = (sender, id) => `${sender.tab?.id ?? 'extension'}:${sender.frameId || 0}:${id}`;
  function abortError() { const error = new Error('填写已停止'); error.name = 'AbortError'; return error; }
  async function runFill(message, sender, execute) {
    if (!message.sessionId) return execute({ forceRefresh: message.forceRefresh === true });
    const key = keyFor(sender, message.sessionId);
    if (cancelled.has(key)) return { mappings: [], cancelled: true };
    const controller = new AbortController();
    if (!sessions.has(key)) sessions.set(key, new Set());
    sessions.get(key).add(controller);
    try {
      const result = await execute({ forceRefresh: message.forceRefresh === true, signal: controller.signal,
        aiEnhanced: message.aiEnhanced === true });
      return controller.signal.aborted ? { mappings: [], cancelled: true } : result;
    } catch (error) {
      if (controller.signal.aborted) return { mappings: [], cancelled: true };
      throw error;
    } finally {
      sessions.get(key)?.delete(controller);
      if (!sessions.get(key)?.size) sessions.delete(key);
    }
  }
  function cancel(sender, id) {
    if (!id || typeof id !== 'string' || id.length > 160) return;
    const key = keyFor(sender, id);
    cancelled.set(key, Date.now());
    for (const controller of sessions.get(key) || []) controller.abort();
    for (const [old, time] of cancelled) if (Date.now() - time > 600000) cancelled.delete(old);
  }
  async function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('resume-enhancements', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('backups', { keyPath: 'id' });
      request.onerror = () => reject(request.error || new Error('无法打开备份数据库'));
      request.onblocked = () => reject(new Error('备份数据库被占用，请关闭其他设置页后重试'));
      request.onsuccess = () => resolve(request.result);
    });
  }
  async function backupsTransaction(mode, operation) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('backups', mode);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('备份操作失败'));
        operation(transaction.objectStore('backups'), value => { result = value; });
      });
    } finally { db.close(); }
  }
  async function listBackups() {
    return backupsTransaction('readonly', (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => done(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
  }
  async function backup(stored, reason) {
    const item = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), reason, profile: core.profileSnapshot(stored) };
    await backupsTransaction('readwrite', (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const previous = request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        previous.slice(2).forEach(old => store.delete(old.id));
        store.put(item);
        done(item.id);
      };
    });
    return item.id;
  }
  let storageQueue = Promise.resolve();
  function serialized(work) {
    const result = storageQueue.then(work);
    storageQueue = result.catch(() => {});
    return result;
  }
  async function importProfile(data, reason) {
    const validated = core.validateImport(data);
    return serialized(async () => {
      const stored = await chrome.storage.local.get(null);
      if (validated.llm) {
        if (!validated.llm.apiKey?.trim()) delete validated.llm.apiKey;
        validated.llm = { ...stored.llm, ...validated.llm };
      }
      await backup(stored, reason || '导入前');
      await chrome.storage.local.set(validated);
      return { ok: true };
    });
  }
  async function restoreBackup(id) {
    return serialized(async () => {
      const found = (await listBackups()).find(item => item.id === id);
      if (!found) throw new Error('该备份已不存在');
      const stored = await chrome.storage.local.get(null);
      await backup(stored, '恢复前');
      const empty = {};
      core.PROFILE_KEYS.forEach(key => { empty[key] = ['basic', 'extra', 'jobIntention'].includes(key) ? {} :
        ['languages', 'certificates', 'skills', 'hobbies', 'selfEvaluation'].includes(key) ? '' : []; });
      core.SCHEMA_KEYS.forEach(key => { empty[key] = 0; });
      await chrome.storage.local.set({ ...empty, ...found.profile });
      return { ok: true };
    });
  }
  async function handle(message, sender) {
    if (message.type === 'ENHANCEMENT_CANCEL_FILL') {
      cancel(sender, message.sessionId);
      return { ok: true };
    }
    // 导入和恢复仅允许扩展页面调用，不接受招聘页面的内容脚本消息。
    if (!String(sender.url || '').startsWith(chrome.runtime.getURL(''))) throw new Error('请在插件设置中管理备份');
    if (message.type === 'ENHANCEMENT_IMPORT') return importProfile(message.data, message.reason);
    if (message.type === 'ENHANCEMENT_LIST_BACKUPS') return { backups: (await listBackups()).map(({ profile, ...item }) => item) };
    if (message.type === 'ENHANCEMENT_RESTORE') return restoreBackup(message.id);
    if (message.type === 'ENHANCEMENT_BACKUP') return serialized(async () => ({ id: await backup(await chrome.storage.local.get(null), message.reason) }));
    throw new Error('未知增强操作');
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message?.type?.startsWith('ENHANCEMENT_')) return false;
    handle(message, sender).then(respond, error => respond({ error: error.message }));
    return true;
  });
  root.ResumeBackgroundEnhancements = { runFill, cancel, abortError, importProfile, restoreBackup, listBackups, backup };
})(globalThis);
