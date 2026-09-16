// Content Script - 通用字段采集 + 智能填充 + 浮动按钮
// 策略：行为驱动检测，不依赖特定 UI 框架类名

(function () {
  'use strict';

  if (document.getElementById('resume-autofill-actions')) return;

  let running = false;               // 整页填充重入保护
  let enhancement = null;            // 可选增强层；原有匹配及组件算法保持独立
  let quickFillRunning = false;      // 点击自动推荐重入保护；与整页填充互斥
  let quickFillEnabled = false;      // 当前页面是否支持推荐面板
  let quickAutoFillEnabled = true;   // 面板右上角开关：是否在点击字段后直接写入推荐值
  let quickAppendEnabled = false;   // 手动点选默认覆盖；开启后向文本框末尾追加
  let quickFillManualEnabled = false; // 用户可从 popup 为普通表单页手动开启推荐

  // ===== 浮动操作组（可整体拖拽） =====
  function ensureFloatingActionDock() {
    let dock = document.getElementById('resume-autofill-actions');
    if (dock) return dock;
    dock = document.createElement('div');
    dock.id = 'resume-autofill-actions';
    dock.setAttribute('aria-label', '简历助手页面操作');
    const dragHandle = document.createElement('span');
    dragHandle.className = 'resume-autofill-drag-handle';
    dragHandle.title = '拖动按钮组';
    dragHandle.setAttribute('aria-hidden', 'true');
    dock.appendChild(dragHandle);
    document.body.appendChild(dock);

    let dragging = false;
    let moved = false;
    let pointerId = null;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    dock.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (!event.target.closest || !event.target.closest('.resume-autofill-drag-handle')) return;
      dragging = true;
      moved = false;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      const rect = dock.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      dock.setPointerCapture && dock.setPointerCapture(pointerId);
      dock.style.transition = 'none';
    });
    dock.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dx) <= 8 && Math.abs(dy) <= 8) return;
      moved = true;
      event.preventDefault();
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';
      dock.style.left = `${Math.max(0, Math.min(window.innerWidth - dock.offsetWidth, startLeft + dx))}px`;
      dock.style.top = `${Math.max(0, Math.min(window.innerHeight - dock.offsetHeight, startTop + dy))}px`;
    });
    const finishDrag = event => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      dock.releasePointerCapture && dock.releasePointerCapture(pointerId);
      pointerId = null;
      dock.style.transition = 'all 0.2s ease';
    };
    dock.addEventListener('pointerup', finishDrag);
    dock.addEventListener('pointercancel', finishDrag);
    return dock;
  }

  function createFloatingButton() {
    const existing = document.getElementById('resume-autofill-btn');
    if (existing) return existing;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'resume-autofill-btn';
    btn.className = 'resume-autofill-action';
    btn.textContent = '自动填充';
    btn.addEventListener('click', handleClick);
    ensureFloatingActionDock().appendChild(btn);
    return btn;
  }

  function createRecordCurrentButton() {
    const existing = document.getElementById('resume-record-current-btn');
    if (existing) return existing;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'resume-record-current-btn';
    btn.className = 'resume-autofill-action';
    btn.textContent = '记录当前职位';
    btn.addEventListener('click', handleRecordCurrentClick);
    const dock = ensureFloatingActionDock();
    const autofillButton = dock.querySelector('#resume-autofill-btn');
    if (autofillButton) dock.insertBefore(btn, autofillButton);
    else dock.appendChild(btn);
    return btn;
  }

  function updateButtonProgress(btn, progress) {
    if (!btn || btn.id !== 'resume-autofill-btn' || !Number.isFinite(progress)) return;
    const normalized = Math.max(0, Math.min(100, progress));
    btn.style.setProperty('--resume-autofill-progress', `${normalized}%`);
    btn.dataset.progress = String(Math.round(normalized));
  }

  function progressBetween(start, end, done, total) {
    const safeTotal = Number(total);
    if (!Number.isFinite(safeTotal) || safeTotal <= 0) return start;
    const ratio = Math.max(0, Math.min(1, Number(done) / safeTotal));
    return start + (end - start) * ratio;
  }

  function updateButtonText(btn, text, className, progress) {
    if (!btn) return;
    btn.textContent = text;
    btn.className = `resume-autofill-action${className ? ` ${className}` : ''}`;
    btn.setAttribute('aria-busy', className === 'loading' ? 'true' : 'false');
    if (btn.id === 'resume-autofill-btn') {
      if (Number.isFinite(progress)) updateButtonProgress(btn, progress);
      else if (!className && text === '自动填充') updateButtonProgress(btn, 0);
      const current = Number(btn.dataset.progress || 0);
      btn.setAttribute('aria-label', className === 'loading'
        ? `${text}，整体进度 ${current}%`
        : text);
    }
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || response.error) {
          reject(new Error(response && response.error || '扩展后台无响应'));
          return;
        }
        resolve(response);
      });
    });
  }

  async function handleRecordCurrentClick(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const btn = document.getElementById('resume-record-current-btn');
    if (!btn || btn.getAttribute('aria-busy') === 'true') return;
    try {
      updateButtonText(btn, '正在识别职位...', 'loading');
      const metadata = getJobPageMetadata();
      const pageContext = getApplicationPageContext();
      const core = globalThis.ApplicationRecordsCore;
      if (!core || typeof core.draftsFromJobMetadata !== 'function') {
        throw new Error('投递记录模块未加载');
      }
      const drafts = core.draftsFromJobMetadata(metadata, {
        title: document.title,
        url: location.href
      });
      updateButtonText(btn, '正在用 AI 分析页面...', 'loading');
      const result = await runtimeMessage({ type: 'OPEN_APPLICATION_RECORDS', createNew: true, drafts, pageContext });
      if (!result.ok || !result.draftId) throw new Error('未能打开投递记录确认页');
      const aiHint = result.analysis && result.analysis.status === 'success' ? '（AI分析）' : '';
      updateButtonText(btn, `已识别 ${result.draftCount || drafts.length} 个志愿${aiHint}`, '');
      setTimeout(() => updateButtonText(btn, '记录当前职位', ''), 2200);
    } catch (error) {
      updateButtonText(btn, error.message || '记录失败', 'error');
      setTimeout(() => updateButtonText(btn, '记录当前职位', ''), 3200);
    }
  }

  async function requestAIMappings(fields, profile, options = {}) {
    enhancement?.check();
    fields = enhancement?.aiFields(fields, profile) || fields;
    if (!fields.length) return { mappings: [], skippedMissing: true };
    const llmCfg = await new Promise(r => chrome.storage.local.get(['llm'], res => r(res.llm || {})));
    const isReasoningModel = /r1|o1|reason|think|thinking/i.test(llmCfg.model || '');
    const timeoutMs = isReasoningModel ? 380000 : 120000;
    return new Promise(resolve => {
      let done = false;
      let unlisten = () => {};
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        unlisten();
        resolve({ __commError: `AI 识别超时（${timeoutMs / 1000}s），请检查模型配置后重试` });
      }, timeoutMs);
      unlisten = enhancement?.onCancel(() => {
        if (done) return;
        done = true; clearTimeout(timer); resolve({ mappings: [], cancelled: true });
      }) || unlisten;
      if (done) return;
      chrome.runtime.sendMessage({
        type: 'FILL_FORM',
        fields,
        profile,
        forceRefresh: options.forceRefresh === true,
        ...(enhancement?.sessionId ? { sessionId: enhancement.sessionId, aiEnhanced: enhancement.aiEnhanced } : {})
      }, resp => {
        if (done) return;
        done = true;
        unlisten();
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ __commError: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp);
      });
    });
  }

  function mergeMappings(...groups) {
    const seen = new Set();
    const merged = [];
    for (const group of groups) {
      for (const mapping of group || []) {
        if (!mapping || !mapping.selector || seen.has(mapping.selector)) continue;
        seen.add(mapping.selector);
        merged.push(mapping);
      }
    }
    return merged;
  }

  function mergeMappingsPreferLatest(existing, updates) {
    // 同一字段本地失败后，模型可能根据页面选项返回更精确的枚举文本。
    // 最终复查应以这次成功机会更高的新映射为准，而不是保留旧的原始值。
    return mergeMappings(updates, existing);
  }

  function fieldScanIdentity(field) {
    return [
      field.recordGroupKey || field.section || '',
      Number.isInteger(field.recordIndex) ? field.recordIndex : '',
      field.label || field.placeholder || field.name || field.id || '',
      Number.isInteger(field.sameLabelIndex) ? field.sameLabelIndex : ''
    ].join('|');
  }

  function isFieldEmptyForFill(field) {
    if (enhancement?.blocked(field)) return false;
    const el = findElement(field.selector);
    if (!el) return false;
    const type = field.componentType || detectComponentType(el);
    if (type === 'native-radio' || type === 'native-checkbox') {
      // 单复选项常由网站预置第一个默认值，不能仅凭 checked 判断为用户已填写；
      // 始终参与匹配，填充函数只在目标状态不同的时候触发事件。
      return true;
    }
    if (type === 'native-select') {
      const text = el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '';
      return !el.value || /^(请选择|选择|--)/.test(text);
    }
    if (type === 'contenteditable') return !(el.textContent || '').trim();
    if (type.startsWith('custom-')) {
      const shown = getDropdownDisplayValue(el);
      return !shown || /^(请选择|选择|请输入|点击选择)/.test(shown);
    }
    const target = type === 'wrapper-input' ? el.querySelector('input:not([type="hidden"]), textarea') : el;
    return !!target && (!String(target.value || '').trim() || isPlaceholderLikeValue(target));
  }

  function attachFieldIdentities(mappings, fields) {
    const bySelector = new Map((fields || []).map(field => [field.selector, field]));
    return (mappings || []).map(mapping => {
      const field = bySelector.get(mapping.selector);
      return field ? { ...mapping, fieldIdentity: fieldScanIdentity(field) } : mapping;
    });
  }

  function combineFillResults(...results) {
    return results.reduce((combined, result) => ({
      count: combined.count + ((result && result.count) || 0),
      failed: combined.failed.concat((result && result.failed) || [])
    }), { count: 0, failed: [] });
  }

  // 同一阶段最多做两轮本地填充：第一轮填当前字段，第一轮触发的新条件字段在第二轮继续本地填。
  // 本地已经确定含义但写入后仍为空的字段也会进入模型兜底：模型可结合页面真实选项返回
  // 更贴近站点的枚举文本；最终写入仍复用同一套组件兼容逻辑，不会改变记录序号。
  async function runLocalFillPasses(initialFields, profile, onStatus, scopePredicate) {
    const inScope = typeof scopePredicate === 'function' ? scopePredicate : () => true;
    const attemptCounts = new Map();
    const allMappings = [];
    let fillResult = { count: 0, failed: [] };
    let candidates = (initialFields || []).filter(field => inScope(field) && isFieldEmptyForFill(field));

    if (!profile) return { mappings: [], fillResult, aiFields: candidates };

    for (let pass = 0; pass < 2 && candidates.length > 0; pass++) {
      enhancement?.check();
      const local = matchByLocalRules(candidates, profile);
      const annotated = attachFieldIdentities(local.mappings, candidates);
      enhancement?.note(annotated, candidates);
      const pending = annotated.filter(mapping => {
        const key = mapping.fieldIdentity || mapping.selector;
        const attempts = attemptCounts.get(key) || 0;
        // 第一轮的下拉/单选可能重建同记录内的文本控件。该字段仍为空时允许第二轮用
        // 最新 DOM 再填一次；最多两次，避免无效字段无限重复操作。
        if (!key || attempts >= 2) return false;
        attemptCounts.set(key, attempts + 1);
        return true;
      });
      if (pending.length === 0) break;

      if (onStatus) onStatus(`正在本地填写 0/${pending.length}...`);
      const result = await executeFill(pending, (done, total) => {
        if (onStatus) onStatus(`正在本地填写 ${done}/${total}...`);
      });
      fillResult = combineFillResults(fillResult, result);
      allMappings.push(...pending);

      // 等受控组件写回及条件字段渲染稳定后再复扫；仍为空的业务字段允许第二轮重新绑定
      // 当前节点并补填，已成功字段不会再进入 candidates。
      await waitForFieldLayoutStable(700, 70);
      candidates = collectFields().filter(field => inScope(field) && isFieldEmptyForFill(field));
    }

    if (onStatus) onStatus('正在复查本地结果...');
    const reviewedFields = collectFields().filter(field => inScope(field) && isFieldEmptyForFill(field));
    const reviewed = matchByLocalRules(reviewedFields, profile);
    // reviewedFields 只包含仍为空的控件，因此凡是曾经本地尝试过、现在仍在此列表中的字段，
    // 都应视为写入失败或被受控组件回滚；不能只依赖 executeFill 的即时返回值。
    const failedIdentities = new Set(allMappings.map(mapping =>
      mapping.fieldIdentity || mapping.selector
    ).filter(Boolean));
    const failedSelectors = new Set(allMappings.map(mapping => mapping.selector).filter(Boolean));
    const failedLocalFields = reviewedFields.filter(field =>
      failedIdentities.has(fieldScanIdentity(field)) || failedSelectors.has(field.selector)
    );
    const aiFields = [];
    const aiSeen = new Set();
    for (const field of reviewed.remaining.concat(failedLocalFields)) {
      const key = fieldScanIdentity(field) || field.selector;
      if (!key || aiSeen.has(key)) continue;
      aiSeen.add(key);
      aiFields.push(field);
    }
    return {
      mappings: allMappings,
      fillResult,
      aiFields
    };
  }

  function resolveMappingField(mapping, scannedFields) {
    if (mapping.fieldIdentity) {
      const current = (scannedFields || []).find(field => fieldScanIdentity(field) === mapping.fieldIdentity);
      if (current && findElement(current.selector)) return current;
    }
    return null;
  }

  function resolveMappingElement(mapping, scannedFields) {
    const current = resolveMappingField(mapping, scannedFields);
    return current ? findElement(current.selector) : findElement(mapping.selector);
  }

  function currentValuesForReview(el, componentType) {
    if (el.closest && el.closest('.phoenix-select')?.classList?.contains('phoenix-select')) {
      const selected = getDropdownDisplayValue(el);
      return selected ? [selected] : [];
    }
    const values = [];
    const direct = currentFieldValue(el);
    if (direct) values.push(String(direct));
    if (componentType === 'native-select' && el.selectedOptions && el.selectedOptions[0]) {
      values.push((el.selectedOptions[0].textContent || '').trim());
    }
    if (componentType.startsWith('custom-')) {
      const shown = getDropdownDisplayValue(el);
      if (shown) values.push(String(shown));
    }
    return values.filter((value, index, all) => value && all.indexOf(value) === index);
  }

  function expectedValuesForMapping(mapping) {
    return (Array.isArray(mapping.valueCandidates) ? mapping.valueCandidates : [mapping.value])
      .map(value => String(value == null ? '' : value).trim())
      .filter(Boolean);
  }

  function isMappingAlreadySatisfied(mapping, el, componentType) {
    if (!mapping || !el) return false;
    const expected = expectedValuesForMapping(mapping);
    if (!expected.length) return false;
    const actual = currentValuesForReview(el, componentType || mapping.componentType || detectComponentType(el));
    return actual.some(current => expected.some(value =>
      valuesEquivalent(current, value) || matchDropdownOption(current, value) > 0
    ));
  }

  // 所有填写完成后延迟复扫，确认 React/Vue 受控组件没有把刚写入的值回滚。
  async function reviewFilledMappings(mappings) {
    await sleep(120);
    const scannedFields = collectFields();
    const verified = [];
    const failed = [];
    const seen = new Set();
    for (const mapping of mappings || []) {
      if (mapping.value === null || mapping.value === undefined || mapping.value === '') continue;
      const key = mapping.fieldIdentity || mapping.selector;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const el = resolveMappingElement(mapping, scannedFields);
      if (!el) {
        failed.push(mapping);
        continue;
      }
      const componentType = mapping.componentType || detectComponentType(el);
      const expected = expectedValuesForMapping(mapping);
      const actual = currentValuesForReview(el, componentType);
      const ok = actual.some(current => expected.some(value =>
        valuesEquivalent(current, value) || matchDropdownOption(current, value) > 0
      ));
      (ok ? verified : failed).push(mapping);
      enhancement?.completed(mapping, ok);
    }
    return { count: verified.length, failed };
  }

  // ===== 点击处理 =====
  async function handleClick() {
    if (running || quickFillRunning) return; // 整页填充与点击推荐互斥
    running = true;
    const btn = document.getElementById('resume-autofill-btn');
    let ticker = null;
    let visualProgress = 0;
    const updateAutofillStatus = (text, progress, className = 'loading') => {
      if (Number.isFinite(progress)) {
        visualProgress = className === 'loading'
          ? Math.max(visualProgress, progress)                   // 后续动态复扫不得让整体进度倒退
          : Math.max(0, Math.min(100, progress));
      }
      updateButtonText(btn, text, className, visualProgress);
    };
    const updateCounterStatus = (text, start, end) => {
      const counter = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
      const progress = counter
        ? progressBetween(start, end, Number(counter[1]), Number(counter[2]))
        : start;
      updateAutofillStatus(text, progress);
    };

    try {
      // 阶段 1：读取简历数据（本地读取，很快）
      updateAutofillStatus('正在读取简历...', 5);
      const profile = await getProfile();
      await enhancement?.begin(profile);

      // 阶段 2：展开初始为空的"添加"区块 + 采集表单字段
      updateAutofillStatus('正在展开表单...', 12);
      await expandAddBlocks(profile);
      enhancement?.check();
      // React/Vue 门户可能先插入空卡片，再异步挂载其中的 input/select。字段总数稳定后再采集，
      // 否则新增的第二、第三条记录只会被计数，却不会进入本地或模型映射。
      await waitForFieldLayoutStable();
      updateAutofillStatus('正在采集字段...', 20);
      const scannedFields = collectFields();
      enhancement?.observe(scannedFields, true);

      if (scannedFields.length === 0) {
        updateAutofillStatus('未找到表单', visualProgress, 'error');
        setTimeout(() => updateButtonText(btn, '自动填充', ''), 2000);
        return;
      }
      // 保留用户已填写/浏览器已恢复的值，只处理真正为空或仍是“请输入/请选择”伪占位符的字段。
      const fields = scannedFields.filter(isFieldEmptyForFill);
      if (fields.length === 0) {
        const photoFilled = profile.basic && profile.basic.photo ? await fillPhoto(profile.basic.photo) : 0;
        updateAutofillStatus(photoFilled ? '字段已完整 · 照片已填充' : '当前字段已完整', 100, '');
        return;
      }

      // 阶段 2.5：本地映射命中后立即填写，并复扫本地填写触发的条件字段。
      // 只有复扫后仍无法由本地规则解释的空字段，才进入模型兜底。
      updateAutofillStatus(`正在本地匹配 ${fields.length} 项...`, 25);
      const localPhase = await runLocalFillPasses(fields, profile, text => {
        updateCounterStatus(text, 28, 50);
      });
      let allMappings = localPhase.mappings.slice();
      const aiFields = localPhase.aiFields;

      // 在模型填写前记录页面已有字段身份；模型选择单选/下拉后真正新增的字段再做补扫。
      const knownFieldIdentities = new Set(collectFields().map(fieldScanIdentity));

      // 阶段 3：仅识别本地复查后仍为空且无法解释的字段。
      let response = { mappings: [] };
      if (aiFields.length > 0) {
        updateAutofillStatus(`正在识别剩余 ${aiFields.length} 项...`, 52);
        let waitSec = 0;
        ticker = setInterval(() => {
          waitSec++;
          // 模型耗时不可精确预知，等待阶段只缓慢推进并在 66% 封顶，避免提前显示完成。
          updateAutofillStatus(
            `正在识别 ${aiFields.length} 项 · ${waitSec}s`,
            Math.min(66, 52 + waitSec * 0.4)
          );
        }, 1000);
        response = await requestAIMappings(aiFields, profile);
        enhancement?.check();
        enhancement?.aiResult(aiFields, response);
        if (response && !response.__commError && !response.error && !response.skippedMissing && !response.rejectedMappings?.length && !(response.mappings || []).length) {
          console.warn('[简历填充] AI 首次未返回任何映射，跳过空缓存并强制重新识别');
          updateAutofillStatus(`AI 未返回映射，正在重新识别 ${aiFields.length} 项...`, Math.max(visualProgress, 58));
          response = await requestAIMappings(aiFields, profile, { forceRefresh: true });
          enhancement?.check();
          enhancement?.aiResult(aiFields, response);
        }
        clearInterval(ticker);
        ticker = null;
        if (!response) response = { mappings: [], __commError: '模型无响应' };
        if (!response.__commError && !response.error && !response.skippedMissing && !response.rejectedMappings?.length && !(response.mappings || []).length) {
          response.__emptyResult = true;
          console.warn('[简历填充] AI 重试后仍未返回映射，字段数:', aiFields.length);
        }
      }

      if (response.__commError || response.error) {
        console.warn('[简历填充] 模型兜底不可用，本地结果仍保留:', response.__commError || response.error);
      } else {
        const aiMappings = attachFieldIdentities(response.mappings || [], aiFields);
        if (aiMappings.length > 0) {
          updateAutofillStatus(`正在填写模型结果 0/${aiMappings.length}...`, 68);
          const aiResult = await executeFill(aiMappings, (done, total) => {
            updateAutofillStatus(
              `正在填写模型结果 ${done}/${total}...`,
              progressBetween(68, 80, done, total)
            );
          });
          allMappings = mergeMappingsPreferLatest(allMappings, aiMappings);
        }
      }

      // 模型选择单选/下拉后页面可能新增条件字段。新增字段仍然严格执行：
      // 本地立即填写并复查 → 仅剩余项调用模型 → 填写模型结果。
      updateAutofillStatus('正在检查动态字段...', 82);
      await sleep(80);
      const isSupplemental = field => !knownFieldIdentities.has(fieldScanIdentity(field));
      const supplementalFields = collectFields().filter(field => isSupplemental(field) && isFieldEmptyForFill(field));
      let supplementalResponse = { mappings: [] };
      if (supplementalFields.length > 0) {
        updateAutofillStatus(`正在本地匹配新增 ${supplementalFields.length} 项...`, 84);
        const supplementalLocalPhase = await runLocalFillPasses(
          supplementalFields,
          profile,
          text => updateCounterStatus(text.replace('正在本地填写', '正在本地填写新增'), 84, 90),
          isSupplemental
        );
        allMappings = mergeMappings(allMappings, supplementalLocalPhase.mappings);

        const supplementalAIFields = supplementalLocalPhase.aiFields;
        if (supplementalAIFields.length > 0) {
          updateAutofillStatus(`正在识别新增 ${supplementalAIFields.length} 项...`, 91);
          supplementalResponse = await requestAIMappings(supplementalAIFields, profile);
          enhancement?.check();
          enhancement?.aiResult(supplementalAIFields, supplementalResponse);
          if (supplementalResponse && !supplementalResponse.__commError && !supplementalResponse.error &&
              !supplementalResponse.skippedMissing && !supplementalResponse.rejectedMappings?.length && !(supplementalResponse.mappings || []).length) {
            updateAutofillStatus(`AI 未返回新增字段映射，正在重试 ${supplementalAIFields.length} 项...`, 92);
            supplementalResponse = await requestAIMappings(supplementalAIFields, profile, { forceRefresh: true });
            enhancement?.check();
            enhancement?.aiResult(supplementalAIFields, supplementalResponse);
          }
          if (!supplementalResponse) supplementalResponse = { mappings: [], __commError: '模型无响应' };
          if (!supplementalResponse.__commError && !supplementalResponse.error &&
              !supplementalResponse.skippedMissing && !supplementalResponse.rejectedMappings?.length && !(supplementalResponse.mappings || []).length) {
            supplementalResponse.__emptyResult = true;
          }
          if (!supplementalResponse.__commError && !supplementalResponse.error) {
            const supplementalMappings = attachFieldIdentities(supplementalResponse.mappings || [], supplementalAIFields);
            if (supplementalMappings.length > 0) {
              updateAutofillStatus(`正在补充填写 0/${supplementalMappings.length}...`, 92);
              const extra = await executeFill(supplementalMappings, (done, total) => {
                updateAutofillStatus(
                  `正在补充填写 ${done}/${total}...`,
                  progressBetween(92, 95, done, total)
                );
              });
              allMappings = mergeMappingsPreferLatest(allMappings, supplementalMappings);
            }
          } else {
            console.warn('[简历填充] 动态字段模型兜底失败:', supplementalResponse.__commError || supplementalResponse.error);
          }
        }
      }

      // 证件照单独填充（file 类型不入 AI 字段流，独立处理）
      updateAutofillStatus('正在复查页面填写结果...', 97);
      let photoFilled = 0;
      if (profile.basic && profile.basic.photo) {
        enhancement?.check();
        photoFilled = await fillPhoto(profile.basic.photo);
      }
      const reviewed = await reviewFilledMappings(allMappings);
      const count = reviewed.count;
      const partialAI = (response.failedChunks && response.failedChunks.length > 0) || response.truncatedCount > 0 ||
                        (supplementalResponse.failedChunks && supplementalResponse.failedChunks.length > 0) || supplementalResponse.truncatedCount > 0;
      const hasUnverified = reviewed.failed.length > 0 || partialAI ||
                            response.__commError || response.error || response.__emptyResult ||
                            supplementalResponse.__commError || supplementalResponse.error || supplementalResponse.__emptyResult;
      if (count === 0 && photoFilled === 0) {
        updateAutofillStatus('未匹配到可填充字段', 100, 'error');
        setTimeout(() => updateButtonText(btn, '自动填充', ''), 3000);
      } else if (hasUnverified) {
        const aiIssue = response.__commError || response.error || supplementalResponse.__commError || supplementalResponse.error;
        const aiEmpty = response.__emptyResult || supplementalResponse.__emptyResult;
        updateAutofillStatus(
          aiIssue
            ? `本地已填 ${count} 个 · AI补填失败，请检查模型配置`
            : aiEmpty
              ? `本地已填 ${count} 个 · AI未返回剩余映射`
              : `部分完成：复查通过 ${count} 个，请检查未填项`,
          100,
          'error'
        );
      } else {
        updateAutofillStatus(photoFilled > 0
          ? `已复查填充 ${count} 个字段 · 照片已填充`
          : `已复查填充 ${count} 个字段`, 100, '');
      }
    } catch (err) {
      if (err.name === 'ResumeFillStopped') {
        await closeAllPanels();
        updateAutofillStatus('已停止 · 查看填写结果', visualProgress, '');
        return;
      }
      updateAutofillStatus('出错了', visualProgress, 'error');
      console.error('[简历填充]', err);
      setTimeout(() => updateButtonText(btn, '自动填充', ''), 3000);
    } finally {
      if (ticker) clearInterval(ticker);
      running = false;
      enhancement?.finish();
    }
  }

  // ===== 通用组件类型检测（行为驱动） =====
  function detectComponentType(el) {
    const tag = el.tagName.toLowerCase();

    // 1. contenteditable 元素
    if (el.isContentEditable && tag !== 'input' && tag !== 'textarea') return 'contenteditable';
    if (el.getAttribute('role') === 'textbox') return 'contenteditable';

    // 2. 原生元素优先
    if (tag === 'select') return 'native-select';
    if (tag === 'textarea') return 'native-input';
    if (tag === 'input') {
      const inputType = (el.type || '').toLowerCase();
      if (inputType === 'radio') return 'native-radio';
      if (inputType === 'checkbox') return 'native-checkbox';
      if (['date', 'month', 'week', 'datetime-local'].includes(inputType) && !el.readOnly) return 'native-input';
      // 只读输入框多为自定义下拉/级联/日期组件的展示层：原生 setter 填值不会触发框架更新，
      // 必须走组件交互。先判日期（如 B 站 bili-date），再判下拉。
      if (el.readOnly) {
        if (hasDatepickerBehavior(el)) return 'custom-datepicker';
        if (hasDropdownBehavior(el)) return 'custom-dropdown';
        // 只读但无任何行为信号：仍是自定义组件，标记为可交互类型，填充时打开面板探测
        return 'custom-interactive';
      }
      // 非只读 input 也可能是自定义组件（如 Moka sd-Select 内部 input 非 readonly）：
      // placecholder="请选择" 或容器含 select/dropdown 关键词 → 自定义下拉；
      // picker-addon 子元素或日期占位符 → 自定义日期选择器（日期优先判，避免被下拉的 picker 关键词劫持）
      if (hasDatepickerBehavior(el)) return 'custom-datepicker';
      if (hasDropdownBehavior(el)) return 'custom-dropdown';
      return 'native-input';
    }

    // 3. 通用下拉框检测（不依赖框架名）
    if (hasDropdownBehavior(el)) return 'custom-dropdown';

    // 4. 日期选择器检测
    if (hasDatepickerBehavior(el)) return 'custom-datepicker';

    // 5. 内含 input 的容器（通用自定义输入框）
    const innerInput = el.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
    if (innerInput) return 'wrapper-input';

    return 'unknown';
  }

  // 通用下拉行为检测
  function hasDropdownBehavior(el) {
    // ARIA 语义
    if (el.getAttribute('aria-haspopup') === 'listbox' ||
        el.getAttribute('aria-haspopup') === 'dialog' ||
        el.getAttribute('role') === 'combobox') return true;
    // 类名中的通用模式（匹配任何框架）—— 子串匹配，不用 \b 词边界：
    // CSS Modules / hash 类名用 _ 或 - 分隔（如 sd-Select-container、date_info），
    // \b 会把 _ 当单词字符 → \bselect\b 漏掉 sd_Select
    const cls = (typeof el.className === 'string') ? el.className : '';
    // 兼容旧招聘系统常见的缩写类名（如中国移动的 .slt / .slt240）
    if (/(^|\s)slt(?:\d+)?(?:\s|$)/i.test(cls)) return true;
    if (el.tagName.toLowerCase() !== 'select' && /select|dropdown|combo|picker|cascader/i.test(cls)) return true;
    // 自身不匹配时检查最近祖先容器（如 Moka input 在 sd-Select-container 内，自身类名不含 select）
    const anc = el.closest('[class*="select"], [class*="picker"], [class*="dropdown"], [class*="cascader"], [role="combobox"]');
    if (anc) return true;
    // placeholder 信号："请选择" 强烈暗示为下拉
    if ((el.placeholder || '').includes('请选择')) return true;
    // 有展开状态的元素
    if (el.getAttribute('aria-expanded') !== null) return true;
    return false;
  }

  // 通用日期选择器行为检测
  // 注：不用 \b 词边界，因为 date_info / sd-picker-addon 等 _ 和 - 都是 word 字符，
  // \b 会漏掉这些模式。用宽松子串匹配，但必须与 readonly / date 占位符 / picker-addon
  // 子元素联合使用，避免将普通输入框误判为日期选择器（detectComponentType 做最终裁决）
  function hasDatepickerBehavior(el) {
    if (!el) return false;
    if (getPhoenixDateTrigger(el)) return true;
    const tag = (el.tagName || '').toLowerCase();
    const inputType = tag === 'input' ? String(el.type || '').toLowerCase() : '';
    if (['date', 'month', 'week', 'datetime-local'].includes(inputType)) return true;
    const cls = (typeof el.className === 'string') ? el.className : '';
    if (/(^|\s)date[-_]?slt(?:\s|$)/i.test(cls)) return true;
    // 自身类名含强日期信号（不用裸 date/picker，避免 candidate/updated/select 误判）
    if (/datepicker|date-picker|date_info|calendar|picker-addon|日历|时间选择/i.test(cls)) return true;
    // 现代组件库通常只在通用 picker 容器上体现日期语义，input 自身可能只有 ant-input/el-input。
    // 这些框架级类名是强信号，不会把普通 select/dropdown 误判成日期。
    if (/(^|\s)(?:ant-(?:calendar-)?picker|el-date-editor|arco-picker)(?:\S*)?(?:\s|$)/i.test(cls)) return true;
    // 子元素含 picker-addon / calendar / datepicker 图标（如 Moka sd-picker-addon）
    if (el.querySelector('[class*="picker-addon"], [class*="calendar"], [class*="datepicker"], [class*="date-picker"]')) return true;
    // placeholder/ARIA/name 同时包含“选择动作 + 日期语义”时视为日期组件。
    // “请选择毕业时间”此前只命中下拉规则，导致日期值被按 option 文本搜索并静默失败。
    const signal = [
      el.placeholder || '',
      el.getAttribute && (el.getAttribute('aria-label') || ''),
      el.getAttribute && (el.getAttribute('name') || '')
    ].join(' ').toLowerCase();
    const hasDateWord = /出生|生日|入学|毕业|开始|结束|到岗|入职|离职|获奖|获得|颁发|发表|考试|日期|年月|birth|date|month|year/.test(signal);
    const hasPickerWord = /请选择|选择|pick|select|日期|时间|年月|date|month|year/.test(signal);
    if (hasDateWord && hasPickerWord) return true;
    // 容器类名含强日期模式（如 month-range-select date_info）
    const anc = el.closest(
      '[class*="datepicker"], [class*="date-picker"], [class*="date_info"], [class*="calendar"], [class*="picker-addon"], ' +
      '[class*="ant-picker"], [class*="el-date-editor"], [class*="arco-picker"], [data-picker*="date"], [data-type*="date"]'
    );
    if (anc) return true;
    // 内含 input 且自身类名含 date/time（保留原有，放宽正则）
    if (el.querySelector('input') && /date|time/i.test(cls)) return true;
    return false;
  }

  // ===== 通用字段采集引擎（三轮扫描） =====
  function getChoiceGroupElements(el) {
    const type = (el.type || '').toLowerCase();
    if (el.name) {
      return Array.from(document.querySelectorAll(`input[type="${type}"]`)).filter(x => x.name === el.name);
    }
    const container = el.closest('fieldset, [role="radiogroup"], [role="group"], dl, [class*="form-item"], [class*="form-group"], [class*="field"], [class*="row"]') || el.parentElement;
    return container ? Array.from(container.querySelectorAll(`input[type="${type}"]`)) : [el];
  }

  function getChoiceOptionText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.textContent.trim()) return label.textContent.trim();
    }
    const wrapped = el.closest('label');
    if (wrapped) {
      const clone = wrapped.cloneNode(true);
      clone.querySelectorAll('input').forEach(x => x.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }
    const next = el.nextElementSibling;
    if (next && next.tagName === 'LABEL') {
      const text = next.textContent.trim();
      if (text) return text;
    }
    return (el.getAttribute('data-label') || el.getAttribute('aria-label') || el.getAttribute('data-code') || (el.value === 'on' ? '' : el.value) || '').trim();
  }

  function isChoiceVisible(el) {
    if (isVisible(el)) return true;
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && isVisible(label)) return true;
    }
    const wrapped = el.closest('label');
    return !!(wrapped && isVisible(wrapped));
  }

  function getChoiceGroupLabel(el) {
    const semanticGroup = el.getAttribute('data-label') || el.getAttribute('msg');
    if (semanticGroup && semanticGroup.trim()) return semanticGroup.trim();
    const dl = el.closest('dl');
    if (dl) {
      const dt = dl.querySelector(':scope > dt');
      if (dt) {
        const text = dt.textContent.trim().replace(/[：:*＊\s?]+$/, '');
        if (text) return text;
      }
    }
    const group = el.closest('fieldset, [role="radiogroup"], [role="group"], [class*="form-item"], [class*="form-group"], [class*="field"]');
    if (group) {
      const label = group.querySelector('legend, [class*="label"], label:not([for])');
      if (label) {
        const text = label.textContent.trim().replace(/[：:*＊\s?]+$/, '');
        if (text) return text;
      }
    }
    return getContextText(el) || el.name || '';
  }

  // 验证码/一次性口令属于安全动作字段，不是简历信息。它们必须在字段采集、
  // 本地匹配和点击快速填充之前被排除，避免“手机验证码”因为包含“手机”而误填手机号。
  // 不使用裸“代码/编码”作为关键词，以免误伤证件号、邮政编码、学校代码等简历字段。
  const SECURITY_FIELD_RE = /验证码|校验码|短信码|动态码|图形码|安全码|认证码|一次性(?:密码|口令|代码)|(?:sms|otp|captcha)[\s_-]*(?:code|token)?|(?:verification|verify|security|auth)[\s_-]*(?:code|token)|one[\s_-]*time[\s_-]*(?:code|password)/i;

  function getDirectFieldSemanticText(el) {
    if (!el) return '';
    const inner = el.querySelector && el.querySelector('input, textarea, select');
    const nodes = inner && inner !== el ? [el, inner] : [el];
    const parts = [getLabelText(el), getPlaceholder(el)];
    for (const node of nodes) {
      parts.push(
        node.getAttribute && node.getAttribute('name'),
        node.id,
        node.getAttribute && node.getAttribute('aria-label'),
        node.getAttribute && node.getAttribute('aria-describedby'),
        node.getAttribute && node.getAttribute('autocomplete'),
        node.getAttribute && node.getAttribute('msg'),
        node.getAttribute && node.getAttribute('data-label'),
        node.getAttribute && node.getAttribute('data-field'),
        node.getAttribute && node.getAttribute('data-testid')
      );
    }
    return parts.filter(Boolean).join(' ');
  }

  function findSeenInnerNativeField(el, seen) {
    if (!el || !el.querySelectorAll || !seen) return null;
    const innerFields = el.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'
    );
    return Array.from(innerFields).find(inner => seen.has(inner)) || null;
  }

  function isBlockedAutofillField(el) {
    if (!el) return false;
    const direct = getDirectFieldSemanticText(el);
    if (SECURITY_FIELD_RE.test(direct)) return true;

    const inner = (el.matches && el.matches('input, textarea'))
      ? el
      : (el.querySelector && el.querySelector('input, textarea'));
    if (!inner) return false;
    const autocomplete = (inner.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete === 'one-time-code') return true;

    // 某些站点只在同一表单行写“验证码”，输入框本身仅有 maxlength/inputmode。
    // 仅对 4~8 位短码使用邻近上下文兜底，避免把同一行的正常手机号框误排除。
    const maxLength = Number(inner.getAttribute('maxlength') || inner.maxLength || 0);
    const shortCodeLike = maxLength >= 4 && maxLength <= 8;
    return shortCodeLike && SECURITY_FIELD_RE.test(getContextText(el));
  }

  function scanFieldElements() {
    const elements = [];
    const seen = new Set();
    const seenChoices = new WeakSet();

    function push(el) {
      if (seen.has(el)) return;
      seen.add(el);
      elements.push(el);
    }

    // 第一轮：原生表单元素
    document.querySelectorAll('input, select, textarea').forEach(el => {
      const type = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'file', 'password', 'search', 'range', 'color'].includes(type)) return;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      if (isBlockedAutofillField(el)) return;
      if (type === 'radio' || type === 'checkbox') {
        if (!isChoiceVisible(el)) return;
      } else if (!isVisible(el)) return;
      if (el.closest('#resume-autofill-actions')) return;
      if (type === 'radio' || type === 'checkbox') {
        if (seenChoices.has(el)) return;
        const group = getChoiceGroupElements(el);
        group.forEach(x => seenChoices.add(x));
      }
      push(el);
    });

    // 第二轮：自定义组件（ARIA 语义 + 类名模式 + contenteditable）
    const customSelectors = [
      '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]', '[role="spinbutton"]',
      '[contenteditable="true"]', '[contenteditable=""]',
      '[aria-haspopup="listbox"]', '[aria-haspopup="dialog"]',
      '[class*="select"]:not(select)', '[class*="dropdown"]:not([role="menu"])',
      '[class*="combobox"]', '[class*="picker"]', '[class*="cascader"]',
      '[class~="slt"]', '[class*="dateSlt"]', '[class*="date-slt"]', '[class*="date_slt"]'
    ];
    document.querySelectorAll(customSelectors.join(',')).forEach(el => {
      if (!isVisible(el)) return;
      if (el.getAttribute('aria-disabled') === 'true' || /(^|\s)(?:is-)?disabled(\s|$)/i.test(typeof el.className === 'string' ? el.className : '')) return;
      if (isBlockedAutofillField(el)) return;
      if (el.closest('#resume-autofill-actions')) return;
      // 如果内部原生 input / textarea / select 已采集，跳过外层容器。Bootstrap-select
      // 会同时渲染 select 和按钮容器；重复采集会让原生控件本地映射后，外层容器又进入 AI。
      if (findSeenInnerNativeField(el, seen)) return;
      // 嵌套在更大下拉容器内的内部零件（ant 的箭头/图标/选区等），只保留最外层容器，
      // 避免 AI 把值映射到 .ant-select-arrow / .ant-select-arrow-icon 这类装饰元素上
      if (el.parentElement && el.parentElement.closest(customSelectors.join(','))) return;
      push(el);
    });

    // 第三轮：框架绑定的隐藏字段（Vue/React/Angular）
    document.querySelectorAll('[data-field], [formcontrolname], [v-model], [ng-model], [formControlName]').forEach(el => {
      if (!isVisible(el) || seen.has(el) || isBlockedAutofillField(el)) return;
      push(el);
    });

    return elements;
  }

  function collectFields() {
    const fields = [];
    const collected = new Set();
    const recordCaches = { fingerprints: new WeakMap() };
    for (const el of scanFieldElements()) {
      addField(el, collected, fields, recordCaches);
    }
    annotateRepeatedFieldPositions(fields);
    return fields;
  }

  // 同时记录“全页同名序号”和“当前经历条目内同名序号”。后者用于识别一条记录中
  // 两个都只标为“时间”的日期框：第一个是开始时间，第二个是结束时间。
  function annotateRepeatedFieldPositions(fields) {
    // 给同标签字段标注序号（第 N 个同标签字段）与总数，帮助 LLM 识别多条目记录并按序分配
    const labelTotal = new Map();
    for (const f of fields) {
      const key = (f.label || f.placeholder || f.name || '').trim();
      if (key) labelTotal.set(key, (labelTotal.get(key) || 0) + 1);
    }
    const labelSeen = new Map();
    for (const f of fields) {
      const key = (f.label || f.placeholder || f.name || '').trim();
      if (key) {
        f.sameLabelIndex = labelSeen.get(key) || 0;
        f.sameLabelTotal = labelTotal.get(key);
        labelSeen.set(key, (labelSeen.get(key) || 0) + 1);
      }
    }

    const recordLabelTotal = new Map();
    const recordLabelKey = field => {
      const labelKey = (field.label || field.placeholder || field.name || '').trim();
      if (!labelKey) return '';
      if (Number.isInteger(field.recordIndex)) {
        return `${field.recordGroupKey || field.recordGroup || field.section || ''}|${field.recordIndex}|${labelKey}`;
      }
      // 页面只有一条经历时通常不存在可对比的兄弟记录，getRecordContext 无法提供
      // recordIndex；此时按区块标题统计同名字段，仍可识别成对的起止时间。
      const sectionKey = (field.section || field.recordGroup || '').trim();
      return sectionKey ? `section:${sectionKey}|${labelKey}` : '';
    };
    for (const field of fields) {
      const key = recordLabelKey(field);
      if (key) recordLabelTotal.set(key, (recordLabelTotal.get(key) || 0) + 1);
    }
    const recordLabelSeen = new Map();
    for (const field of fields) {
      const key = recordLabelKey(field);
      if (!key) continue;
      field.recordSameLabelIndex = recordLabelSeen.get(key) || 0;
      field.recordSameLabelTotal = recordLabelTotal.get(key);
      recordLabelSeen.set(key, (recordLabelSeen.get(key) || 0) + 1);
    }
    return fields;
  }

  function addField(el, collected, fields, recordCaches) {
    if (collected.has(el)) return;
    collected.add(el);
    if (isBlockedAutofillField(el)) return;

    const selector = generateSelector(el);
    if (!selector) return;

    const componentType = detectComponentType(el);
    const isChoice = componentType === 'native-radio' || componentType === 'native-checkbox';
    const field = {
      selector, componentType,
      tag: el.tagName.toLowerCase(),
      label: isChoice ? getChoiceGroupLabel(el) : getLabelText(el),
      placeholder: getPlaceholder(el),
      name: el.name || el.getAttribute('name') || el.getAttribute('formcontrolname') || '',
      id: el.id || '',
      autocomplete: el.getAttribute('autocomplete') || el.querySelector('input, textarea')?.getAttribute('autocomplete') || '',
      contextText: getContextText(el),
      section: getSectionTitle(el),
      required: isRequired(el)
    };

    const record = getRecordContext(el, recordCaches);
    if (record) {
      field.recordIndex = record.index;
      field.recordTotal = record.total;
      field.recordGroup = record.group;
      if (record.groupKey) field.recordGroupKey = record.groupKey;
    }

    // 采集可选项
    if (el.tagName.toLowerCase() === 'select') {
      field.options = Array.from(el.options).map(o => o.textContent.trim()).filter(Boolean);
    }
    if (isChoice) {
      field.options = getChoiceGroupElements(el).map(getChoiceOptionText).filter(Boolean);
      field.multiple = componentType === 'native-checkbox';
    }

    // 尝试从已渲染的下拉面板采集选项
    if (componentType === 'custom-dropdown' || componentType === 'native-select') {
      const opts = collectDropdownOptions(el);
      if (opts.length > 0) field.options = opts;
    }

    // 弱字段过滤：只有 contextText 且无可选项的字段最弱（多为卡片标题/装饰 div 噪声），
    // 丢弃降噪；带 options 的 contextText-only 几乎必是真下拉/单选，保留。
    // 有 label/placeholder/name/id 的强信号字段一律保留。旧招聘系统常只有 id + dl/dt 上下文，
    // 将 id 纳入可识别信号可避免这类真实输入框在送给本地规则/AI 前被静默丢弃。
    const hasStrong = field.label || field.placeholder || field.name || field.id;
    const hasOptions = field.options && field.options.length > 0;
    if (hasStrong || (field.contextText && hasOptions)) fields.push(field);
  }

  // 通用可选项采集（只从与当前字段关联的下拉面板采集）
  function collectDropdownOptions(containerEl) {
    // 优先从容器内部采集（原生 select 或自定义组件内的选项）
    const cls = typeof containerEl.className === 'string' ? containerEl.className : '';
    const legacy = /(^|\s)slt(?:\d+)?(?:\s|$)/i.test(cls);
    const innerOpts = containerEl.querySelectorAll(legacy
      ? 'option, [role="option"], [class*="option"], li'
      : 'option, [role="option"], [class*="option"]');
    if (innerOpts.length > 0) {
      const opts = new Set();
      innerOpts.forEach(opt => {
        const text = (opt.textContent || opt.value || '').trim();
        if (text && text.length < 50) opts.add(text);
      });
      if (opts.size > 0) return Array.from(opts);
    }
    // 兜底：从菜单容器内采集叶子文本节点（如 Moka sd-Select-menu 裸 span 无 role/class）
    const menuContainers = containerEl.querySelectorAll('[class*="menu"], [class*="select"] [class*="menu"], [class*="dropdown"]');
    for (const menu of menuContainers) {
      const leaves = menu.querySelectorAll('*');
      const texts = new Set();
      for (const leaf of leaves) {
        // 跳过装饰性元素（箭头/图标/空元素）和含子元素的容器
        if (leaf.children.length > 0) continue;
        if (/arrow|icon|caret|clear|close|remove/i.test((typeof leaf.className === 'string' ? leaf.className : '') || '')) continue;
        const text = (leaf.textContent || '').trim();
        if (text && text.length > 0 && text.length < 50) texts.add(text);
      }
      if (texts.size > 0) return Array.from(texts);
    }
    return [];
  }

  // ===== 展开"添加"区块（工作/教育/项目等初始为空时） =====
  // “新增一条 / 新建 / 创建 / 补充 / 录入”等都视为创建动作；中英文词与全角加号统一识别。
  const ADD_WORDS = /添加|新增|增加|新建|创建|补充|录入|\b(?:add|new|create|append|insert)\b|[+＋](?!\d)/i;
  const OPEN_WORDS = /展开|完善|填写|编辑|\b(?:expand|open|edit)\b/i;
  const ADD_TRIGGER_WORDS = /添加|新增|增加|新建|创建|补充|录入|\b(?:add|new|create|append|insert|expand|open|edit)\b|[+＋](?!\d)|展开|完善|填写|编辑/i;
  const MAX_AUTO_ADD_PER_SECTION = 20;
  const ADD_SECTION_RULES = [
    { key: 'education', re: /教育|学习经历|学校经历|求学经历|教育背景|学历信息|education|academic/i },
    { key: 'work', re: /工作经历|实习经历|任职经历|职业经历|就业经历|从业经历|实践经历|工作经验|实习经验|工作情况|实习情况|工作信息|实习信息|work|intern|employment|experience/i },
    { key: 'projects', re: /项目|课题|研究经历|科研项目|project|research experience/i },
    { key: 'campusDuties', re: /校内职务|校园经历|校园活动|学生工作|学生干部|社团经历|社会实践|campus|student activit|student work/i },
    { key: 'computerSkills', re: /计算机技能|IT技能|编程技能|技术技能|computer skill|technical skill|programming skill/i },
    // 专利必须在论文之前，不能让“专利发表”被通用“发表”误识别为论文。
    { key: 'patents', re: /专利|发明成果|patent|invention/i },
    { key: 'papers', re: /论文|期刊|会议发表|学术成果|科研成果|publication|paper|journal|conference/i },
    { key: 'awards', re: /奖励|奖项|获奖|荣誉|奖学金|表彰|award|honou?r|scholarship/i },
    { key: 'families', re: /家庭|亲属|家属|家庭成员|社会关系|family|relative/i },
    { key: 'languages', re: /语言能力|语言水平|语言情况|语言信息|外语|英语能力|英语水平|语种|language|english/i },
    { key: 'certificates', re: /资格证书|职业资格|技能证书|计算机证书|证照|证书|认证|certificate|certification|credential/i },
    { key: 'skills', re: /专业技能|技能特长|其他技能|skills?/i }
  ];

  function profileKeyFromSectionText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const matched = ADD_SECTION_RULES.find(rule => rule.re.test(normalized));
    return matched ? matched.key : null;
  }

  function getAddButtonContext(btn, section) {
    const pieces = [
      btn.textContent || '',
      btn.value || '',
      btn.getAttribute('aria-label') || '',
      btn.getAttribute('title') || '',
      btn.getAttribute('data-label') || '',
      btn.id || '',
      typeof btn.className === 'string' ? btn.className : ''
    ];
    let current = section || btn.parentElement;
    for (let depth = 0; depth < 6 && current && current !== document.body; depth++, current = current.parentElement) {
      pieces.push(current.getAttribute && (current.getAttribute('aria-label') || current.getAttribute('title') || current.getAttribute('data-section') || '') || '');
      pieces.push(current.id || '', typeof current.className === 'string' ? current.className : '');
      const heading = current.querySelector && current.querySelector('h1, h2, h3, h4, h5, h6, legend, [class*="title"], [class*="header"]');
      if (heading && (heading.textContent || '').trim().length < 100) pieces.push(heading.textContent);
      const text = (current.textContent || '').trim();
      if (text && text.length < 400) pieces.push(text);
      if (profileKeyFromSectionText(pieces.join(' '))) break;
    }
    return pieces.join(' ');
  }

  // 标准交互控件先识别；若框架只在普通 div/span 上绑定事件，下面再按短动作文案兜底。
  const ADD_CONTROL_SELECTOR = 'button, [role="button"], a, input[type="button"], input[type="submit"], [onclick], [class*="add" i], [class*="plus" i], [class*="create" i], [class*="new" i]';
  const ADD_TEXT_FALLBACK_SELECTOR = 'span, div, p, li';

  function getAddControlText(el) {
    return [
      el.textContent || '',
      el.value || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-label') || ''
    ].join(' ').trim();
  }

  function isAddTriggerText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 && normalized.length <= 100 && ADD_TRIGGER_WORDS.test(normalized);
  }

  function addControlPriority(el) {
    const tag = String(el.tagName || '').toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    let score = /^(button|a|input)$/.test(tag) || el.getAttribute('role') === 'button' || el.hasAttribute('onclick') ? 100 : 0;
    if (/add|plus|create|new/i.test(cls)) score += 60;
    for (let current = el; current && current.parentElement; current = current.parentElement) score++;
    return score;
  }

  function getAddControlCandidates(root) {
    const result = [];
    const seen = new Set();
    const add = el => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      result.push(el);
    };
    if (root.matches && root.matches(ADD_CONTROL_SELECTOR)) add(root);
    root.querySelectorAll(ADD_CONTROL_SELECTOR).forEach(add);
    // 普通文字节点也允许作为点击目标：click 会冒泡到 React/Vue 绑定事件的父容器。
    root.querySelectorAll(ADD_TEXT_FALLBACK_SELECTOR).forEach(el => {
      if (seen.has(el) || !isAddTriggerText(getAddControlText(el))) return;
      if (el.querySelector && el.querySelector('input, textarea, select, [contenteditable="true"]')) return;
      add(el);
    });
    return result.sort((left, right) => addControlPriority(right) - addControlPriority(left));
  }

  function findAddButtons(max) {
    const candidates = getAddControlCandidates(document);
    const result = [];
    for (const el of candidates) {
      const combo = getAddControlText(el);
      if (!isAddTriggerText(combo)) continue;
      // 按钮可能只有“+ 添加/展开”，必须结合所属区块标题判断类型。
      const ctx = getAddButtonContext(el);
      // ADD_SECTION_RULES 是区块识别的唯一来源。之前这里还有一套 SECTION_WORDS
      // 二次过滤，但它漏掉了“学术成果”，造成明明映射为 papers 仍被拒绝点击。
      if (!profileKeyFromSectionText(ctx)) continue;
      if (!isVisible(el)) continue;    // 布局读取放到最后，只对已命中的少数候选执行
      result.push(el);
      if (max && result.length >= max) break;
    }
    return result;
  }

  // 最近"像区块"的祖先（真实页命中 .bili-form-card-body 的 card）
  function getSectionContainer(btn) {
    const beisen = getBeisenSectionInfo(btn);
    if (beisen) return beisen.container;
    let el = btn.parentElement;
    for (let i = 0; i < 5 && el && el !== document.body; i++, el = el.parentElement) {
      const cls = (typeof el.className === 'string') ? el.className : '';
      if (/section|block|card|item|group/.test(cls)) return el;
      const text = (el.textContent || '');
      if (text.length < 400 && profileKeyFromSectionText(text)) return el;
    }
    return btn.parentElement || btn;
  }

  // 简历某区块应有的条目数（数组取 length；语言等换行字符串按行计数）
  function profileEntryCount(profile, key) {
    if (!key || !profile) return 0;
    const v = profile[key];
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'string' && v.trim()) return v.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
    return 0;
  }

  // 区块内已渲染的经历块数：结构信号优先（块容器 class），标签频次兜底
  function countBlocksInSection(section) {
    const fields = section.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"]), select, textarea');
    const visible = [];
    for (const el of fields) if (isVisible(el)) visible.push(el);
    if (visible.length === 0) return 0;

    // 1) 结构信号：字段归到最近的"块容器"，只认含 >=2 个可见字段的容器，去重容器数即块数
    const BLOCK_RE = /multiple|block|entry|record|item|group/i;
    const containerCounts = new Map();
    for (const el of visible) {
      let a = el.parentElement;
      for (let i = 0; i < 5 && a && a !== section && a !== document.body; i++, a = a.parentElement) {
        const cls = (typeof a.className === 'string') ? a.className : '';
        if (BLOCK_RE.test(cls)) {
          containerCounts.set(a, (containerCounts.get(a) || 0) + 1);
          break;
        }
      }
    }
    const multiFieldBlocks = Array.from(containerCounts.values()).filter(c => c >= 2);
    if (multiFieldBlocks.length > 0) return multiFieldBlocks.length;

    // 单个字段但区块内仍有明确“添加”按钮时，通常是证书/语言等单字段重复记录，可继续扩容；
    // 没有添加按钮的 textarea 才视为“一框多行”，不能按行数凭空新增输入框。
    if (visible.length === 1) return findAddButtonInSection(section) ? 1 : -1;

    // 2) 兜底：重复条目复用同一套标签 → 出现最多的标签次数 ≈ 块数
    const freq = new Map();
    for (const el of visible) {
      const label = getLabelText(el);
      if (!label) continue;
      freq.set(label, (freq.get(label) || 0) + 1);
    }
    if (freq.size === 0) return 1;   // 标签不可读 → 保守认为已有 1 块
    return Math.max(...freq.values());
  }

  // “新增”按钮经常位于记录列表末尾的独立小卡片中。getSectionContainer 只会拿到
  // 这个小卡片，直接在其中计数会把页面已经存在的记录误判为 0。向上寻找同时包含
  // 当前数据类型和可填写字段的最小祖先，才能把已有记录与新增按钮放在同一计数范围。
  function getProfileSectionContainer(btn, key) {
    const beisen = getBeisenSectionInfo(btn);
    if (beisen) return beisen.container;
    const fallback = getSectionContainer(btn);
    let current = btn && btn.parentElement;
    for (let depth = 0; depth < 9 && current && current !== document.body; depth++, current = current.parentElement) {
      const fields = current.querySelectorAll && current.querySelectorAll(RECORD_WRITABLE_SELECTOR);
      if (!fields || fields.length === 0) continue;
      const text = [
        current.getAttribute && (current.getAttribute('aria-label') || current.getAttribute('title') || current.getAttribute('data-section') || ''),
        current.textContent || ''
      ].join(' ');
      const matchedKeys = ADD_SECTION_RULES.filter(rule => rule.re.test(text)).map(rule => rule.key);
      if (matchedKeys.length === 1 && matchedKeys[0] === key) return current;
    }
    return fallback;
  }

  // 根据字段描述计算页面上同一类记录的真实条数。重复容器可识别时优先使用
  // recordTotal / recordIndex；门户结构不规则时，再用同一语义字段的重复次数兜底。
  // 例如两条论文都有一个“论文名称”，即使两张卡片不是直接兄弟节点也能计为 2。
  function countRecordEntriesFromFields(fields, key) {
    const grouped = (Array.isArray(fields) ? fields : []).filter(field => inferDescriptorGroupKey(field) === key);
    if (grouped.length === 0) return 0;

    let explicitCount = 0;
    for (const field of grouped) {
      if (Number.isInteger(field.recordTotal) && field.recordTotal > 0) {
        explicitCount = Math.max(explicitCount, field.recordTotal);
      }
      if (Number.isInteger(field.recordIndex) && field.recordIndex >= 0) {
        explicitCount = Math.max(explicitCount, field.recordIndex + 1);
      }
    }
    if (explicitCount > 0) return explicitCount;

    const signatureCounts = new Map();
    for (const field of grouped) {
      const signature = descriptorFieldSignature(field, key);
      if (!signature || !signature.fieldKey) continue;
      signatureCounts.set(signature.fieldKey, (signatureCounts.get(signature.fieldKey) || 0) + 1);
    }
    return Math.max(1, ...signatureCounts.values());
  }

  // WinTalent 等旧门户会给同一重复区块分配稳定编号：
  // nav_14 下对应 subGroup_14_1、subGroup_14_2……。这一编号比表单行 class/标签
  // 计数可靠，尤其教育经历一条记录本身就包含大量结构相似的字段行，不能把这些行误算成
  // 多条教育记录，否则“简历有两条、页面有一条”时不会点击新增。
  function countIndexedRecordContainers(section) {
    if (!section || !section.querySelectorAll) return 0;
    const navMatch = /^nav_(.+)$/.exec(String(section.id || ''));
    const expectedPrefix = navMatch ? `subGroup_${navMatch[1]}_` : '';
    const byPrefix = new Map();
    for (const container of section.querySelectorAll('[id^="subGroup_"]')) {
      const parsed = parseIndexedRecordContainerId(container.id);
      if (!parsed || (expectedPrefix && parsed.prefix !== expectedPrefix)) continue;
      if (!byPrefix.has(parsed.prefix)) byPrefix.set(parsed.prefix, new Set());
      byPrefix.get(parsed.prefix).add(parsed.ordinal);
    }
    if (expectedPrefix) return (byPrefix.get(expectedPrefix) || new Set()).size;
    if (byPrefix.size !== 1) return 0;
    return Array.from(byPrefix.values())[0].size;
  }

  function countExistingProfileEntries(key, section) {
    const beisen = getBeisenSectionInfo(section);
    if (beisen) return beisen.forms.filter(form => getRecordFieldNodes(form).length > 0).length;
    const indexedCount = countIndexedRecordContainers(section);
    if (indexedCount > 0) return indexedCount;
    const structuralCount = countBlocksInSection(section);
    if (structuralCount < 0) return structuralCount;
    let descriptorCount = 0;
    try {
      const scopedFields = collectFields().filter(field => {
        const el = findElement(field.selector);
        return el && section.contains(el);
      });
      descriptorCount = countRecordEntriesFromFields(scopedFields, key);
    } catch (error) {
      console.debug('[简历填充] 已有记录语义计数回退到 DOM 结构:', error);
    }
    return Math.max(structuralCount, descriptorCount);
  }

  function missingProfileEntryCount(profile, key, existingCount) {
    const target = Math.min(profileEntryCount(profile, key), MAX_AUTO_ADD_PER_SECTION);
    return Math.max(0, target - Math.max(0, existingCount));
  }

  // 在区块内重新查找"添加"按钮（每轮点击前重查，防框架重渲染替换节点）
  function findAddButtonInSection(section) {
    const candidates = getAddControlCandidates(section);
    let opener = null;
    for (const el of candidates) {
      const triggerText = getAddControlText(el);
      if (!isAddTriggerText(triggerText)) continue;
      if (!isVisible(el)) continue;
      if (ADD_WORDS.test(triggerText)) return el;
      if (!opener && OPEN_WORDS.test(triggerText)) opener = el;
    }
    return opener;
  }

  // 添加按钮 → 简历区块类型；只给简历里确实有数据的区块点"添加"
  function mapButtonToProfileKey(btn, section) {
    const beisen = getBeisenSectionInfo(btn);
    if (beisen) return beisen.groupKey;
    return profileKeyFromSectionText(getAddButtonContext(btn, section));
  }

  function advanceAutoAddCount(currentCount, observedCount) {
    const observed = Number.isFinite(observedCount) && observedCount >= 0 ? observedCount : 0;
    return Math.max(currentCount + 1, observed);
  }

  function findCurrentAddButton(key, preferredSection) {
    const local = preferredSection && preferredSection.isConnected
      ? findAddButtonInSection(preferredSection)
      : null;
    if (local && mapButtonToProfileKey(local, preferredSection) === key) return local;
    return findAddButtons().find(candidate => {
      const candidateSection = getSectionContainer(candidate);
      return mapButtonToProfileKey(candidate, candidateSection) === key;
    }) || null;
  }

  async function expandAddBlocks(profile) {
    // 同一种简历数据在一次扫描中只扩容一次。部分门户会同时渲染顶部“完善”和底部
    // “新增”两个入口，若按按钮容器去重，两处都会再次补齐而产生多余空白记录。
    const processedKeys = new Set();
    const potentialFieldCount = section => section.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea, [contenteditable="true"], [role="combobox"], [class~="slt"], [class*="dateSlt"]'
    ).length;
    const visiblePotentialFieldCount = section => Array.from(section.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea, [contenteditable="true"], [role="combobox"], [class~="slt"], [class*="dateSlt"]'
    )).filter(isVisible).length;
    for (const btn of findAddButtons()) {
      enhancement?.check();
      const initialSection = getSectionContainer(btn);
      const key = mapButtonToProfileKey(btn, initialSection);
      if (!key) continue;
      if (processedKeys.has(key)) continue;                        // 同一数据类型整页只处理一次
      const want = Math.min(profileEntryCount(profile, key), MAX_AUTO_ADD_PER_SECTION); // 防异常数据无限添加
      if (want <= 0) continue;                                    // 简历无此区块数据 → 不点
      let workingSection = getProfileSectionContainer(btn, key);
      let effectiveExisting = countExistingProfileEntries(key, workingSection);
      if (effectiveExisting < 0) {                                // 单文本区块不可扩容
        processedKeys.add(key);
        continue;
      }
      const missingCount = missingProfileEntryCount(profile, key, effectiveExisting);
      if (missingCount === 0) {
        processedKeys.add(key);
        continue;
      }
      let expandedOnce = false;
      for (let guard = 0; guard < missingCount && effectiveExisting < want; guard++) {
        enhancement?.check();
        // 每轮按数据类型从当前 DOM 重查按钮；React 重渲染替换整个区块时不再持有旧节点。
        const addBtn = findCurrentAddButton(key, workingSection) || (btn.isConnected ? btn : null);
        if (!addBtn || !addBtn.isConnected || !isVisible(addBtn)) break;
        workingSection = getProfileSectionContainer(addBtn, key);
        const beforeSection = potentialFieldCount(workingSection);
        const beforePage = potentialFieldCount(document);
        const beforeVisibleSection = visiblePotentialFieldCount(workingSection);
        const beforeVisiblePage = visiblePotentialFieldCount(document);
        const hasExpanded = () =>
          potentialFieldCount(workingSection) > beforeSection || potentialFieldCount(document) > beforePage ||
          visiblePotentialFieldCount(workingSection) > beforeVisibleSection || visiblePotentialFieldCount(document) > beforeVisiblePage;
        addBtn.click();
        // 新记录可能插入按钮区块的兄弟节点，所以同时监控当前区块与全页字段数。
        const expanded = hasExpanded() || await waitForCondition(hasExpanded, 640, 80);
        if (!expanded) break;                                     // 页面确实无变化时才停止
        expandedOnce = true;
        const replacement = findCurrentAddButton(key, workingSection);
        if (replacement) workingSection = getProfileSectionContainer(replacement, key);
        effectiveExisting = advanceAutoAddCount(
          effectiveExisting,
          countExistingProfileEntries(key, workingSection)
        );
      }
      // 无响应的装饰入口不占用该数据类型；外层循环可继续尝试同区块的其他真实入口。
      if (expandedOnce || effectiveExisting >= want) processedKeys.add(key);
    }
  }

  // ===== 简历页面检测（按需显示按钮） =====
  const RESUME_STRONG = [
    // 中文：简历/求职特有
    '简历', '求职意向', '期望', '学历', '学位', '毕业院校', '工作经历', '实习经历',
    '教育经历', '项目经历', '工作经验', '自我评价', '招聘', '投递', '应聘', '求职',
    '职位', '岗位', '到岗时间', '政治面貌', '薪资',
    // 英文：词边界匹配
    'resume', 'apply', 'job', 'jobs', 'career', 'careers', 'recruit', 'candidate'
  ];
  const RESUME_MEDIUM = [
    '姓名', '手机', '电话', '邮箱', '性别', '出生日期', '籍贯', '户籍', '民族', '婚姻',
    '所在城市', '现居住', '学校', '专业', '技能', '证书', '语言',
    'name', 'phone', 'email', 'school', 'major', 'city', 'location'
  ];
  const NEGATIVE_KEYWORDS = [
    '登录', '注册', '密码', '验证码', '搜索', '评论', '记住我', '忘记密码',
    'login', 'password', 'captcha', 'register', 'search', 'comment'
  ];
  const ACCOUNT_PAGE_ROUTE_RE = /(?:^|[\/.?#_-])(?:login|log-in|log_in|signin|sign-in|sign_in|signup|sign-up|sign_up|register|auth|passport|account)(?:[\/.?#_-]|$)/i;
  const ACCOUNT_ACTION_RE = /^(?:登录|立即登录|账号登录|手机号登录|短信登录|注册|立即注册|创建账号|忘记密码|找回密码|log\s*in|sign\s*in|sign\s*up|register|create\s*account|forgot\s*password)$/i;
  const ACCOUNT_CONTEXT_RE = /(?:登录|注册|账号|账户|密码|验证码|短信验证|忘记密码|找回密码|login|sign[\s_-]*in|sign[\s_-]*up|register|password|verification|captcha|one[\s_-]*time)/i;
  const CONVERSATION_PAGE_ROUTE_RE = /(?:^|[\/.?#_-])(?:chat|chatgpt|conversation|messages?|assistant|copilot)(?:[\/.?#_-]|$)/i;
  const CONVERSATION_COMPOSER_RE = /(?:发送(?:消息|内容)?|输入消息|请输入消息|发送给|提问|继续对话|ask|message|prompt|chat)/i;
  const CONVERSATION_ACTION_RE = /^(?:发送|提交问题|提问|send|ask)$/i;

  function keywordHitCount(text, keywords) {
    const lower = text.toLowerCase();
    let n = 0;
    for (const kw of keywords) {
      if (/[a-z]/.test(kw)) {
        if (new RegExp('\\b' + kw + '\\b').test(lower)) n++;
      } else if (lower.includes(kw)) {
        n++;
      }
    }
    return n;
  }

  // 搜索框类字段（最大的误判源：搜索页）
  function isSearchLikeField(el) {
    if (el.type === 'search') return true;
    if (el.getAttribute('role') === 'searchbox') return true;
    const text = ((el.name || '') + ' ' + getLabelText(el) + ' ' + getPlaceholder(el)).toLowerCase();
    return /search|query|keyword|搜索/.test(text);
  }

  // 轻量字段描述（不生成 selector/options，供检测用）
  function collectFieldsForDetection() {
    const descs = [];
    for (const el of scanFieldElements()) {
      const desc = {
        label: getLabelText(el),
        placeholder: getPlaceholder(el),
        name: el.name || el.getAttribute('name') || el.getAttribute('formcontrolname') || '',
        contextText: getContextText(el),
        isSearchLike: isSearchLikeField(el)
      };
      if (desc.label || desc.placeholder || desc.name || desc.contextText) descs.push(desc);
    }
    return descs;
  }

  function visibleAccountPageElements(selector) {
    let elements = [];
    try { elements = Array.from(document.querySelectorAll(selector)); } catch (e) { return []; }
    return elements.filter(element => {
      try { return isVisible(element); } catch (e) { return false; }
    });
  }

  function isAccountAccessPage() {
    const url = String(location.href || '');
    const title = String(document.title || '');
    const routeSignal = ACCOUNT_PAGE_ROUTE_RE.test(url);
    const titleSignal = ACCOUNT_CONTEXT_RE.test(title);
    const fields = visibleAccountPageElements('input:not([type="hidden"]), textarea, select');
    const actions = visibleAccountPageElements('button, input[type="submit"], input[type="button"], [role="button"], a');
    const passwordFields = fields.filter(field => {
      const type = String(field.type || field.getAttribute && field.getAttribute('type') || '').toLowerCase();
      if (type === 'password') return true;
      // 不能仅凭 autocomplete="new-password/current-password" 判定密码框：51job 外部网申
      // （xyz.51job.com/External/MyResume/FillInResume.aspx）会给姓名、手机、邮箱、身份证号等
      // 全部 type="text" 字段统一加 autocomplete="new-password" 来关闭浏览器自动填充，它们并
      // 不是密码框。密码掩码只能由 type="password" 提供，autocomplete 单独出现不作为账号页信号。
      return false;
    });
    const verificationFields = fields.filter(field => {
      const autocomplete = String(field.getAttribute && field.getAttribute('autocomplete') || '').toLowerCase();
      return autocomplete === 'one-time-code' || SECURITY_FIELD_RE.test(getDirectFieldSemanticText(field));
    });
    const actionTexts = actions.map(action => compactMetadataText(
      action.textContent || action.value || action.getAttribute && action.getAttribute('aria-label'),
      60
    )).filter(Boolean);
    const actionSignal = actionTexts.some(text => ACCOUNT_ACTION_RE.test(text));
    const fieldText = fields.map(field => getDirectFieldSemanticText(field)).join(' ');
    const contextSignal = ACCOUNT_CONTEXT_RE.test([title, fieldText, actionTexts.join(' ')].join(' '));
    const compactAccountForm = fields.length > 0 && fields.length <= 8;

    // 可见密码框是最稳定的账号页信号；URL/标题/按钮再覆盖无密码的短信或单点登录页。
    if (passwordFields.length > 0 && (routeSignal || actionSignal || contextSignal)) return true;
    if (routeSignal && compactAccountForm && (titleSignal || actionSignal || contextSignal)) return true;
    if (verificationFields.length > 0 && compactAccountForm && actionSignal && contextSignal) return true;
    return titleSignal && compactAccountForm && actionSignal &&
      (passwordFields.length > 0 || verificationFields.length > 0);
  }

  function isConversationPage() {
    const url = String(location.href || '');
    if (!CONVERSATION_PAGE_ROUTE_RE.test(url)) return false;

    const fields = visibleAccountPageElements(
      'textarea, input:not([type="hidden"]):not([type="password"]), [contenteditable="true"], [contenteditable=""], [role="textbox"]'
    );
    if (fields.length === 0 || fields.length > 6) return false;

    const composerSignal = fields.some(field =>
      CONVERSATION_COMPOSER_RE.test(getDirectFieldSemanticText(field))
    );
    const actions = visibleAccountPageElements('button, [role="button"]');
    const sendAction = actions.some(action => CONVERSATION_ACTION_RE.test(compactMetadataText(
      action.textContent || action.value || action.getAttribute && action.getAttribute('aria-label'),
      60
    )));
    return composerSignal || sendAction;
  }

  function isResumePage() {
    // 账号访问页和聊天会话页优先排除：不显示自动填充按钮，也不启用点击推荐。
    if (isAccountAccessPage() || isConversationPage()) return false;
    const pageText = location.href + ' ' + (document.title || '');
    // 正信号只看 URL（标题太吵：一篇含 "career" 的博客文章也会命中）
    const urlStrong = keywordHitCount(location.href, RESUME_STRONG);
    const pageNeg = keywordHitCount(pageText, NEGATIVE_KEYWORDS);

    const usable = collectFieldsForDetection().filter(d => !d.isSearchLike);
    // 全是"添加"按钮的空表单（如初始为空的 B 站简历页）也是简历表单
    const addSignal = findAddButtons(1).length > 0;
    if (usable.length === 0 && !addSignal) return false;

    let fStrong = 0, fMedium = 0, fNeg = 0;
    for (const d of usable) {
      const combo = d.label + ' ' + d.placeholder + ' ' + d.name + ' ' + d.contextText;
      fStrong += keywordHitCount(combo, RESUME_STRONG);
      fMedium += keywordHitCount(combo, RESUME_MEDIUM);
      fNeg += keywordHitCount(combo, NEGATIVE_KEYWORDS);
    }

    // 纯登录/搜索/评论页：即使有"邮箱/姓名"等中等信号也拦掉；
    // 但字段丰富的表单（中等信号≥3，如校园招聘的"register"登记页）或有"添加"区块应放行
    if ((pageNeg > 0 || fNeg > 0) && urlStrong === 0 && fStrong === 0 && fMedium < 3 && !addSignal) return false;

    // 主规则：字段信号足够（强≥1 或 中等≥2）；
    // 或 URL 是招聘页（job/apply/简历…）且字段至少有一个个人信息信号，避免职业博客正文页误显示
    return addSignal || fStrong >= 1 || fMedium >= 2 || (urlStrong >= 1 && (fStrong >= 1 || fMedium >= 1));
  }

  // ===== 通用标签检测 =====
  function getLabelText(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => {
        const node = document.getElementById(id);
        return node ? (node.textContent || '').trim() : '';
      }).filter(Boolean).join(' ');
      if (text) return text;
    }
    // WinTalent/中国电信等旧招聘门户把字段标题写在 msg 属性，字段本身只有数字 id/name。
    // 必须优先读取这一明确语义，否则新增记录无法判断“论文名称/奖励级别”等字段用途。
    const semanticAttr = el.getAttribute('data-label') || el.getAttribute('msg') || el.getAttribute('data-name');
    if (semanticAttr && semanticAttr.trim() && semanticAttr.trim().length <= 120) return semanticAttr.trim();
    // 自动完成/联想输入常把 msg/data-label 放在外层组件，而真实 input 没有任何语义属性。
    // 只读取最近的明确语义容器，避免退回整个记录卡片文本。
    const semanticContainer = el.closest('[msg], [data-label], [data-name]');
    if (semanticContainer && semanticContainer !== el) {
      const inherited = semanticContainer.getAttribute('data-label') || semanticContainer.getAttribute('msg') || semanticContainer.getAttribute('data-name');
      if (inherited && inherited.trim() && inherited.trim().length <= 120) return inherited.trim();
    }
    // WinTalent 的联想输入把字段语义放在同一 dy-form-special 内的隐藏 input[msg]，
    // 可见 input 既没有 name/msg，也不是该隐藏节点的后代。读取最近特殊组件中的唯一语义
    // 字段，使“奖励名称”等可见输入在复扫和重渲染后仍保持正确标签。
    const specialContainer = el.closest('dy-form-special, [special-renderd]');
    if (specialContainer) {
      const semanticSibling = specialContainer.querySelector(
        'input[type="hidden"][msg], input[type="hidden"][data-label], input[type="hidden"][data-name]'
      );
      if (semanticSibling) {
        const inherited = semanticSibling.getAttribute('msg') || semanticSibling.getAttribute('data-label') || semanticSibling.getAttribute('data-name');
        if (inherited && inherited.trim() && inherited.trim().length <= 120) return inherited.trim();
      }
    }
    // label for
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    // 包裹的 label
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(e => e.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }
    // 通用：form-item / form-group 中的 label。
    // ant 的 ant-form-item-children 也会命中 [class*="form-item"] 但里面没有 label，
    // label 在更上层的 ant-form-item，所以向上逐级找真正带 label 的那一级
    let formItem = el.closest('[class*="form-item"], [class*="form-group"], [class*="field-item"], [class*="form-row"]');
    while (formItem && formItem !== document.body) {
      const label = formItem.querySelector('[class*="label"], label');
      if (label) {
        const text = label.textContent.trim().replace(/[：:*：*\s?]+$/, '');
        if (text) return text;
      }
      formItem = formItem.parentElement && formItem.parentElement.closest('[class*="form-item"], [class*="form-group"], [class*="field-item"], [class*="form-row"]');
    }
    // 通用：data-label 属性
    if (el.getAttribute('data-label')) return el.getAttribute('data-label');
    // 兄弟 label（简单表单结构 <div><label>X</label><input/></div>，label 为 input 前一兄弟）
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL' && !prev.querySelector('input, select, textarea')) {
      const t = prev.textContent.trim().replace(/[：:*：*\s?]+$/, '');
      if (t) return t;
    }
    // 旧招聘系统常用 <dl><dt>字段名</dt><dd><input/></dd></dl>，没有 label/placeholder/name。
    const dl = el.closest('dl');
    if (dl) {
      const dt = dl.querySelector(':scope > dt');
      if (dt) {
        const t = dt.textContent.trim().replace(/[：:*＊\s?]+$/, '');
        if (t) return t;
      }
    }
    // WinTalent 表格结构：<div><div class="mdf-table-cell-l">字段名</div>
    // <div class="mdf-table-cell-r"><input/></div></div>。
    const rightCell = el.closest('.mdf-table-cell-r, [class*="table-cell-r"]');
    if (rightCell && rightCell.parentElement) {
      const labelCell = Array.from(rightCell.parentElement.children).find(node =>
        node !== rightCell && /(?:table-cell-l|field-label|form-label)/i.test(
          typeof node.className === 'string' ? node.className : ''
        )
      );
      const text = labelCell && (labelCell.getAttribute('title') || labelCell.textContent || '').trim()
        .replace(/[：:*＊\s?]+$/, '');
      if (text) return text;
    }
    // Bootstrap/栅格表单常用一行中的左列显示标题、右列放控件，但没有 label/for。
    // 仅检查控件所在单元格之前的短文本兄弟，避免读取下一列或整个经历卡片。
    let cell = el.parentElement;
    for (let depth = 0; depth < 4 && cell && cell !== document.body; depth++, cell = cell.parentElement) {
      const siblings = cell.parentElement ? Array.from(cell.parentElement.children) : [];
      const ownIndex = siblings.indexOf(cell);
      if (ownIndex <= 0) continue;
      for (let i = ownIndex - 1; i >= 0; i--) {
        const sibling = siblings[i];
        if (sibling.querySelector && sibling.querySelector('input, select, textarea')) continue;
        const text = ((sibling.getAttribute && sibling.getAttribute('title')) || sibling.textContent || '')
          .trim().replace(/\s+/g, ' ').replace(/[：:*＊\s?]+$/, '');
        if (text && text.length <= 40) return text;
      }
    }
    // 某些 WinTalent/Vue 栅格把左侧标题和右侧控件分别包进多层匿名 div，二者既不是
    // 直接兄弟，也没有 label/msg。用同一记录卡片内的视觉行关系找左侧短文本，只接受
    // 与控件纵向重叠且自身不含可填写控件的节点，避免把上一行或整张经历卡片当作标签。
    const nearby = findNearbyVisualLabel(el);
    if (nearby) return nearby;
    return '';
  }

  function cleanNearbyLabelText(node) {
    const text = ((node && node.getAttribute && (
      node.getAttribute('data-label') || node.getAttribute('msg') || node.getAttribute('title')
    )) || (node && node.textContent) || '')
      .trim().replace(/\s+/g, ' ').replace(/[：:*＊\s?]+$/, '');
    if (!text || text.length > 40 || /^(请选择|请输入|请填写|添加|删除|取消|保存)$/.test(text)) return '';
    return text;
  }

  function findNearbyVisualLabel(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return '';
    let fieldRect;
    try { fieldRect = el.getBoundingClientRect(); } catch { return ''; }
    if (!fieldRect || (!fieldRect.width && !fieldRect.height)) return '';
    const writableSelector = 'input, select, textarea, [contenteditable="true"], [role="combobox"]';
    let branch = el;
    let container = el.parentElement;
    let best = null;
    for (let depth = 0; depth < 6 && container && container !== document.body; depth++) {
      const candidates = Array.from(container.querySelectorAll(
        'label, dt, [msg], [data-label], [class*="label"], [class*="table-cell-l"], [class*="field-name"], [class*="title"]'
      ));
      for (const node of candidates) {
        if (node === el || node.contains(el) || (branch && branch.contains(node))) continue;
        if (node.querySelector && node.querySelector(writableSelector)) continue;
        const text = cleanNearbyLabelText(node);
        if (!text) continue;
        let rect;
        try { rect = node.getBoundingClientRect(); } catch { continue; }
        if (!rect || (!rect.width && !rect.height)) continue;
        const fieldMiddle = fieldRect.top + fieldRect.height / 2;
        const labelMiddle = rect.top + rect.height / 2;
        const verticalDistance = Math.abs(fieldMiddle - labelMiddle);
        const verticalLimit = Math.max(36, Math.max(fieldRect.height, rect.height) * 0.9);
        if (verticalDistance > verticalLimit || rect.left > fieldRect.left + 8) continue;
        const horizontalGap = Math.max(0, fieldRect.left - rect.right);
        const score = verticalDistance * 8 + horizontalGap + depth * 60;
        if (!best || score < best.score) best = { text, score };
      }
      branch = container;
      container = container.parentElement;
    }
    return best ? best.text : '';
  }

  function isPlaceholderLikeValue(el) {
    if (!el || !('value' in el)) return false;
    const value = String(el.value || '').trim();
    if (!value || value.length > 100) return false;
    return /^(请输入|输入|请选择|请填写|请补充|点击选择|附件只支持|文件只支持|字数控制|例如[：:]?|如[：:])/i.test(value);
  }

  function getPlaceholder(el) {
    if (el.placeholder) return el.placeholder;
    // 内部 input 的 placeholder
    const inner = el.querySelector('input[placeholder], textarea[placeholder]');
    if (inner) return inner.placeholder;
    // ARIA
    if (el.getAttribute('aria-placeholder')) return el.getAttribute('aria-placeholder');
    // 通用 placeholder 类名
    const ph = el.querySelector('[class*="placeholder"]');
    if (ph) return ph.textContent.trim();
    // 兼容把提示语放在 value 中的旧页面；填写时会把它视为空值并正常覆盖。
    if (isPlaceholderLikeValue(el)) return String(el.value).trim();
    return '';
  }

  function isRequired(el) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    const formItem = el.closest('[class*="form-item"], [class*="form-group"], [class*="field"]');
    if (formItem) {
      if (formItem.querySelector('[class*="required"]')) return true;
      const label = formItem.querySelector('label, [class*="label"]');
      if (label && /[＊*⭐]/.test(label.textContent)) return true;
    }
    const dl = el.closest('dl');
    if (dl) {
      const dt = dl.querySelector(':scope > dt');
      if (dt && (/[＊*]/.test(dt.textContent) || dt.querySelector('.red, [style*="color:red"], [style*="color: red"]'))) return true;
    }
    return false;
  }

  function getPhoenixDateTrigger(el) {
    const trigger = el && el.closest && el.closest('.phoenix-select');
    // 日期外观与下拉相同，只有这个 SVG 图标给出可靠的日期语义。
    return trigger && trigger.querySelector('[id*="field_date_time_picker"], use[*|href*="field_date_time_picker"]')
      ? trigger : null;
  }

  function getContextText(el) {
    let prev = el.previousElementSibling;
    if (prev && !['INPUT', 'SELECT', 'TEXTAREA'].includes(prev.tagName)) {
      const text = prev.textContent.trim();
      if (text && text.length < 100) return text;
    }
    const parent = el.parentElement;
    if (parent) {
      const clone = parent.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, svg, style, script').forEach(e => e.remove());
      const text = clone.textContent.trim().replace(/\s+/g, ' ');
      if (text && text.length < 150) return text;
    }
    let ancestor = el.parentElement?.parentElement;
    if (ancestor) {
      const clone = ancestor.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, svg, style, script').forEach(e => e.remove());
      const text = clone.textContent.trim().replace(/\s+/g, ' ');
      if (text && text.length < 150) return text;
    }
    return '';
  }

  // 北森 Phoenix：标题与各条 .form[name] 使用相同 id，标题是无语义 class 的 div。
  // 依据这一关联寻找区块，不把行内的“名称”或相邻区块标题当作记录标题。
  function getBeisenSectionInfo(el) {
    if (!el || !el.closest) return null;
    // 从记录壳开始，跳过日期/联想组件十多层内部节点。
    let current = el.closest('.ux-standard-form') || el;
    for (let depth = 0; depth < 20 && current && current !== document.body; depth++, current = current.parentElement) {
      if (!current.children || !current.querySelectorAll) continue;
      const headings = Array.from(current.children).filter(node =>
        node.id && /_Recruitment_/i.test(node.id) &&
        !node.querySelector('input, textarea, select') && (node.textContent || '').trim().length < 30
      );
      for (const heading of headings) {
        const forms = Array.from(current.querySelectorAll('.ux-standard-form .form[name]'))
          .filter(form => form.id === heading.id);
        if (!forms.length) continue;
        const title = heading.textContent.trim();
        const groupKey = title === '证书' ? 'awards' : profileKeyFromSectionText(title);
        if (groupKey) return { container: current, title, groupKey, forms };
      }
    }
    return null;
  }

  function isBeisenPage() {
    return typeof document !== 'undefined' && !!document.querySelector?.('.form-item--phoenix');
  }

  // 获取字段所属区块标题（如"教育经历"、"实习经历"、"项目经历"等），帮助 LLM 理解字段归属
  function getSectionTitle(el) {
    const beisen = getBeisenSectionInfo(el);
    if (beisen) return beisen.title;
    // 向上找区块容器，再找其标题元素
    let cur = el.parentElement;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      // 常见区块标题选择器
      const heading = cur.querySelector('h1, h2, h3, h4, h5, h6, [class*="section-title"], [class*="block-title"], [class*="card-title"], [class*="form-title"], legend, summary');
      if (heading) {
        const text = (heading.textContent || '').trim();
        if (text && text.length < 30) return text;
      }
    }
    return '';
  }

  // ===== 重复记录结构识别 =====
  // 奖励、实习、教育、项目等通常由若干结构相似的兄弟容器组成。字段标签的全局序号会被
  // 隐藏字段、下拉内部 input 或动态新增项扰乱，因此优先按“最近的重复兄弟容器”确定记录序号。
  const RECORD_WRITABLE_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="file"]):not([type="password"]):not([type="search"]), textarea, select, [contenteditable="true"], [contenteditable=""], [role="combobox"]';
  const RECORD_GROUP_HINTS = [
    { key: 'families', title: '家庭关系', re: /家庭|亲属|家属/ },
    { key: 'awards', title: '奖励荣誉', re: /奖励|奖项|获奖|荣誉|奖学金|表彰/ },
    { key: 'papers', title: '论文发表', re: /论文|期刊|会议发表|学术成果|科研成果/ },
    { key: 'patents', title: '专利发表', re: /专利/ },
    { key: 'projects', title: '项目经历', re: /项目|课题|研究经历|科研项目/ },
    { key: 'education', title: '教育经历', re: /教育信息|教育经历|学习经历|求学经历|教育背景|学历信息|毕业院校|学校名称|学历|学位|所学专业/ },
    { key: 'work', title: '实习经历', re: /实习经历|工作经历|任职经历|职业经历|就业经历|从业经历|实践经历|工作情况|实习情况|工作信息|实习信息|公司名称|企业名称|工作单位|实习单位|职位名称|工作描述|工作性质|证明人(?:姓名|职务|联系方式)/ },
    { key: 'campusDuties', title: '校内职务', re: /校内职务|校园经历|校园活动|学生工作|学生干部|社团经历|社会实践/ },
    { key: 'computerSkills', title: '计算机技能', re: /计算机技能|IT技能|技能类别/ },
    { key: 'languages', title: '语言能力', re: /语言能力|语言水平|语言情况|语言信息|外语|英语水平|语种|CET|四六级/i }
  ];

  function normalizeRecordToken(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[＊*：:\s]/g, '')
      .replace(/\[\d+\]|【\d+】|第\d+(?:条|项|个)?/g, '[]')
      .replace(/\d+/g, '#')
      .replace(/^(请输入|请选择|请填写|请补充|选择)/, '')
      .slice(0, 80);
  }

  function getRecordFieldNodes(container) {
    const nodes = [];
    if (container.matches && container.matches(RECORD_WRITABLE_SELECTOR)) nodes.push(container);
    container.querySelectorAll(RECORD_WRITABLE_SELECTOR).forEach(node => nodes.push(node));
    return nodes.filter((node, index, all) => {
      if (!isVisible(node) || isBlockedAutofillField(node)) return false;
      // 自定义 combobox 内已有原生字段时只计算原生字段，避免一个控件被计数两次。
      if (node.getAttribute('role') === 'combobox' && node.querySelector('input, textarea, select')) return false;
      return all.indexOf(node) === index;
    });
  }

  function getRecordFingerprint(container, cache) {
    if (cache && cache.has(container)) return cache.get(container);
    const tokens = getRecordFieldNodes(container).map(node => normalizeRecordToken(
      getLabelText(node) || getPlaceholder(node) || node.getAttribute('name') || node.id || node.getAttribute('role')
    )).filter(Boolean);
    const result = { count: tokens.length, tokens };
    if (cache) cache.set(container, result);
    return result;
  }

  function recordFingerprintsMatch(a, b, left, right) {
    if (a.count < 2 || b.count < 2 || left.tagName !== right.tagName) return false;
    const maxCount = Math.max(a.count, b.count);
    const minCount = Math.min(a.count, b.count);
    if (minCount / maxCount < 0.6) return false;
    const rightCounts = new Map();
    b.tokens.forEach(token => rightCounts.set(token, (rightCounts.get(token) || 0) + 1));
    let shared = 0;
    for (const token of a.tokens) {
      const n = rightCounts.get(token) || 0;
      if (n > 0) {
        shared++;
        rightCounts.set(token, n - 1);
      }
    }
    const overlap = shared / minCount;
    if (shared >= 2 && overlap >= 0.75) return true;

    // 动态表单的某些可选行可能只存在于部分记录；相同非空 class 的条目允许稍低重合率。
    const leftClass = typeof left.className === 'string' ? left.className.trim().replace(/\s+/g, ' ') : '';
    const rightClass = typeof right.className === 'string' ? right.className.trim().replace(/\s+/g, ' ') : '';
    return shared >= 2 && overlap >= 0.6 && leftClass && leftClass === rightClass;
  }

  function inferRecordGroup(el, fingerprint) {
    const section = getSectionTitle(el);
    // “毕业论文”是教育经历的子字段。必须在宽泛的“论文/学术成果”识别前处理，
    // 否则教育记录会被误归为论文发表。
    if (/毕业论文/.test(section)) return { groupKey: 'education', group: '教育经历' };
    const sectionHint = RECORD_GROUP_HINTS.find(item => item.re.test(section));
    if (sectionHint) return { groupKey: sectionHint.key, group: sectionHint.title };
    const text = [section, ...(fingerprint.tokens || [])].join(' ');
    // “毕业论文”属于具体教育经历，不能因包含“论文”而误归到论文发表记录。
    if (/毕业论文/.test(text)) return { groupKey: 'education', group: '教育经历' };
    const hint = RECORD_GROUP_HINTS.find(item => item.re.test(text));
    if (hint) return { groupKey: hint.key, group: hint.title };
    return { groupKey: '', group: section || (fingerprint.tokens || []).slice(0, 3).join(' / ') || '重复记录' };
  }

  function parseIndexedRecordContainerId(id) {
    const match = /^(subGroup_.+_)(\d+)$/.exec(String(id || ''));
    return match ? { prefix: match[1], ordinal: Number(match[2]) } : null;
  }

  function getRecordContext(el, caches) {
    if (!el) return null;
    const beisen = getBeisenSectionInfo(el);
    if (beisen) {
      const index = beisen.forms.findIndex(form => form.contains(el));
      if (index >= 0) return {
        container: beisen.forms[index], index, total: beisen.forms.length,
        groupKey: beisen.groupKey, group: beisen.title
      };
    }
    const fingerprintCache = caches && caches.fingerprints ? caches.fingerprints : new WeakMap();

    // WinTalent 系门户会给每条记录稳定编号：subGroup_<区块>_1、subGroup_<区块>_2……。
    // 直接按同前缀兄弟容器的 DOM 顺序编号，比可选字段数量不同导致的指纹比对更可靠。
    const explicitContainer = el.closest && el.closest('[id^="subGroup_"]');
    const explicitId = explicitContainer && parseIndexedRecordContainerId(explicitContainer.id);
    if (explicitId && explicitContainer.parentElement) {
      const matching = Array.from(explicitContainer.parentElement.children).filter(sibling => {
        const parsed = parseIndexedRecordContainerId(sibling.id);
        return parsed && parsed.prefix === explicitId.prefix;
      });
      const index = matching.indexOf(explicitContainer);
      if (matching.length >= 2 && index >= 0) {
        const fingerprint = getRecordFingerprint(explicitContainer, fingerprintCache);
        const inferred = inferRecordGroup(el, fingerprint);
        return { container: explicitContainer, index, total: matching.length, ...inferred };
      }
    }

    let current = el.parentElement;
    for (let depth = 0; depth < 9 && current && current !== document.body; depth++, current = current.parentElement) {
      const parent = current.parentElement;
      if (!parent) break;
      const fingerprint = getRecordFingerprint(current, fingerprintCache);
      if (fingerprint.count < 2) continue;
      const matching = Array.from(parent.children).filter(sibling => sibling === current || recordFingerprintsMatch(
        fingerprint, getRecordFingerprint(sibling, fingerprintCache), current, sibling
      ));
      // current 自身也必须与至少一个兄弟结构匹配；仅有多个表单区块不等于多条记录。
      if (matching.length < 2) continue;
      const index = matching.indexOf(current);
      if (index < 0) continue;
      const inferred = inferRecordGroup(el, fingerprint);
      return { container: current, index, total: matching.length, ...inferred };
    }
    return null;
  }

  // ===== 选择器生成 =====
  function generateStableScopedSelector(el) {
    if (!el || !el.parentElement || !el.getAttribute) return '';
    const stableAttrs = ['ng-model', 'formcontrolname', 'v-model', 'data-field', 'data-key', 'school-or-subject', 'data-testid'];
    const targetParts = [];
    for (const attr of stableAttrs) {
      const value = el.getAttribute(attr);
      if (value) targetParts.push(`${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`);
    }
    if (!targetParts.length) return '';

    let current = el.parentElement;
    for (let depth = 0; depth < 8 && current && current !== document.body; depth++, current = current.parentElement) {
      const anchors = [];
      if (current.id) anchors.push(`#${CSS.escape(current.id)}`);
      const name = current.getAttribute && current.getAttribute('name');
      if (name) anchors.push(`${current.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`);
      for (const anchor of anchors) {
        let anchorMatches = [];
        try { anchorMatches = Array.from(document.querySelectorAll(anchor)); } catch { continue; }
        if (anchorMatches.length !== 1 || anchorMatches[0] !== current) continue;
        for (const target of targetParts) {
          const selector = `${anchor} ${target}`;
          try {
            const matches = document.querySelectorAll(selector);
            if (matches.length === 1 && matches[0] === el) return selector;
          } catch { /* 尝试下一个稳定属性 */ }
        }
      }
    }
    return '';
  }

  function generateSelector(el) {
    if (el.id) {
      const idSelector = `#${CSS.escape(el.id)}`;
      try {
        if (document.querySelectorAll(idSelector).length === 1) return idSelector;
      } catch { /* 非法或重复 id 时继续生成结构路径 */ }
    }

    // name 快捷路径仅在页面唯一匹配时使用：同名重复字段（多区块表单）会被
    // document.querySelector 统一命中第一个元素 → 后续条目的值写错位置。不唯一时
    // 回退到带 nth-of-type 的完整路径（nth-of-type 按位置定位，天然唯一）
    if (el.name) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      try {
        if (document.querySelectorAll(sel).length <= 1) return sel;
      } catch {
        return sel;
      }
    }

    // Angular 的 ng-if 会在扫描与执行之间插入隐藏输入，纯 nth-of-type 路径随后会从
    // 可见奖励名称漂移到隐藏 input。优先使用唯一祖先 + ng-model 等稳定属性定位。
    const stableScoped = generateStableScopedSelector(el);
    if (stableScoped) return stableScoped;

    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let sel = current.tagName.toLowerCase();
      if (current.id) {
        const idSelector = `#${CSS.escape(current.id)}`;
        try {
          if (document.querySelectorAll(idSelector).length === 1) {
            path.unshift(idSelector);
            break;
          }
        } catch { /* 回退到 tag + nth-of-type */ }
      }
      // 用有意义的 class 辅助定位
      if (current.className && typeof current.className === 'string') {
        const useful = current.className.split(/\s+/).find(c =>
          c.startsWith('ant-') || c.startsWith('el-') || c.startsWith('arco-') ||
          c.startsWith('t-') || c.startsWith('is-') || c.startsWith('mui-')
        );
        if (useful) sel += `.${useful}`;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      path.unshift(sel);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  // 日期值 → 可比较数字（2026-06 → 202606），用于按值倒序排日期字段
  function dateSortKey(v) {
    const m = /^(\d{4})[-\/.](\d{1,2})?/.exec(String(v || '').trim());
    if (!m) return 0;
    return parseInt(m[1] + (m[2] ? String(+m[2]).padStart(2, '0') : '00'), 10);
  }

  // ===== 填充执行 =====
  // 把多条经历字段直接绑定到 profile.<group>[recordIndex].<fieldKey>。
  // 这是整页填充的快速路径：奖励、实习、教育、项目等已能从 DOM 结构确定归属时，
  // 无需再把它们发送给 LLM，也不会出现同一条记录的名称、等级和日期相互串行。
  function profileRecordArray(profile, groupKey) {
    let arr = profile && profile[groupKey];
    if (groupKey === 'languages' && !Array.isArray(arr) && arr != null && String(arr).trim()) {
      arr = String(arr).trim().split(/\r?\n/).map(line => ({ level: line.trim() })).filter(rec => rec.level);
    }
    return Array.isArray(arr) ? arr : [];
  }

  // 兼容旧版 JSON、第三方简历解析器和用户手工数据中的常见字段名。
  // 页面字段含义仍由 QP_FIELD_PATTERNS 决定，别名只负责从同一条记录读取值。
  const PROFILE_RECORD_FIELD_ALIASES = {
    education: {
      school: ['schoolName', 'university', 'college'], major: ['majorName', 'specialty'],
      degree: ['educationLevel', 'degreeName'], degreeTitle: ['academicDegree'], department: ['collegeName', 'faculty'],
      startDate: ['startTime', 'beginDate', 'enrollmentDate'], endDate: ['endTime', 'graduationDate'],
      eduType: ['educationType'], rank: ['gradeRank'],
      comprehensiveRank: ['classRank', 'gradeComprehensiveRank', 'rankByTotal'],
      avgScore: ['averageScore'], courses: ['mainCourses'],
      tutor: ['mentor', 'advisor', 'supervisor'], tutorContact: ['mentorContact', 'advisorContact'],
      isOverseas: ['overseas', 'isOverseasEducation']
    },
    work: {
      company: ['companyName', 'enterprise', 'employer', 'organization'], position: ['jobTitle', 'role'],
      department: ['division', 'team'], city: ['location', 'workCity'], type: ['workType', 'employmentType'],
      startDate: ['startTime', 'beginDate'], endDate: ['endTime', 'finishDate'],
      description: ['workContent', 'responsibilities', 'summary'], companyNature: ['enterpriseNature'],
      monthlySalary: ['salary'], certifierName: ['witnessName'], certifierDuty: ['witnessPosition'],
      certifierContact: ['witnessPhone', 'certifierPhone']
    },
    projects: {
      projectName: ['name', 'title'], role: ['position', 'projectRole'], company: ['organization'],
      techStack: ['technologies'], startDate: ['startTime', 'beginDate'], endDate: ['endTime', 'finishDate'],
      description: ['content', 'summary'], responsibilities: ['duties', 'responsibility']
    },
    patents: {
      type: ['patentType'], name: ['title', 'patentName'], stage: ['status', 'patentStage'], authorRank: ['rank', 'authorOrder']
    },
    papers: {
      title: ['name', 'paperTitle'], publishDate: ['date', 'publicationDate', 'acceptDate'],
      journal: ['journalName', 'conferenceName', 'venue'], level: ['journalLevel', 'indexType'],
      authorRank: ['rank', 'authorOrder'], status: ['publicationStatus'], impactFactor: ['impact', 'if'],
      yearIssue: ['publicationYearIssue', 'issue', 'volumeIssue']
    },
    awards: {
      category: ['type', 'awardType'], name: ['title', 'awardName'], level: ['awardLevel'], grade: ['awardGrade', 'rank'],
      date: ['awardDate', 'receivedDate'], issuer: ['organization', 'issuingOrganization'], school: ['schoolName'],
      summary: ['description', 'awardDescription']
    }
  };

  function profileRecordValueCandidates(record, groupKey, fieldKeys) {
    const aliases = PROFILE_RECORD_FIELD_ALIASES[groupKey] || {};
    const keys = [];
    for (const fieldKey of fieldKeys || []) {
      keys.push(fieldKey, ...(aliases[fieldKey] || []));
    }
    return keys
      .map(key => record && record[key])
      .filter(value => value != null && String(value).trim() !== '')
      .map(value => String(value).trim())
      .filter((value, index, all) => all.indexOf(value) === index);
  }

  function derivedRecordValueCandidates(record, groupKey, fieldKey, directLabel = '') {
    const saved = profileRecordValueCandidates(record, groupKey, [fieldKey]);
    if (saved.length) return saved;
    if (groupKey === 'papers' && fieldKey === 'yearIssue') {
      const parts = parseDateValueParts(profileRecordValueCandidates(record, groupKey, ['publishDate'])[0]);
      return parts ? [String(parts.year)] : [];
    }
    if (groupKey === 'awards' && fieldKey === 'summary' && /证书描述/.test(directLabel)) {
      const details = [['category', '类别'], ['level', '级别'], ['grade', '等级'], ['issuer', '颁发单位']]
        .map(([key, label]) => {
          const value = profileRecordValueCandidates(record, groupKey, [key])[0];
          return value ? `${label}：${value}` : '';
        }).filter(Boolean);
      return details.length ? [details.join('\n')] : [];
    }
    if (groupKey === 'education' && fieldKey === 'isOverseas') {
      if (record.schoolNature === '海外院校' || record.eduType === '海外留学') return ['是'];
      if (record.schoolNature === '国内普通院校') return ['否'];
    }
    return [];
  }

  function splitCombinedGpa(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    let match = raw.match(/^([+-]?\d+(?:\.\d+)?)\s*[\/／]\s*([+-]?\d+(?:\.\d+)?)$/);
    if (!match) {
      match = raw.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:分)?\s*[（(]?\s*满分\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*[）)]?$/);
    }
    return match ? { score: match[1], total: match[2] } : null;
  }

  function gpaValuePart(fieldText) {
    const direct = String(fieldText || '');
    // 北森只有一个“成绩(GPA)”文本框，允许 3.44/5，不能当作拆分后的成绩分量。
    if (/^成绩\s*[（(]\s*GPA\s*[）)](?:\s|$)/i.test(direct)) return '';
    if (/(?:GPA|绩点).*(?:总分|满分|最高分|总绩点)|(?:总分|满分|最高分).*(?:GPA|绩点)|gpa.?max|max.?gpa/i.test(direct)) {
      return 'total';
    }
    if (/(?:GPA|绩点).*(?:分数|得分|成绩|实际分)|(?:分数|得分|成绩).*(?:GPA|绩点)|gpa.?score|score.?gpa/i.test(direct)) {
      return 'score';
    }
    return '';
  }

  function educationGpaValueCandidates(record, fieldText) {
    const rawValues = profileRecordValueCandidates(record, 'education', ['gpa']);
    if (!rawValues.length) return [];
    const part = gpaValuePart(fieldText);
    if (!part) return rawValues;
    for (const raw of rawValues) {
      const split = splitCombinedGpa(raw);
      if (split && split[part]) return [split[part]];
    }
    // 页面明确拆成分数/总分、保存值却无法可靠拆分时不写入整段，避免产生无效数值。
    return [];
  }

  // 语言熟练度有两种常见存法：单值“熟练”，或组合值“听说-熟练 读写-良好”。
  // 对拆开的“听说/读写”下拉只返回对应维度，避免把整段组合文本拿去点击下拉。
  function languageProficiencyValueCandidates(record, fieldText) {
    const raw = record && record.proficiency != null ? String(record.proficiency).trim() : '';
    if (!raw) return [];
    const direct = String(fieldText || '');
    const levelPattern = '精通|流利|优秀|熟练|良好|较好|一般|基础|入门|了解';
    const uniqueLevels = Array.from(new Set(raw.match(new RegExp(levelPattern, 'g')) || []));
    let aspectPattern = '';
    if (/听说|口语/.test(direct)) aspectPattern = '听说|口语';
    else if (/读写|阅读|写作/.test(direct)) aspectPattern = '读写|阅读|写作';

    if (aspectPattern) {
      const aspectMatch = raw.match(new RegExp(`(?:${aspectPattern})[^,，;；/、\\n]{0,12}?(${levelPattern})`, 'i'));
      if (aspectMatch) return [aspectMatch[1], raw].filter((value, index, all) => all.indexOf(value) === index);
      // 组合值只有一个熟练度时，可安全复用于两个维度；多个不同值则交给用户选择。
      if (uniqueLevels.length === 1) return [uniqueLevels[0], raw];
      return [];
    }

    if (uniqueLevels.length === 1) return [uniqueLevels[0], raw].filter((value, index, all) => all.indexOf(value) === index);
    // 普通短值（如“专业工作能力”）仍保留原样；多维且等级不一致的组合值不猜测。
    return uniqueLevels.length === 0 && raw.length <= 16 ? [raw] : [];
  }

  function descriptorDirectText(field) {
    return [field.label, field.placeholder, field.name, field.id, field.autocomplete]
      .filter(Boolean).join(' ').trim();
  }

  function descriptorOptionText(field) {
    return Array.isArray(field.options) ? field.options.filter(Boolean).join(' ') : '';
  }

  // 有些动态表单的区块标题不在字段祖先节点内，导致 getSectionTitle 无法拿到
  // “学术成果”。此时只使用足够明确的字段文案兜底，避免“名称/级别”这类通用词串组。
  function inferDescriptorGroupFromDirectText(field) {
    const direct = descriptorDirectText(field);
    if (!direct) return '';
    const rules = [
      { key: 'papers', re: /论文(?:名称|题目|标题|级别|等级|状态|摘要)|期刊(?:类型|级别|名称)|会议(?:名称|级别)|收录类型|检索类型|影响因子|paper.?title|publication.?title|journal.?type/i },
      { key: 'patents', re: /专利(?:名称|题目|类型|类别|阶段|状态)|发明人(?:排序|位次)|patent.?(?:name|title|type|stage)/i },
      { key: 'awards', re: /奖励(?:名称|类别|级别|等级|时间|描述)|奖项(?:名称|类别|级别|等级|时间|描述)|(?:^|[\s*＊])获奖项(?:[：:\s*＊]|$)|荣誉名称|奖学金名称|获奖(?:时间|级别)|颁发单位|award.?(?:name|category|level|grade|date)/i },
      { key: 'work', re: /企业名称|公司名称|实习单位|任职单位|职位名称|工作性质|工作描述|证明人(?:姓名|职务|联系方式)|(?:company|employer|job.?title|work.?description)/i }
    ];
    const hits = rules.filter(rule => rule.re.test(direct));
    return hits.length === 1 ? hits[0].key : '';
  }

  function inferDescriptorGroupKey(field) {
    if (field.recordGroupKey && QP_ARRAY_GROUPS.some(group => group.key === field.recordGroupKey)) {
      return field.recordGroupKey;
    }
    // 区块标题/记录标题优先；旧站点没有标题时，再使用当前表单行的有限上下文。
    // 不使用全页文本，避免“学校/公司”等词把其他区块误判为经历字段。
    const strongContext = [field.recordGroup, field.section].filter(Boolean).join(' ');
    const nearbyContext = [strongContext, field.contextText].filter(Boolean).join(' ');
    if (isBeisenPage() && /^(证书|证书 证书)$/.test(strongContext.trim())) return 'awards';
    if (/毕业论文/.test(strongContext)) return 'education';
    let hits = QP_ARRAY_GROUPS.filter(group => {
      const re = QP_GROUP_CONTEXT[group.key];
      return re && re.test(strongContext);
    });
    if (hits.length === 1) return hits[0].key;
    hits = QP_ARRAY_GROUPS.filter(group => {
      const re = QP_GROUP_CONTEXT[group.key];
      return re && re.test(nearbyContext);
    });
    if (hits.length === 1) return hits[0].key;
    return inferDescriptorGroupFromDirectText(field);
  }

  function descriptorFieldSignature(field, groupKey) {
    const group = QP_ARRAY_GROUPS.find(item => item.key === groupKey);
    if (!group) return null;
    const direct = descriptorDirectText(field);
    if (!direct) return null;
    const options = descriptorOptionText(field);

    // “名称 + 请输入”不能靠整段子串反推论文名称；只在已确定论文区块内接受短标签。
    if (groupKey === 'papers' && /^名称[：:*＊\s]*$/.test(field.label || '')) {
      return { fieldKey: 'title', label: group.fields.title };
    }

    if (groupKey === 'education') {
      const valuePart = gpaValuePart(direct);
      if (valuePart) {
        return { fieldKey: 'gpa', valuePart, label: valuePart === 'score' ? 'GPA分数' : 'GPA总分' };
      }
    }

    if (groupKey === 'languages') {
      if (/成绩|分数|score/i.test(direct)) return { fieldKey: 'score', label: group.fields.score };
      if (/时间|日期|date|time/i.test(direct)) return { fieldKey: 'date', label: group.fields.date };
      if (/是否通过|通过情况|passed?/i.test(direct)) return { fieldKey: 'passed', label: group.fields.passed };
      if (/证书|certificate/i.test(direct)) return { fieldKey: 'certName', label: group.fields.certName };
      if (/掌握程度|熟练程度|熟练度|听说|口语|读写|阅读|写作|proficiency/i.test(direct)) {
        return { fieldKey: 'proficiency', label: group.fields.proficiency };
      }
      if (/语言|英语|外语|语种|级别|等级|水平|cet|language|level/i.test(direct)) {
        return { fieldKey: 'level', label: group.fields.level };
      }
    }

    // 某些门户把起止日期放在同一个“时间”标签下，两个输入框没有 start/end 的
    // name 或 placeholder。只在同一经历记录内恰好有两个同名时间字段时按顺序判断。
    if (['education', 'work', 'projects'].includes(groupKey) &&
        field.recordSameLabelTotal === 2 &&
        /(?:^|\s)(?:时间|日期)(?:\s|$)|请选择时间|select.?time/i.test(direct)) {
      const fieldKey = field.recordSameLabelIndex === 0 ? 'startDate' : 'endDate';
      return { fieldKey, label: group.fields[fieldKey] };
    }

    let best = null;
    // “奖励等级”既可能是行政级别，也可能是获奖等次；真实选项比字段名更可靠。
    if (groupKey === 'awards' && /奖励等级|奖项等级|award.?level/i.test(direct)) {
      const levelOptions = /国际级|国家级|国际\s*[\/／]\s*国家|省\s*[\/／]\s*市|校内|省部级|省区级|省级|县市级|市级|县级|院校级|校级|院级|班组级|公司级|集团级/.test(options);
      const gradeOptions = /特等|一等奖|二等奖|三等奖|一等|二等|三等/.test(options);
      if (levelOptions !== gradeOptions) {
        const fieldKey = levelOptions ? 'level' : 'grade';
        best = { fieldKey, label: group.fields[fieldKey], matchLength: 8 };
      } else {
        // 关闭状态的门户下拉常拿不到选项。先携带两种本地候选，打开控件后再按真实选项选择。
        best = {
          fieldKey: 'level',
          fieldKeyCandidates: ['level', 'grade'],
          label: '奖励等级',
          matchLength: 8
        };
      }
    }
    for (const [fieldKey, re] of QP_FIELD_PATTERNS[groupKey] || []) {
      const match = direct.match(re);
      if (match && (!best || match[0].length > best.matchLength)) {
        best = { fieldKey, label: group.fields[fieldKey], matchLength: match[0].length };
      }
    }
    for (const [fieldKey, label] of Object.entries(group.fields)) {
      if (!label) continue;
      const matched = direct.includes(label) || (direct.length <= 12 && label.includes(direct));
      if (!matched) continue;
      const matchLength = Math.min(label.length, direct.length);
      if (!best || matchLength > best.matchLength) best = { fieldKey, label, matchLength };
    }
    if (!best) return null;
    const valueFallbacks = {
      work: {
        hrContactName: ['hrContactName', 'certifierName'],
        hrContactPhone: ['hrContactPhone', 'certifierContact']
      },
      projects: {
        responsibilities: ['responsibilities', 'description']
      }
    };
    return {
      fieldKey: best.fieldKey,
      fieldKeyCandidates: best.fieldKeyCandidates || (valueFallbacks[groupKey] && valueFallbacks[groupKey][best.fieldKey]),
      label: best.label
    };
  }

  function matchStructuredRecordRules(fields, profile) {
    const mappings = [];
    const used = new Set();
    const reserved = new Set();
    for (const field of fields) {
      const groupKey = inferDescriptorGroupKey(field);
      if (!groupKey) continue;
      const records = profileRecordArray(profile, groupKey);
      if (!records.length) { enhancement?.sourceInfo(field, { sourceMissing: true }); continue; }
      const signature = descriptorFieldSignature(field, groupKey);
      if (!signature) continue;

      let recordIndex = -1;
      if (Number.isInteger(field.recordIndex) && field.recordIndex >= 0) {
        recordIndex = field.recordIndex;
      } else if (records.length === 1) {
        recordIndex = 0;
      } else if (Number.isInteger(field.sameLabelIndex) && field.sameLabelIndex >= 0 &&
                 field.sameLabelTotal === records.length) {
        // 缺少重复容器结构的旧站点：同标签字段数与简历记录数完全一致时，才按 DOM 顺序绑定。
        recordIndex = field.sameLabelIndex;
      }
      if (recordIndex < 0 || recordIndex >= records.length) {
        if (recordIndex >= records.length) enhancement?.sourceInfo(field, { sourceMissing: true });
        // 明确处于重复记录结构、或同标签本身重复时，留给 AI；只有一个顶层“毕业院校”之类的
        // 汇总字段仍允许后续最高学历规则直填，避免为了安全反而让常见字段重新走网络。
        if (field.recordGroupKey || (field.sameLabelTotal || 0) > 1) reserved.add(field);
        continue;
      }
      reserved.add(field);

      const fieldKeys = signature.fieldKeyCandidates || [signature.fieldKey];
      let valueCandidates;
      if (groupKey === 'languages' && signature.fieldKey === 'proficiency') {
        valueCandidates = languageProficiencyValueCandidates(records[recordIndex], descriptorDirectText(field));
      } else if (groupKey === 'education' && signature.fieldKey === 'gpa') {
        valueCandidates = educationGpaValueCandidates(records[recordIndex], descriptorDirectText(field));
      } else {
        valueCandidates = profileRecordValueCandidates(records[recordIndex], groupKey, fieldKeys);
      }
      if (!valueCandidates.length && ((groupKey === 'papers' && signature.fieldKey === 'yearIssue') ||
          (groupKey === 'awards' && signature.fieldKey === 'summary') ||
          (groupKey === 'education' && signature.fieldKey === 'isOverseas'))) {
        valueCandidates = derivedRecordValueCandidates(records[recordIndex], groupKey, signature.fieldKey, field.label);
      }
      const rawKeys = keys => keys.flatMap(key => [key, ...(PROFILE_RECORD_FIELD_ALIASES[groupKey]?.[key] || [])]);
      const hasSource = key => records[recordIndex]?.[key] != null && String(records[recordIndex][key]).trim();
      const provenanceKeys = rawKeys(fieldKeys).filter(hasSource);
      if (!provenanceKeys.length && valueCandidates.length) {
        const derivedKeys = groupKey === 'awards' && signature.fieldKey === 'summary' ? ['category', 'level', 'grade', 'issuer'] :
          groupKey === 'papers' && signature.fieldKey === 'yearIssue' ? ['publishDate'] :
          groupKey === 'education' && signature.fieldKey === 'isOverseas' ? ['schoolNature', 'eduType'] : fieldKeys;
        provenanceKeys.push(...rawKeys(derivedKeys).filter(hasSource));
      }
      const scalarLanguage = groupKey === 'languages' && typeof profile.languages === 'string';
      const sourceRefs = scalarLanguage ? ['languages'] : (provenanceKeys.length ? provenanceKeys : fieldKeys).map(key => `${groupKey}.${recordIndex}.${key}`);
      enhancement?.sourceInfo(field, {
        sourceRefs,
        sourceMissing: !provenanceKeys.length && !valueCandidates.length,
        sourceCandidates: valueCandidates.map(value => ({
          sourceRef: scalarLanguage ? 'languages' : `${groupKey}.${recordIndex}.${provenanceKeys.find(key => String(records[recordIndex][key]).trim() === value) || provenanceKeys[0] || fieldKeys[0]}`, value
        }))
      });
      if (!valueCandidates.length) continue;
      const group = QP_ARRAY_GROUPS.find(item => item.key === groupKey);
      mappings.push({
        selector: field.selector,
        value: valueCandidates[0],
        ...(valueCandidates.length > 1 ? { valueCandidates } : {}),
        componentType: field.componentType,
        label: `${group.title}${recordIndex + 1} · ${signature.label}`,
        ...(enhancement ? { sourceRef: sourceRefs.join(' + ') } : {}),
        fromLocalRule: true,
        recordGroupKey: groupKey,
        recordIndex
      });
      used.add(field);
    }
    return { mappings, remaining: fields.filter(field => !used.has(field)), reserved };
  }

  // ===== 本地规则直填（本体规则）：常见基本信息按字段标签直接匹配简历值，不经过 LLM =====
  // 返回 { mappings, remaining }：命中规则且有值的字段直接产出填充映射，其余字段继续走 AI。
  // 规则按优先级排列，先匹配先赢；"紧急联系人/就读院校城市/期望城市2"等易被通用规则误吃的
  // 更特定规则放前面。规则只填简历里确实有值的字段，避免误填。
  // 多记录字段先走上面的结构化快速路径；无法确定记录序号的字段才交给 AI。
  function matchByLocalRules(fields, profile) {
    const structured = matchStructuredRecordRules(fields, profile);
    const basic = profile.basic || {};
    const intention = profile.jobIntention || {};
    const extra = profile.extra || {};
    const edu = (profile.education || []).find(x => x.isHighest === '是') || (profile.education || [])[0] || {};

    const rules = [
      // ---- 紧急联系人（必须先于通用电话规则；"关系"最具体放最前，避免被"紧急联系人"误匹配）----
      { re: /紧急联系人关系|紧急.*关系|与紧急.*关系/i, val: () => basic.emergencyRelation, sourceRef: 'basic.emergencyRelation', label: '紧急联系人关系' },
      { re: /紧急联系电话|紧急联系方式|紧急联系人电话|emergency.*(?:phone|tel|contact)/i, val: () => basic.emergencyPhone, sourceRef: 'basic.emergencyPhone', label: '紧急联系电话' },
      { re: /紧急联系人姓名|紧急联系人|紧急.*姓名|emergency contact/i, val: () => basic.emergencyName, sourceRef: 'basic.emergencyName', label: '紧急联系人' },
      // ---- 特定字段（先于易误匹配的通用规则）----
      { re: /就读院校所在城市|院校所在城市|就读院校.*城市/i, val: () => extra.schoolCity, sourceRef: 'extra.schoolCity', label: '就读院校所在城市' },
      { re: /期望工作地点2|期望城市2|期望地点2/i, val: () => intention.city2, sourceRef: 'jobIntention.city2', label: '期望城市2' },
      { re: /是否服从.*调剂|服从公司调剂|服从调剂/i, val: () => intention.obeyAllocate, sourceRef: 'jobIntention.obeyAllocate', label: '是否服从调剂' },
      { re: /是否有运营商实习经验|运营商实习经验/i, val: () => extra.operatorExp, sourceRef: 'extra.operatorExp', label: '运营商实习经验' },
      { re: /是否接受岗位调剂|接受岗位调剂|是否接受调剂/i, val: () => extra.jobTransfer, sourceRef: 'extra.jobTransfer', label: '是否接受岗位调剂' },
      { re: /高考生源地|生源地/i, val: () => extra.gaokaoOrigin, sourceRef: 'extra.gaokaoOrigin', label: '高考生源地' },
      // ---- 基本信息 ----
      { re: /姓名|名字|\bname\b/i, val: () => basic.name, sourceRef: 'basic.name', label: '姓名' },
      { re: /性别|\bgender\b|\bsex\b/i, val: () => basic.gender, sourceRef: 'basic.gender', label: '性别' },
      { re: /出生日期|出生年月|生日|出生时间|\bbirth/i, val: () => basic.birthday, sourceRef: 'basic.birthday', label: '出生日期' },
      { re: /手机号|手机号码|移动电话|手机|\bphone\b|\bmobile\b/i, exclude: SECURITY_FIELD_RE, val: () => basic.phone, sourceRef: 'basic.phone', label: '手机号' },
      { re: /邮箱|电子邮箱|电子邮件|\bemail\b/i, val: () => basic.email, sourceRef: 'basic.email', label: '邮箱' },
      { re: /民族|\bethnic/i, val: () => basic.ethnicity, sourceRef: 'basic.ethnicity', label: '民族' },
      { re: /政治面貌|政治面目|\bparty\b/i, val: () => basic.political, sourceRef: 'basic.political', label: '政治面貌' },
      { re: /籍贯|\bnative\b/i, val: () => basic.nativePlace, sourceRef: 'basic.nativePlace', label: '籍贯' },
      { re: /户籍所在地|户口所在地|户籍|\bhukou\b/i, val: () => basic.hukou, sourceRef: 'basic.hukou', label: '户籍所在地' },
      { re: /现居住城市|现居住地|居住城市|居住地|所在城市|常驻城市|现所在地|现住址|\blocation\b/i, val: () => basic.location, sourceRef: 'basic.location', label: '现居住城市' },
      { re: /证件号码|身份证号码|身份证号|证件号|id\s?number/i, val: () => basic.idCard, sourceRef: 'basic.idCard', label: '证件号码' },
      { re: /证件类型|证件类别|id\s?type/i, val: () => basic.idType, sourceRef: 'basic.idType', label: '证件类型' },
      { re: /婚姻状况|婚否|\bmarital\b/i, val: () => basic.marital, sourceRef: 'basic.marital', label: '婚姻状况' },
      { re: /毕业时间|毕业日期|\bgraduation/i, val: () => basic.graduationDate, sourceRef: 'basic.graduationDate', label: '毕业时间' },
      { re: /是否应届|应届毕业生|\bfresh\b/i, val: () => basic.freshGraduate, sourceRef: 'basic.freshGraduate', label: '是否应届毕业生' },
      { re: /国籍|\bnationality\b/i, val: () => basic.nationality, sourceRef: 'basic.nationality', label: '国籍' },
      { re: /身高|\bheight\b/i, val: () => basic.height, sourceRef: 'basic.height', label: '身高' },
      { re: /体重|\bweight\b/i, val: () => basic.weight, sourceRef: 'basic.weight', label: '体重' },
      { re: /到岗时间|入职时间|可到岗|报到时间|到职时间|available\s?date/i, val: () => basic.availableDate, sourceRef: 'basic.availableDate', label: '到岗时间' },
      { re: /微信号|\bwechat\b|微信/i, val: () => basic.wechat, sourceRef: 'basic.wechat', label: '微信号' },
      { re: /是否国内号码|国内号码|is.?domestic/i, val: () => basic.isDomesticMobile, sourceRef: 'basic.isDomesticMobile', label: '是否为国内号码' },
      { re: /健康|健康状况|\bhealth\b/i, val: () => extra.health, sourceRef: 'extra.health', label: '健康状况' },
      { re: /入党团时间|入党时间|入党.*时间/i, val: () => basic.joinPartyDate, sourceRef: 'basic.joinPartyDate', label: '入党团时间' },
      // ---- 最高学历（学校/专业/学历/学位）；负向排除"专业课程/院校性质"等易误中标签 ----
      { re: /毕业院校|学校名称|毕业学校|\bschool\b|学校(?!性质|类型|所在地|城市|编号|代码|名称|简介)|院校(?!性质|类型|所在地|城市|简介)/i, val: () => edu.school, sourceRef: `education.${(profile.education || []).indexOf(edu)}.school`, label: '学校名称' },
      { re: /所学专业|专业名称|主修专业|\bmajor\b|专业(?!课程|方向|类别|证书|名称)/i, val: () => edu.major, sourceRef: `education.${(profile.education || []).indexOf(edu)}.major`, label: '专业名称' },
      { re: /学历(?!证明|认证|报告)|教育层次|文化程度|\bdegree\b/i, val: () => edu.degree, sourceRef: `education.${(profile.education || []).indexOf(edu)}.degree`, label: '学历' },
      { re: /学位(?!证书|证明|认证)|degree\s?title/i, val: () => edu.degreeTitle, sourceRef: `education.${(profile.education || []).indexOf(edu)}.degreeTitle`, label: '学位' },
      // ---- 求职意向 ----
      { re: /期望职位|意向岗位|目标职位|期望岗位|求职意向/i, val: () => intention.position, sourceRef: 'jobIntention.position', label: '期望职位' },
      { re: /期望城市|期望工作地点|期望地点|意向城市|期望工作地/i, val: () => intention.city, sourceRef: 'jobIntention.city', label: '期望城市' },
      { re: /期望薪资|期望薪酬|期望月薪|期望工资|\bsalary\b/i, val: () => intention.salary, sourceRef: 'jobIntention.salary', label: '期望薪资' },
      { re: /工作性质|工作类型|期望工作性质/i, val: () => intention.type, sourceRef: 'jobIntention.type', label: '工作类型' },
      { re: /期望行业|意向行业|期望从事行业/i, val: () => intention.industry, sourceRef: 'jobIntention.industry', label: '期望行业' },
    ];
    const ethnicityOptionRule = {
      val: () => basic.ethnicity, sourceRef: 'basic.ethnicity',
      label: '民族（按下拉选项识别）'
    };

    // 先收集所有命中（含取值），再按"同一规则命中多个字段则全部交 AI"做去重保护
    const hits = [];
    for (const f of structured.remaining) {
      if (structured.reserved.has(f)) continue;
      const text = [f.section, f.label, f.placeholder, f.name, f.id, f.autocomplete, f.contextText].filter(Boolean).join(' ');
      const directText = [f.label, f.placeholder, f.name, f.id, f.autocomplete].filter(Boolean).join(' ');
      let hit = looksLikeEthnicityDropdown(f.options) ? ethnicityOptionRule : null;
      if (!hit && text) {
        for (const r of rules) {
          if (r.re.test(text) && !(r.exclude && r.exclude.test(directText))) { hit = r; break; }
        }
      }
      if (!hit) continue;
      let value;
      try { value = hit.val(); } catch (e) { value = null; }
      if (hit.sourceRef) enhancement?.sourceInfo(f, { sourceRefs: [hit.sourceRef], sourceMissing: value == null || String(value).trim() === '' });
      if (value == null || String(value).trim() === '') continue;   // 简历无值 → 交 AI（AI 也会跳过空字段）
      hits.push({ f, rule: hit, value: String(value) });
    }

    const countByRule = new Map();
    for (const h of hits) countByRule.set(h.rule, (countByRule.get(h.rule) || 0) + 1);

    const mappings = structured.mappings.slice();
    const remaining = [];
    const used = new Set();
    for (const f of structured.remaining) {
      if (structured.reserved.has(f)) continue;
      const h = hits.find(x => x.f === f);
      if (h && countByRule.get(h.rule) === 1) {
        mappings.push({ selector: f.selector, value: h.value, componentType: f.componentType, label: h.rule.label, fromLocalRule: true,
          ...(enhancement && h.rule.sourceRef ? { sourceRef: h.rule.sourceRef } : {}) });
        used.add(f);
      }
    }
    const structuredSelectors = new Set(structured.mappings.map(mapping => mapping.selector));
    for (const f of fields) {
      if (used.has(f) || structuredSelectors.has(f.selector)) continue;
      remaining.push(f);
    }
    if (mappings.length) console.log('[简历填充] 本地规则直填', mappings.length, '个字段:', mappings.map(m => m.label).join('、'));
    return enhancement?.localResult(fields, profile, { mappings, remaining }) || { mappings, remaining };
  }

  function normalizeComparableValue(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[\s\-_/，,、；;：:（）()]+/g, '')
      .replace(/(省|市|自治区|特别行政区)$/g, '');
  }

  function valuesEquivalent(actual, expected) {
    // 级别属于离散选项，避免“市级”只是“县市级”的子串就被双向判为相等。
    // 复查、点击推荐与下拉选项选择共用相同的别名/合并项规则。
    if (semanticOptionKey(actual).startsWith('level:') && semanticOptionKey(expected).startsWith('level:')) {
      return matchDropdownOption(actual, String(expected).trim()) > 0;
    }
    const a = normalizeComparableValue(actual);
    const e = normalizeComparableValue(expected);
    if (!a || !e) return false;
    return a === e || (Math.min(a.length, e.length) >= 2 && (a.includes(e) || e.includes(a)));
  }

  const ETHNICITY_BASE_NAMES = new Set([
    '汉', '蒙古', '回', '藏', '维吾尔', '苗', '彝', '壮', '布依', '朝鲜', '满', '侗', '瑶', '白',
    '土家', '哈尼', '哈萨克', '傣', '黎', '傈僳', '佤', '畲', '高山', '拉祜', '水', '东乡', '纳西',
    '景颇', '柯尔克孜', '土', '达斡尔', '仫佬', '羌', '布朗', '撒拉', '毛南', '仡佬', '锡伯',
    '阿昌', '普米', '塔吉克', '怒', '乌孜别克', '俄罗斯', '鄂温克', '德昂', '保安', '裕固', '京',
    '塔塔尔', '独龙', '鄂伦春', '赫哲', '门巴', '珞巴', '基诺'
  ]);

  function ethnicityOptionKey(value) {
    const text = String(value || '').trim().replace(/民族$/g, '').replace(/族$/g, '');
    return ETHNICITY_BASE_NAMES.has(text) ? `ethnicity:${text}` : '';
  }

  function looksLikeEthnicityDropdown(options) {
    if (!Array.isArray(options)) return false;
    const hits = new Set(options.map(ethnicityOptionKey).filter(Boolean));
    // 虚拟滚动下拉初次通常只渲染“汉族、阿昌族”等少数可见项，两个即可确认。
    return hits.size >= 2;
  }

  // 招聘网站和个人简历对同一枚举值常使用不同口径。例如用户数据采用“省部级”，
  // 页面可能只提供“省级”；“地市级/区县级/院校级”也常被简写。统一成语义键后，
  // 原生 select、自定义下拉、单选框和快速填充都能复用同一套兼容逻辑。
  function semanticOptionKey(value) {
    const text = String(value || '').trim().toLowerCase().replace(/[\s_\-/／（）()]/g, '');
    if (!text) return '';
    const ethnicity = ethnicityOptionKey(text);
    if (ethnicity) return ethnicity;
    const groups = [
      ['political:probationary-communist', /^(中共预备党员|中国共产党预备党员)$/],
      ['political:communist', /^(中共党员|中国共产党党员|中国共产党正式党员)$/],
      ['political:youth-league', /^(共青团员|中国共产主义青年团团员)$/],
      ['level:international', /^(国际级?|世界级)$/],
      ['level:national', /^(国家级?|全国级)$/],
      ['level:international-national', /^(国际级?国家级?|国家级?国际级?)$/],
      ['level:provincial', /^(省部级|省区级|省级|部级|省厅级)$/],
      ['level:city', /^(地市级|市级|市厅级)$/],
      ['level:provincial-city', /^(省级?市级?|市级?省级?)$/],
      ['level:county', /^(区县级|县级|县处级)$/],
      ['level:city-county', /^县市级$/],
      ['level:school', /^(院校级|学校级|校级)$/],
      ['level:college', /^(学院级|院系级|院级)$/],
      ['level:within-school', /^校内级?$/],
      ['level:class', /^班组级$/],
      ['level:company', /^公司级$/],
      ['level:group', /^集团级$/],
      ['grade:special', /^(特等|特等奖)$/],
      ['grade:first', /^(一等|一等奖|第一名)$/],
      ['grade:second', /^(二等|二等奖|第二名)$/],
      ['grade:third', /^(三等|三等奖|第三名)$/],
      ['publication:published', /^(已发表|正式发表|已出版)$/],
      ['publication:accepted', /^(已接收|已录用|录用)$/],
      ['publication:review', /^(在审|审稿中|审核中)$/],
      ['publication:submitted', /^(投稿中|已投稿)$/],
      ['patent:applied', /^(申请阶段|已申请|申请中)$/],
      ['patent:published', /^(公开阶段|已公开)$/],
      ['patent:granted', /^(授权阶段|已授权|授权)$/],
      ['employment:intern', /^(实习|实习生|实习经历)$/],
      ['employment:fulltime', /^(全职|正式|正式员工)$/],
      ['boolean:yes', /^(是|有|yes|true|y)$/i],
      ['boolean:no', /^(否|无|no|false|n)$/i],
      ['other', /^(其他|其它)$/]
    ];
    const hit = groups.find(([, re]) => re.test(text));
    return hit ? hit[0] : '';
  }

  async function executeFill(mappings, onProgress) {
    const succeeded = new Set();
    const failed = [];
    const total = mappings.length;

    // 日期对（起止时间）先填结束、后填开始：B 站校验"起始时间不能晚于结束时间"，
    // 页面上旧结束时间早于新开始时，先填开始会被拒、回退到旧值（实测 2026-06→2025-06）。
    // 日期字段按值倒序放到最后处理（不依赖 LLM 返回顺序）：每对结束在前、开始在后，
    // 且简历里 start ≤ end 保证都通过
    const dependencyControls = [];
    const rest = [];
    const dates = [];
    for (const m of mappings) {
      if (m.componentType === 'custom-datepicker') dates.push(m);
      else if (m.componentType === 'native-select' || m.componentType === 'native-radio' ||
               m.componentType === 'native-checkbox' || m.componentType === 'custom-dropdown') {
        dependencyControls.push(m);
      } else rest.push(m);
    }
    // 选择类字段经常决定后续文本控件的真实节点（中国电信“奖项类别”会把奖励名称从
    // school-or-subject=1 替换成 =2）。先完成所有选择类字段，再重新扫描并填写文本/日期。
    const ordered = dependencyControls.concat(rest, dates.sort((a, b) => dateSortKey(b.value) - dateSortKey(a.value)));
    let refreshedFields = null;

    for (let i = 0; i < ordered.length; i++) {
      enhancement?.check();
      const mapping = ordered[i];
      if (enhancement?.blockedMapping(mapping)) continue;
      if (i === dependencyControls.length && dependencyControls.length > 0 && i < ordered.length) {
        await waitForFieldLayoutStable(900, 75);
        refreshedFields = collectFields();
      }
      // 防御：LLM 返回空值时跳过，避免填充空字段
      if (mapping.value === null || mapping.value === undefined || mapping.value === '') {
        if (onProgress) onProgress(i + 1, total);
        continue;
      }
      let resolvedField = refreshedFields ? resolveMappingField(mapping, refreshedFields) : null;
      let selectorForFill = resolvedField ? resolvedField.selector : mapping.selector;
      let el = findElement(selectorForFill);
      // 即使当前阶段没有选择类字段，Angular 也可能在扫描后替换节点。旧节点已隐藏或卸载时，
      // 立即按业务身份复扫定位最新控件，避免把值写进仍留在 DOM 内的隐藏展示 input。
      if (mapping.fieldIdentity && (!el || !isVisible(el))) {
        const liveFields = collectFields();
        resolvedField = resolveMappingField(mapping, liveFields);
        selectorForFill = resolvedField ? resolvedField.selector : mapping.selector;
        el = findElement(selectorForFill);
      }
      if (!el) {
        console.log('[简历填充] 未找到元素:', mapping.selector, mapping.componentType);
        failed.push(mapping);
        if (onProgress) onProgress(i + 1, total);
        continue;
      }

      const value = String(mapping.value);
      const componentType = resolvedField ? detectComponentType(el) : (mapping.componentType || detectComponentType(el));
      // 同一字段可能因动态复扫或组件重渲染再次进入映射队列；目标值已经存在时直接确认成功，
      // 不再重新打开下拉/日期面板，也不重复触发 input/change。
      if (isMappingAlreadySatisfied(mapping, el, componentType)) {
        succeeded.add(mapping.selector);
        if (onProgress) onProgress(i + 1, total);
        continue;
      }
      const candidateValues = Array.isArray(mapping.valueCandidates)
        ? mapping.valueCandidates.map(item => String(item)).filter(Boolean)
        : [value];
      const fillValue = /custom-(?:dropdown|interactive)/.test(componentType) && candidateValues.length > 1
        ? candidateValues
        : value;

      try {
        let ok = await fillByType(el, fillValue, componentType, selectorForFill);
        // React/Vue 自定义控件可能已经选中，但显示值晚于点击结果写回；给一次短稳定窗口，
        // 避免把“已成功但尚未渲染”误判为失败并在整轮末尾再次选择。
        if (!ok && (componentType.startsWith('custom-') || componentType === 'native-radio' || componentType === 'native-checkbox')) {
          ok = await waitForCondition(() => {
            const fresh = findElement(selectorForFill) || el;
            return isMappingAlreadySatisfied(mapping, fresh, componentType);
          }, 320, 25);
        }
        if (ok) {
          highlightField(el);
          succeeded.add(mapping.selector);
        } else {
          failed.push(mapping);
          console.warn('[简历填充] 写入后校验未通过:', mapping.selector, componentType);
        }
      } catch (e) {
        failed.push(mapping);
        console.warn('[简历填充] 填充失败:', mapping.selector, componentType, e);
      }
      if (onProgress) onProgress(i + 1, total);
      // 文本写入和自定义控件内部已经完成必要等待；这里只给可能触发条件字段的选择控件
      // 留一个很短的渲染窗口，避免每个普通输入框固定空等。
      if (componentType === 'native-select' || componentType === 'native-radio' || componentType === 'native-checkbox') {
        await sleep(25);
      }
    }

    // 对少量失败的交互控件做一次就地重试；日期选择器内部已经自带导航重试，
    // 这里不能再整轮重填，否则同一时间会反复打开日历并触发多次页面校验。
    const retryable = failed.filter(m => {
      const type = m.componentType || '';
      return (type.startsWith('custom-') && type !== 'custom-datepicker') || type === 'native-select' ||
             type === 'native-radio' || type === 'native-checkbox';
    }).slice(0, 12);
    if (retryable.length > 0) {
      await sleep(100);
      for (const mapping of retryable) {
        enhancement?.check();
        if (enhancement?.blockedMapping(mapping)) continue;
        if (succeeded.has(mapping.selector)) continue;
        const liveFields = mapping.fieldIdentity ? collectFields() : null;
        const resolvedField = liveFields ? resolveMappingField(mapping, liveFields) : null;
        const selectorForFill = resolvedField ? resolvedField.selector : mapping.selector;
        const el = findElement(selectorForFill);
        if (!el) continue;
        const componentType = resolvedField ? detectComponentType(el) : (mapping.componentType || detectComponentType(el));
        // 第一次操作可能已在异步渲染期间成功；重试前必须再次读取当前值。
        if (isMappingAlreadySatisfied(mapping, el, componentType)) {
          succeeded.add(mapping.selector);
          continue;
        }
        const candidateValues = Array.isArray(mapping.valueCandidates)
          ? mapping.valueCandidates.map(item => String(item)).filter(Boolean)
          : [String(mapping.value)];
        const fillValue = /custom-(?:dropdown|interactive)/.test(componentType) && candidateValues.length > 1
          ? candidateValues
          : String(mapping.value);
        try {
          const ok = await fillByType(el, fillValue, componentType, selectorForFill);
          if (ok) {
            succeeded.add(mapping.selector);
            highlightField(el);
          }
        } catch (e) {
          console.warn('[简历填充] 重试仍失败:', mapping.selector, e);
        }
      }
    }

    // 兜底清理：关闭可能残留的下拉/日期面板
    await closeAllPanels();
    return { count: succeeded.size, failed: mappings.filter(m => !succeeded.has(m.selector)) };
  }

  // ===== 证件照填充（file 字段，不走 AI 文本流） =====
  const PHOTO_WORDS = /照片|证件照|头像|形象照|相片|一寸|二寸|半身|photo|avatar|headshot|portrait|picture|image|pic/i;

  function findPhotoInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    // 优先：label/name/上下文 命中照片关键词
    for (const el of inputs) {
      const text = [
        getLabelText(el),
        el.name || '',
        el.getAttribute('accept') || '',
        getPlaceholder(el),
        getContextText(el)
      ].join(' ');
      if (PHOTO_WORDS.test(text)) return el;
    }
    // 兜底：仅接受图片的 file input（页面只有一种图片上传时）
    for (const el of inputs) {
      const accept = (el.getAttribute('accept') || '').toLowerCase();
      if (accept.includes('image')) return el;
    }
    return null;
  }

  async function setPhotoFile(input, dataUrl) {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const mime = blob.type || 'image/jpeg';
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
      const file = new File([blob], `resume-photo.${ext}`, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e) {
      console.warn('[简历填充] 照片写入失败', e);
      return false;
    }
  }

  async function fillPhoto(photoDataUrl) {
    if (!photoDataUrl) return 0;
    const input = findPhotoInput();
    if (!input) return 0;
    const ok = await setPhotoFile(input, photoDataUrl);
    if (ok) {
      highlightField(input);
      return 1;
    }
    return 0;
  }

  async function fillByType(el, value, componentType, selector) {
    switch (componentType) {
      case 'native-input':
        return fillNativeInput(el, value);
      case 'wrapper-input': {
        const inner = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
          ? el : el.querySelector('input:not([type="hidden"]), textarea');
        return inner ? fillNativeInput(inner, value) : false;
      }
      case 'native-select':
        return fillNativeSelect(el, value, selector);
      case 'native-radio':
      case 'native-checkbox':
        return fillNativeChoice(el, value, componentType === 'native-checkbox');
      case 'contenteditable':
        return fillContentEditable(el, value);
      case 'custom-dropdown':
        return fillGenericDropdown(el, value);
      case 'custom-interactive':
        // 只读但无法预先判类型：先当自定义下拉尝试（最常见），失败则当日期
        if (await fillGenericDropdown(el, value)) return true;
        {
          const primaryValue = Array.isArray(value) ? value[0] : value;
          if (/^\d{4}(?:[-/.]\d{1,2})?(?:[-/.]\d{1,2})?$/.test(primaryValue)) {
            return fillGenericDatepicker(el, primaryValue, selector);
          }
        }
        return false;
      case 'custom-datepicker':
        return fillGenericDatepicker(el, value, selector);
      default:
        // 兜底：尝试当原生 input 填充
        if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') {
          return fillNativeInput(el, value);
        } else {
          // 最后尝试：找到内部 input 填充
          const inner = el.querySelector('input:not([type="hidden"])');
          return inner ? fillNativeInput(inner, value) : false;
        }
    }
    return false;
  }

  // ===== 各类型填充实现 =====

  function parseDateValueParts(value) {
    const raw = String(value == null ? '' : value).trim();
    const match = /^(\d{4})(?:[-/.年](\d{1,2}))?(?:[-/.月](\d{1,2}))?日?/.exec(raw);
    if (!match) return null;
    return {
      year: +match[1],
      month: match[2] ? +match[2] : 0,
      day: match[3] ? +match[3] : 0
    };
  }

  function dateFieldPrecision(el) {
    const input = el && el.tagName === 'INPUT' ? el : (el && el.querySelector ? el.querySelector('input') : null);
    if (!input) return 'auto';
    const type = String(input.type || '').toLowerCase();
    if (type === 'month') return 'month';
    if (type === 'date' || type === 'datetime-local') return 'day';

    const signals = [];
    let current = input;
    for (let depth = 0; depth < 5 && current; depth++, current = current.parentElement) {
      if (typeof current.className === 'string') signals.push(current.className);
      if (current.getAttribute) {
        for (const attr of ['placeholder', 'aria-label', 'name', 'data-picker', 'data-type', 'format']) {
          const attrValue = current.getAttribute(attr);
          if (attrValue) signals.push(attrValue);
        }
      }
    }
    const signal = signals.join(' ').toLowerCase();
    // 月份模式优先于普通 date 命名：例如 name="graduationDate" + class="el-date-editor--month"。
    if (/month[-_ ]?(?:picker|range)?|(?:picker|range)[-_ ]?month|ant-picker-month|el-date-editor--month|arco-picker-month|年月(?!日)|月份|yyyy\s*[-/.年]?\s*mm(?!\s*[-/.日]?\s*dd)/i.test(signal)) return 'month';
    if (/year[-_ ]?picker|picker[-_ ]?year|ant-picker-year|el-date-editor--year|年份|年度|yyyy(?![\s\S]*mm)/i.test(signal)) return 'year';
    if (/date[-_ ]?picker|datepicker|calendar|日期|年月日|yyyy[\s\S]*mm[\s\S]*dd/i.test(signal)) return 'day';
    return 'auto';
  }

  // 简历可保存到具体日期，但招聘网站有些控件只接受 YYYY-MM。
  // 按目标控件精度裁剪，不凭字段名称盲目丢弃“日”。
  function formatDateValueForField(el, value) {
    const raw = String(value == null ? '' : value).trim();
    const parts = parseDateValueParts(raw);
    if (!parts) return raw;
    const precision = dateFieldPrecision(el);
    const year = String(parts.year).padStart(4, '0');
    const month = parts.month ? String(parts.month).padStart(2, '0') : '';
    const day = parts.day ? String(parts.day).padStart(2, '0') : '';
    if (precision === 'year') return year;
    if (precision === 'month' && month) return `${year}-${month}`;
    if (precision === 'day' && month) return `${year}-${month}-${day || '01'}`;
    return raw;
  }

  function dateValuesMatchPrecision(actual, expected) {
    const a = parseDateValueParts(actual);
    const e = parseDateValueParts(expected);
    if (!a || !e || a.year !== e.year) return false;
    if (e.month && a.month !== e.month) return false;
    // 月份选择器不会返回 day；仅当两边都有日时才要求日一致。
    if (e.day && a.day && a.day !== e.day) return false;
    return true;
  }

  function fillNativeInput(el, value) {
    let v = String(value);
    if (el.tagName.toLowerCase() === 'input' && ['date', 'month'].includes(String(el.type || '').toLowerCase())) {
      v = formatDateValueForField(el, v);
    }
    // 原生 date 输入框只接受 YYYY-MM-DD：简历常见 YYYY-MM，补 "-01" 避免被浏览器置空
    if (el.tagName.toLowerCase() === 'input' && el.type === 'date' && /^\d{4}-\d{1,2}$/.test(v)) v += '-01';
    if (typeof el.focus === 'function') el.focus();
    const proto = el.tagName.toLowerCase() === 'textarea'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // Angular/jQuery 的旧式联想输入有时只监听 keyup；补发事件可让文本写回业务状态。
    if (typeof KeyboardEvent !== 'undefined') {
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '' }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof el.blur === 'function') el.blur();
    else el.dispatchEvent(new Event('blur', { bubbles: true }));
    return valuesEquivalent(el.value, v);
  }

  function findNativeSelectOption(el, value) {
    const candidates = (Array.isArray(value) ? value : [value])
      .map(item => String(item || '').trim()).filter(Boolean);
    const options = Array.from(el.options || []);
    for (const wanted of candidates) {
      const exact = options.find(opt => {
        const text = (opt.textContent || '').trim();
        return text === wanted || opt.value === wanted ||
          (semanticOptionKey(text) && semanticOptionKey(text) === semanticOptionKey(wanted));
      });
      if (exact) return { option: exact, wanted };
    }
    let best = null;
    for (const wanted of candidates) {
      for (const option of options) {
        const text = (option.textContent || '').trim();
        const score = matchDropdownOption(text, wanted);
        if (score > ((best && best.score) || 0)) best = { option, wanted, score };
      }
    }
    return best;
  }

  function nativeSelectSatisfied(el, option, wanted) {
    const selected = el.selectedOptions && el.selectedOptions[0];
    const selectedText = selected ? (selected.textContent || '').trim() : '';
    return el.value === option.value || valuesEquivalent(selectedText, wanted) ||
      matchDropdownOption(selectedText, wanted) > 0;
  }

  function styledNativeSelectContainer(el) {
    let container = el.closest && el.closest(
      '.bootstrap-select, [class*="bootstrap-select"], [class*="selectpicker"], [data-select2-id]'
    );
    if (container === el) container = el.parentElement;
    if (!container && el.parentElement) {
      container = el.parentElement.querySelector(
        ':scope > .bootstrap-select, :scope > [class*="bootstrap-select"], :scope > [class*="selectpicker"]'
      );
    }
    return container && container.querySelector && container.querySelector('button, [role="combobox"]')
      ? container : null;
  }

  function styledNativeSelectDisplay(container) {
    if (!container) return '';
    const node = container.querySelector(
      '.filter-option-inner-inner, .filter-option, [class*="selection-rendered"], [class*="selection-item"], button .text'
    );
    return node ? (node.textContent || '').trim() : '';
  }

  async function fillStyledNativeSelect(el, option, wanted) {
    const container = styledNativeSelectContainer(el);
    if (!container) return false;
    const trigger = container.querySelector(
      'button.dropdown-toggle, button[aria-haspopup="listbox"], button[data-toggle="dropdown"], [role="combobox"]'
    );
    if (!trigger || typeof trigger.click !== 'function') return false;

    const optionSelector = [
      '.dropdown-menu li:not(.disabled) a', '.dropdown-menu [role="option"]',
      '.dropdown-menu .dropdown-item', 'li[data-original-index] a', '[role="listbox"] [role="option"]'
    ].join(',');
    const collect = () => {
      const result = Array.from(container.querySelectorAll(optionSelector));
      const owns = trigger.getAttribute('aria-owns') || trigger.getAttribute('aria-controls');
      if (owns) {
        const external = document.getElementById(owns);
        if (external) result.push(...external.querySelectorAll(optionSelector + ', [role="option"]'));
      }
      return result.filter((node, index, all) => all.indexOf(node) === index && isVisible(node));
    };
    // 用户可能在点击自动填充前已经展开了下拉。此时再次点击按钮会把面板关闭，导致后续
    // 找不到任何选项；只有当前组件尚无可见选项时才执行打开动作。
    if (collect().length === 0) {
      if (typeof trigger.dispatchEvent === 'function' && typeof MouseEvent !== 'undefined') {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
      trigger.click();
      await waitForCondition(() => collect().length > 0, 360, 20);
    }
    let best = null;
    let bestScore = 0;
    for (const candidate of collect()) {
      const text = (candidate.textContent || '').trim();
      const score = matchDropdownOption(text, wanted) ||
        matchDropdownOption(text, (option.textContent || '').trim());
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best) return false;
    await clickOptionWithRetryAsync(best, el, wanted);
    await sleep(80);
    return nativeSelectSatisfied(el, option, wanted);
  }

  function applyNativeSelectValue(el, option) {
    if (!el || !option) return false;
    if (typeof el.focus === 'function') el.focus();
    Array.from(el.options || []).forEach(item => { item.selected = item === option; });
    el.selectedIndex = option.index;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, option.value); else el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof el.blur === 'function') el.blur();
    return true;
  }

  async function fillNativeSelect(el, value, selector) {
    let current = el;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (selector) current = findElement(selector) || current;
      const match = findNativeSelectOption(current, value);
      if (!match || !match.option) return false;
      applyNativeSelectValue(current, match.option);

      // 不能校验旧引用：Vue/Angular 常在 change 后替换整个 select。旧节点仍保留刚写入的值，
      // 但页面里的新节点已经回到“请选择”，这正是论文/奖励下拉看似成功却保持空白的原因。
      await sleep(140);
      const fresh = selector ? (findElement(selector) || current) : current;
      const freshMatch = findNativeSelectOption(fresh, value);
      if (!freshMatch || !freshMatch.option) return false;
      let nativeOk = nativeSelectSatisfied(fresh, freshMatch.option, freshMatch.wanted);
      const styled = styledNativeSelectContainer(fresh);
      const styledDisplay = styledNativeSelectDisplay(styled);
      const styledOutOfSync = styled && (!styledDisplay || /请选择|选择/.test(styledDisplay) ||
        !(valuesEquivalent(styledDisplay, freshMatch.wanted) || matchDropdownOption(styledDisplay, freshMatch.wanted) > 0));
      if (nativeOk && !styledOutOfSync) return true;
      if (!nativeOk || styledOutOfSync) {
        const styledOk = await fillStyledNativeSelect(fresh, freshMatch.option, freshMatch.wanted);
        await sleep(80);
        const verified = selector ? (findElement(selector) || fresh) : fresh;
        const verifiedMatch = findNativeSelectOption(verified, value);
        nativeOk = !!verifiedMatch && (
          styledOk || nativeSelectSatisfied(verified, verifiedMatch.option, verifiedMatch.wanted)
        );
        if (nativeOk) return true;
      }
      current = fresh;
    }
    return false;
  }

  function fillNativeChoice(el, value, multiple) {
    const choices = getChoiceGroupElements(el).filter(isChoiceVisible);
    if (!choices.length) return false;
    const requested = multiple
      ? String(value).split(/[\n,，、;；|]+/).map(x => x.trim()).filter(Boolean)
      : [String(value).trim()];
    const targets = [];
    for (const wanted of requested) {
      let best = null, bestLen = 0;
      for (const choice of choices) {
        const text = getChoiceOptionText(choice);
        const len = matchDropdownOption(text, wanted);
        if (len > bestLen) { best = choice; bestLen = len; }
      }
      if (best && !targets.includes(best)) targets.push(best);
    }
    if (!targets.length) return false;
    for (const choice of choices) {
      const shouldCheck = targets.includes(choice);
      if ((!multiple && !shouldCheck) || choice.checked === shouldCheck) continue;
      choice.click();
      // 某些旧页面 click handler 只处理业务状态但不保留原生 checked，补一次原生 setter。
      if (choice.checked !== shouldCheck) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        if (setter) setter.call(choice, shouldCheck); else choice.checked = shouldCheck;
        choice.dispatchEvent(new Event('input', { bubbles: true }));
        choice.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return targets.every(choice => choice.checked);
  }

  function fillContentEditable(el, value) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return valuesEquivalent(el.textContent, value);
  }

  // 读取自定义下拉字段当前已选中的显示值（如 Moka .sd-Input-display-value-* span）
  function getDropdownDisplayValue(el) {
    if (!el) return '';
    const phoenix = el.closest && el.closest('.phoenix-select');
    if (phoenix && /(?:^|\s)phoenix-select(?:\s|$)/.test(phoenix.className || '')) {
      // Phoenix 的 input 是搜索框，已选日期/学历保存在 tag 中，搜索值不能充当已提交值。
      const selected = phoenix.querySelector('.phoenix-select__tag');
      return selected ? (selected.textContent || '').trim() : '';
    }
    // bootstrap-select 的扫描对象通常是可见的 .bootstrap-select 外层 div，真实值保存在
    // 内部 opacity:0 的 select 中。先读内部 select/按钮，避免把外层 div 误判为空。
    const bootstrap = getBootstrapSelectContainer(el);
    if (bootstrap) {
      const nativeSelect = bootstrap.querySelector('select.selectpicker, select');
      if (nativeSelect) {
        const selected = nativeSelect.selectedOptions && nativeSelect.selectedOptions[0];
        const selectedText = selected ? (selected.textContent || '').trim() : '';
        if (nativeSelect.value && selectedText && !/^(请选择|选择|--)/.test(selectedText)) return selectedText;
      }
      const button = bootstrap.querySelector('button.dropdown-toggle, button[data-toggle="dropdown"]');
      const buttonText = button && (
        button.getAttribute('title') ||
        button.querySelector('.filter-option-inner-inner, .filter-option')?.textContent ||
        button.textContent || ''
      ).trim();
      if (buttonText && !/^(请选择|选择|--)/.test(buttonText)) return buttonText;
    }
    if ('value' in el && String(el.value || '').trim() && !isPlaceholderLikeValue(el)) {
      return String(el.value).trim();
    }
    if (el && el.closest) {
      const ownClass = typeof el.className === 'string' ? el.className : '';
      const legacySelf = /(^|\s)slt(?:\d+)?(?:\s|$)/i.test(ownClass) ? el : null;
      const container = legacySelf || el.closest(
        'label[class*="Select-container"], [class*="sd-Select-container"], [class*="select-container"], ' +
        '[class*="ant-select"], [class*="select-selector"], [class~="slt"], label'
      );
      const containers = [container, el.parentElement, el.parentElement && el.parentElement.parentElement]
        .filter((item, index, all) => item && all.indexOf(item) === index);
      for (const item of containers) {
        if (!item.querySelector) continue;
        const dv = item.querySelector('[class*="display-value"], [class*="selection-item"], [class*="selected"], [class*="value"], :scope > span');
        if (dv) {
          const t = dv.textContent.trim();
          if (t) return t;
        }
      }
    }
    return '';
  }

  // 安全点击选项：尝试目标→祖先，某些框架（如 Moka）点击处理器挂在
  // 选项的父元素上，直接点叶子 span 不生效。每次点击后立即验证，只有受控组件
  // 尚未写回时才短轮询；同步更新的普通下拉不再固定空等 250ms。
  // （1）input.value 变化（ant/B站/v-model 控件），或
  // （2）字段容器内显示值 span 文本变化（Moka 等自定义组件，input.value 不变）
  async function clickOptionWithRetryAsync(el, input, targetText) {
    const beforeValue = input ? String(input.value || '').trim() : '';
    const beforeDisplay = getDropdownDisplayValue(input);
    const changed = () => {
      const afterValue = input ? String(input.value || '').trim() : '';
      if (afterValue !== beforeValue) return true;
      const afterDisplay = getDropdownDisplayValue(input);
      return !!(afterDisplay && afterDisplay !== beforeDisplay);
    };
    const optionAccepted = () => {
      if (changed()) return true;
      try {
        // 单选下拉选中后通常立即收起/卸载选项；这也是可靠的成功信号，
        // 不能因为展示值尚未写回就继续点击选项祖先。
        return !el.isConnected || !isVisible(el);
      } catch {
        return false;
      }
    };
    for (let target = el, i = 0; i < 7 && target && target !== document.body; i++, target = target.parentElement) {
      if (typeof target.click !== 'function') continue;
      target.click();
      if (optionAccepted() || await waitForCondition(optionAccepted, 260, 20)) return true;
    }
    return false;
  }

  // 全文档扫描：在面板打开后，收集所有"新出现"的可见文本叶子节点作为候选选项
  // 不依赖 option/role/class 名，适用于 CSS Modules / hash 类名的自定义组件库
  function collectVisibleOptionCandidates(excludeSet, triggerEl, fieldEl) {
    const candidates = [];
    const triggerRect = triggerEl ? triggerEl.getBoundingClientRect() : null;
    const fieldClass = fieldEl && typeof fieldEl.className === 'string' ? fieldEl.className : '';
    const optionsLiveInsideField = /(^|\s)slt(?:\d+)?(?:\s|$)/i.test(fieldClass);
    // 优先只扫描当前字段和附近已打开的弹层。旧实现每一级下拉都遍历 document 的全部节点，
    // 在大型招聘页上会产生明显卡顿；仅在找不到任何局部候选时才回退全页扫描。
    const roots = [];
    if (fieldEl && fieldEl.querySelectorAll) roots.push(fieldEl);
    if (typeof PANEL_SELECTORS !== 'undefined') {
      for (const panel of document.querySelectorAll(PANEL_SELECTORS)) {
        if (!isVisible(panel) || (fieldEl && panel.contains(fieldEl))) continue;
        if (triggerRect) {
          const pr = panel.getBoundingClientRect();
          if (Math.abs(pr.top - triggerRect.top) > 700 || Math.abs(pr.left - triggerRect.left) > 500) continue;
        }
        roots.push(panel);
      }
    }
    const seenNodes = new Set();
    const scan = roots.length ? roots.flatMap(root => Array.from(root.querySelectorAll('*'))) : Array.from(document.querySelectorAll('*'));
    for (const el of scan) {
      if (seenNodes.has(el)) continue;
      seenNodes.add(el);
      if (excludeSet.has(el)) continue;
      if (!isVisible(el)) continue;
      if (el.contains(triggerEl)) continue;
      if (fieldEl && fieldEl.contains(el) && !optionsLiveInsideField) continue;
      if (el.closest('#resume-autofill-actions')) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
      const cls = (typeof el.className === 'string') ? el.className : '';
      if (/arrow|icon|caret|suffix|prefix|clear|close|remove/.test(cls)) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 1 || text.length > 30) continue;
      // leaf-ish: 无子元素，或所有子元素自身都无文本（只有图标/装饰等）
      if (el.children.length > 0) {
        const allEmpty = Array.from(el.children).every(c => !(c.textContent || '').trim());
        if (!allEmpty) continue;
      }
      // 就近过滤：候选必须离触发输入框不太远（~600px 纵向 / ~400px 横向），
      // 避免点到远距离的页面文本（lazy-load 内容、导航等非面板元素）
      if (triggerRect) {
        const cr = el.getBoundingClientRect();
        if (cr.width <= 0 || cr.height <= 0) continue;
        if (Math.abs(cr.top - (triggerRect.top + triggerRect.height / 2)) > 600) continue;
        if (Math.abs(cr.left - (triggerRect.left + triggerRect.width / 2)) > 400) continue;
      }
      candidates.push(el);
    }
    if (candidates.length === 0 && roots.length > 0) {
      // 极少数组件把选项挂在无语义的 body 直属节点上，保留一次兼容性回退。
      for (const el of document.querySelectorAll('body > div *, body > ul *, body > section *')) {
        if (seenNodes.has(el) || excludeSet.has(el) || !isVisible(el)) continue;
        if (el.contains(triggerEl) || (fieldEl && fieldEl.contains(el) && !optionsLiveInsideField)) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 30 || el.children.length > 0) continue;
        candidates.push(el);
      }
    }
    return candidates;
  }

  function collectCurrentDropdownOptions(optionSelectors, visibleBefore, trigger, el) {
    const triggerRect = trigger && typeof trigger.getBoundingClientRect === 'function'
      ? trigger.getBoundingClientRect()
      : null;
    const classOpts = Array.from(document.querySelectorAll(optionSelectors))
      .filter(option => !visibleBefore.has(option))
      .filter(isVisible)
      .filter(option => {
        const cls = typeof option.className === 'string' ? option.className : '';
        if (/arrow|icon|caret|clear|close|remove/.test(cls)) return false;
        if (!(option.textContent || '').trim()) return false;
        if (option.contains(el) || el.contains(option)) return false;
        if (triggerRect && typeof option.getBoundingClientRect === 'function') {
          const optionRect = option.getBoundingClientRect();
          if (Math.abs(optionRect.top - (triggerRect.top + triggerRect.height / 2)) > 600) return false;
          if (Math.abs(optionRect.left - (triggerRect.left + triggerRect.width / 2)) > 400) return false;
        }
        return true;
      });
    const seen = new Set(classOpts);
    for (const option of collectVisibleOptionCandidates(visibleBefore, trigger, el)) {
      if (!seen.has(option)) {
        classOpts.push(option);
        seen.add(option);
      }
    }
    return classOpts;
  }

  // 通用下拉框填充（Ant Design / Element / Arco / 任意自定义下拉；支持省/市级联逐级选择）
  async function fillGenericDropdown(el, value) {
    const candidates = (Array.isArray(value) ? value : [value])
      .map(item => String(item || '').trim())
      .filter((item, index, all) => item && all.indexOf(item) === index);
    let v = candidates[0] || '';
    if (!v) return false;
    // WinTalent/中国电信使用 bootstrap-select：页面展示的是 div+button，Angular 模型绑定在
    // 内部 select。通用路径会点击外层 div 而没有任何效果，必须经隐藏 select 写值并在必要时
    // 点击当前组件自己的 li[data-original-index]，由 change 事件同步 Angular 与展示按钮。
    const bootstrapSelect = getBootstrapNativeSelect(el);
    if (bootstrapSelect) {
      const bootstrapOk = await fillNativeSelect(bootstrapSelect, candidates);
      if (bootstrapOk) return true;
    }
    const currentDisplay = getDropdownDisplayValue(el);
    if (candidates.some(candidate => valuesEquivalent(currentDisplay, candidate) || matchDropdownOption(currentDisplay, candidate) > 0)) {
      return true;
    }

    // 1. 记录打开前已可见的选项（属于其他已打开的面板），避免误点；
    //    只排除"打开前就可见"的，隐藏后由本次打开显示的面板选项不会被误排除
    const optionSelectors = [
      '[role="option"]', '[class*="option"]', '[class*="dropdown-item"]',
      '[class*="select-item"]', '[class*="menu-item"]', 'li[class*="item"]',
      // 菜单容器内叶子节点（泛用兜底：Moka sd-Select-menu 裸 span 无 role/class）
      '[class*="select"] [class*="menu"] > *:not([class*="arrow"]):not([class*="icon"])',
      '[class*="dropdown"] [class*="menu"] > *:not([class*="arrow"]):not([class*="icon"])',
      '[class*="menu"] > li', '[class*="menu"] > div[role="none"]'
    ].join(',');

    // 2. 点击打开下拉：类名优先（ant 是 selection、arco 是 select-view），
    //    再用 elementFromPoint 命中中央真正可点的元素——点外层容器可能不触发内部处理器
    let trigger = el.querySelector(
      'button.dropdown-toggle, button[data-toggle="dropdown"], [class*="selector"], [class*="selection"], ' +
      '[class*="select-view"], [class*="input"], [class*="trigger"]'
    ) || centerOf(el) || el;
    if (!trigger || typeof trigger.click !== 'function') trigger = el;   // SVG/非标准元素没有 click → 退回外层
    const visibleNow = new Set(Array.from(document.querySelectorAll(optionSelectors)).filter(isVisible));
    // 点击推荐由用户真实点击触发时，站点自己的下拉通常已经展开。此时直接复用当前字段附近的
    // 可见选项，不能再次 click 触发器，否则 toggle 型组件会把刚打开的菜单立即关掉。
    const menuAlreadyOpen = collectCurrentDropdownOptions(optionSelectors, new Set(), trigger, el).length > 0;
    const visibleBefore = menuAlreadyOpen ? new Set() : visibleNow;
    if (!menuAlreadyOpen) {
      // Moka 等 React 自定义下拉通过 onMouseDown 打开面板，仅 click() 不触发；
      // dispatch mousedown 在 click 之前，对 ant/B站 无害（额外事件会被忽略）
      if (trigger && typeof trigger.dispatchEvent === 'function') {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
      // 部分框架的 mousedown handler 挂在 INPUT 自身而非外层容器，且 trigger 可能
      // 是 outer container 而非 INPUT → 若 el 是 INPUT 且与 trigger 不同，也对 el 派发 mousedown
      if (el !== trigger && el.tagName === 'INPUT' && typeof el.dispatchEvent === 'function') {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
      trigger.click();
    }

    // 显式聚焦输入框：程序化 click 不会聚焦，而部分框架（B 站）忽略文档级合成事件、
    // 只响应输入框自身的 blur/Escape 收面板 → 让 activeElement 落在输入框上，收起机制才能命中
    const focusInput = el.tagName === 'INPUT' ? el : (el.querySelector('input') || el);
    if (focusInput && typeof focusInput.focus === 'function') focusInput.focus();
    // 面板一出现就继续；慢框架最多仍保留原来的 350ms 兼容窗口。
    await waitForCondition(
      () => collectCurrentDropdownOptions(optionSelectors, visibleBefore, trigger, el).length > 0,
      350,
      20
    );

    // 同名字段语义可能不同（如两个“奖励等级”分别表示省/市级和一/二/三等奖）。
    // 下拉打开后用真实选项选择能匹配的本地候选，不需要模型判断。
    if (candidates.length > 1) {
      const liveOptions = collectCurrentDropdownOptions(optionSelectors, visibleBefore, trigger, el);
      const matchedCandidate = candidates.find(candidate =>
        liveOptions.some(option => matchDropdownOption(option.textContent, candidate) > 0)
      );
      if (matchedCandidate) v = matchedCandidate;
    }

    // 3. 搜索框：仅地点类值（含 省/市 等区划词）才用，且只搜第一段，避免整值搜空把选项过滤掉
    const searchInput = el.querySelector('input[class*="search"], input[class*="filter"]') ||
                        el.querySelector('input:not([type="hidden"]):not([readonly])');
    if (searchInput && searchInput.offsetParent !== null && !semanticOptionKey(v).startsWith('level:') &&
        /(省|市|自治区|特别行政区|自治州|地区|盟|县|区)/.test(v)) {
      const searchText = placeFirstSegment(v);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(searchInput, searchText); else searchInput.value = searchText;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await waitForCondition(
        () => collectCurrentDropdownOptions(optionSelectors, visibleBefore, trigger, el)
          .some(option => matchDropdownOption(option.textContent, searchText) > 0),
        350,
        20
      );
    }

    // 4. 逐级匹配：整值/片段精确优先，省→市逐级消费（级联选择器）；最多 6 级防死循环
    let remaining = v;
    let clickedAny = false;
    for (let guard = 0; guard < 6 && remaining; guard++) {
      // 双源采集：类名选择器（传统） + 文本叶子扫描（泛用，含 Moka 裸 span）。
      const opts = collectCurrentDropdownOptions(optionSelectors, visibleBefore, trigger, el);

      if (opts.length === 0) break;

      let best = null, bestLen = 0;
      for (const o of opts) {
        const len = matchDropdownOption(o.textContent, remaining);
        if (len === 0) continue;
        const t = (o.textContent || '').trim();
        const isExact = t === remaining;
        if (!best) { best = o; bestLen = len; continue; }
        if (len > bestLen) { best = o; bestLen = len; continue; }
        if (len === bestLen) {
          // 同分时：精确匹配优先；都是精确/都是包含时，文本短的优先（"男" < "男女"容器文本）
          const curIsExact = (best.textContent || '').trim() === remaining;
          if (isExact && !curIsExact) { best = o; continue; }
          if (isExact === curIsExact && t.length < (best.textContent || '').trim().length) { best = o; }
        }
      }
      if (!best || bestLen === 0) break;        // 本级无可匹配项

      // 点击函数自身会从叶子逐级尝试祖先，避免外层再次遍历同一点击链。
      const clicked = await clickOptionWithRetryAsync(best, el, remaining);
      if (!clicked) break;        // 选项点击未生效（值未变化）
      clickedAny = true;

      if (bestLen >= remaining.length) {
        remaining = '';
        break;                                  // 值已全部选中
      }
      // 消费本级后，跳过残留的区划后缀/分隔符："湖南省长沙市" 消费"湖南"后剩"省长沙市" → 清成"长沙市"
      remaining = remaining.slice(bestLen).replace(/^[省市自治州盟县区\/、\s，,]+/, '');
      await waitForCondition(
        () => collectCurrentDropdownOptions(optionSelectors, visibleBefore, trigger, el)
          .some(option => matchDropdownOption(option.textContent, remaining) > 0),
        200,
        20
      );
    }

    // 收尾：主动收起面板。部分框架忽略合成事件导致面板残留（B 站实测不关），
    // 用多层机制（Escape/blur/文档 mousedown/body click）+ 检测重试，确认面板消失
    await closeOpenPanel(el, trigger);
    return (clickedAny && !remaining) || valuesEquivalent(getDropdownDisplayValue(el), v);
  }

  // 地点类值只取"省"段用于搜索（"湖南长沙"/"湖南省" → "湖南"），其余值原样返回
  function placeFirstSegment(value) {
    const v = String(value || '').trim();
    if (v && /(省|市|自治区|特别行政区|自治州|地区|盟|县|区)/.test(v)) {
      const seg = v.split(/(?:省|市|自治区|特别行政区|自治州|地区|盟|县|区)/)[0];
      if (seg) return seg;
    }
    return v;
  }

  // 选项文本与待消费值的匹配：返回本次可消费的字符数，0 表示不匹配。
  // "湖南省"↔"湖南"、"长沙市"↔"长沙"、"湖南长沙" 先消费 "湖南省" 的 "湖南"
  function matchDropdownOption(optText, remaining) {
    const t = (optText || '').trim();
    if (!t || !remaining) return 0;
    if (t === remaining) return remaining.length;
    const optionSemantic = semanticOptionKey(t);
    const valueSemantic = semanticOptionKey(remaining);
    if (optionSemantic && optionSemantic === valueSemantic) return remaining.length;
    // 北森把部分级别合并成单项。仅允许已保存的细分值选择页面合并项；
    // 不把市级与县级、校级与院级全局视为同一级，也不拿奖励等次代替奖励级别。
    if (optionSemantic === 'level:international-national' && ['level:international', 'level:national'].includes(valueSemantic)) return remaining.length;
    if (optionSemantic === 'level:provincial-city' && ['level:provincial', 'level:city'].includes(valueSemantic)) return remaining.length;
    if (optionSemantic === 'level:within-school' && ['level:school', 'level:college'].includes(valueSemantic)) return remaining.length;
    if (optionSemantic === 'level:city-county' && ['level:city', 'level:county'].includes(valueSemantic)) return remaining.length;
    if (t.replace(/\s/g, '') === '院校级' && valueSemantic === 'level:college') return remaining.length;
    if (optionSemantic.startsWith('level:') && valueSemantic.startsWith('level:')) return 0;
    const base = t.replace(/(自治区|特别行政区|自治州|省|市|地区|盟|县|区)$/, '');
    if (base && base === remaining) return remaining.length;
    if (remaining.startsWith(base)) return base.length;
    if (base.startsWith(remaining)) return remaining.length;
    // 包含匹配兜底（最后一级）："硕士（统招）"↔"硕士"、"湖南长沙"↔"湖南省"
    if (remaining.length >= 2 && t.length >= 2) {
      // 先剥掉选项末尾的括号注解（（统招）/（全职）/...），避免干扰
      const cleanT = t.replace(/[（(][^）)]*[）)]$/, '').trim();
      if (cleanT && remaining.includes(cleanT)) return cleanT.length;
      if (cleanT && cleanT.includes(remaining)) return remaining.length;
      if (t.includes(remaining) && t.length <= remaining.length + 1) return remaining.length;
      if (remaining.includes(t)) return t.length;
    }
    return 0;
  }

  // 取元素中心的真实可点元素（部分框架的点击处理器在内部子元素上，点外层容器不生效）
  function centerOf(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return t && (t === el || el.contains(t)) ? t : null;
  }

  // 通用日期选择器填充
  async function fillGenericDatepicker(el, value, selector) {
    const input = el.tagName === 'INPUT' ? el : (el.querySelector('input') || el);
    if (getPhoenixDateTrigger(input)) return selectDateInPhoenixCalendar(input, value, selector);
    const fieldValue = formatDateValueForField(input, value);
    const legacyOk = await selectDateInLegacySlt(el, fieldValue);
    if (legacyOk) return true;
    const isAntDatepicker = !!(input && input.closest && input.closest('.ant-calendar-picker'));
    // 优先：ant-design-vue 日历点选。readonly + controlled 的 DatePicker 直接 setter 赋值 + Enter
    // 不生效（实测：面板打开时赋值会被忽略，值回退为空），必须点日历格子真正选中
    const ok = await selectDateInCalendar(input, fieldValue, selector);
    if (ok) {
      // 已确认提交 → 用 Escape-first 可靠关闭面板（protect 的非破坏性关闭在 B 站不保证生效，
      // 残留面板会污染下一个日期字段的日历点选）
      await closeOpenPanel(el, el, false);
      return true;
    }
    // 已确认是 ant DatePicker 时，不再串行进入 Moka 年月网格识别；两套引擎连续尝试
    // 会让同一日期面板反复打开。失败交给结果提示，由用户检查即可。
    if (isAntDatepicker) {
      await closeOpenPanel(el, el, false);
      return false;
    }
    // 次要：泛用年月网格日期选择器（如 Moka 自研组件，面板含 "N年" + 月份网格）
    const genericOk = await selectDateInGenericPicker(input, fieldValue, selector);
    if (genericOk) {
      await closeOpenPanel(el, el, false);
      return true;
    }
    // 兜底：先可靠关掉面板，再赋值 + Enter（ant readonly 上多不生效，但非 ant 控件可用）
    await closeOpenPanel(el, el, false);
    if (!input || input.tagName !== 'INPUT') return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, fieldValue); else input.value = fieldValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(120);
    input.blur();
    await closeOpenPanel(el, el, true);
    return valuesEquivalent(input.value, fieldValue) || dateValuesMatchPrecision(input.value, fieldValue);
  }

  // Phoenix 使用 rc-calendar 的月份/年份/日期网格，选中值写到 select tag，input 只用于搜索。
  // 每次导航都重新取节点，并等待显示年份改变，防止 React 重绘后继续点击旧节点。
  function findPhoenixCalendar(input) {
    const rect = input.getBoundingClientRect();
    return Array.from(document.querySelectorAll('.phoenix-calendar'))
      .filter(panel => {
        if (!isVisible(panel) || panel.contains(input)) return false;
        const r = panel.getBoundingClientRect();
        return r.left < rect.right + 450 && r.right > rect.left - 450 &&
          r.top <= rect.bottom + 650 && r.bottom >= rect.top - 650;
      })
      .map(panel => {
        const r = panel.getBoundingClientRect();
        return { panel, distance: Math.abs(r.left - rect.left) + Math.min(Math.abs(r.top - rect.bottom), Math.abs(r.bottom - rect.top)) };
      }).sort((a, b) => a.distance - b.distance)[0]?.panel || null;
  }

  function phoenixCalendarNode(panel, selector) {
    return panel && Array.from(panel.querySelectorAll(selector)).find(node =>
      isVisible(node) && !node.closest('[class*="disabled"], [aria-disabled="true"]')
    );
  }

  async function selectDateInPhoenixCalendar(input, value, selector) {
    const parts = parseDateValueParts(value);
    if (!parts || !parts.month || parts.month > 12 || parts.month < 1 ||
        (parts.day && (parts.day < 1 || parts.day > new Date(parts.year, parts.month, 0).getDate()))) return false;
    const liveInput = () => {
      const fresh = selector && findElement(selector);
      return fresh ? (fresh.tagName === 'INPUT' ? fresh : fresh.querySelector('input') || input) : input;
    };
    const committed = () => dateValuesMatchPrecision(getDropdownDisplayValue(liveInput()), value);
    if (committed()) return true;
    const trigger = getPhoenixDateTrigger(input);
    if (!trigger) return false;
    try {
      // 先收起上一个日期字段的 portal，避免把旧面板误认为当前字段的日历。
      await closeOpenPanel(input, trigger, false);
      input.focus();
      trigger.click();
      if (!await waitForCondition(() => findPhoenixCalendar(liveInput()), 900)) return false;
      const panel = () => findPhoenixCalendar(liveInput());
      const currentYear = () => {
        const heading = phoenixCalendarNode(panel(), '.phoenix-calendar-month-panel-year-select, .phoenix-calendar-year-select');
        return heading ? parseInt(heading.textContent.trim(), 10) : NaN;
      };
      let year = currentYear();
      if (!Number.isFinite(year)) return false;
      if (Math.abs(parts.year - year) > 8) {
        const heading = phoenixCalendarNode(panel(), '.phoenix-calendar-month-panel-year-select, .phoenix-calendar-year-select');
        heading.click();
        if (!await waitForCondition(() => phoenixCalendarNode(panel(), '.phoenix-calendar-year-panel-year'), 700)) return false;
        let target = null;
        for (let i = 0; i < 25; i++) {
          const years = Array.from(panel()?.querySelectorAll('.phoenix-calendar-year-panel-year') || [])
            .filter(node => isVisible(node) && !node.closest('[class*="disabled"], [aria-disabled="true"]'));
          target = years.find(node => node.textContent.trim() === String(parts.year));
          if (target) break;
          const texts = years.map(node => node.textContent.trim()).join(',');
          const first = Math.min(...years.map(node => parseInt(node.textContent, 10)));
          if (!Number.isFinite(first)) return false;
          const direction = parts.year < first ? 'prev' : 'next';
          const button = phoenixCalendarNode(panel(), `.phoenix-calendar-year-panel-${direction}-decade-btn`);
          if (!button) return false;
          button.click();
          if (!await waitForCondition(() => Array.from(panel()?.querySelectorAll('.phoenix-calendar-year-panel-year') || [])
            .filter(isVisible).map(node => node.textContent.trim()).join(',') !== texts, 700)) return false;
        }
        if (!target) return false;
        target.click();
        if (!await waitForCondition(() => currentYear() === parts.year, 700)) return false;
      } else {
        for (let i = 0; year !== parts.year && i < 8; i++) {
          const direction = parts.year < year ? 'prev' : 'next';
          const button = phoenixCalendarNode(panel(), `.phoenix-calendar-month-panel-${direction}-year-btn, .phoenix-calendar-${direction}-year-btn`);
          if (!button) return false;
          button.click();
          const expectedYear = year + (direction === 'prev' ? -1 : 1);
          if (!await waitForCondition(() => currentYear() === expectedYear, 700)) return false;
          year = currentYear();
        }
      }
      if (currentYear() !== parts.year) return false;
      if (!phoenixCalendarNode(panel(), '.phoenix-calendar-month-panel-month')) {
        const switchMonth = phoenixCalendarNode(panel(), '.phoenix-calendar-month-select');
        if (!switchMonth) return false;
        switchMonth.click();
        if (!await waitForCondition(() => phoenixCalendarNode(panel(), '.phoenix-calendar-month-panel-month'), 700)) return false;
      }
      const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
      const monthCell = Array.from(panel()?.querySelectorAll('.phoenix-calendar-month-panel-month') || []).find(node =>
        isVisible(node) && !node.closest('[class*="disabled"], [aria-disabled="true"]') &&
        [String(parts.month), `${parts.month}月`, monthNames[parts.month - 1]].includes(node.textContent.trim())
      );
      if (!monthCell) return false;
      monthCell.click();
      await waitForCondition(() => committed() || phoenixCalendarNode(panel(), '.phoenix-calendar-date'), 700);
      if (!committed()) {
        const dayCell = Array.from(panel()?.querySelectorAll('.phoenix-calendar-cell') || []).find(node =>
          isVisible(node) && !node.matches('.phoenix-calendar-last-month-cell, .phoenix-calendar-next-month-cell, [class*="disabled"]') &&
          node.querySelector('.phoenix-calendar-date')?.textContent.trim() === String(parts.day || 1)
        );
        if (!dayCell) return false;
        dayCell.querySelector('.phoenix-calendar-date').click();
        if (!await waitForCondition(committed, 900)) return false;
      }
      // 等待受控组件写回稳定，再核验完整年月（日模式还核验日）。不对搜索框强行赋值。
      await sleep(120);
      return committed();
    } finally {
      await closeOpenPanel(liveInput(), getPhoenixDateTrigger(liveInput()) || trigger, false);
    }
  }

  // 兼容早期招聘系统的 dateSlt：年份/月/日面板均内嵌在控件内部，没有 input/ARIA/picker 类名。
  async function selectDateInLegacySlt(el, value) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!/(^|\s)date[-_]?slt(?:\s|$)/i.test(cls)) return false;
    const m = /^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/.exec(String(value || '').trim());
    if (!m) return false;
    const year = String(+m[1]);
    const month = m[2] ? String(+m[2]) : '';
    // 旧式控件通常必须选到“日”才提交；简历只有 YYYY-MM 时用 1 日完成提交。
    const day = m[3] ? String(+m[3]) : (month ? '1' : '');
    const clickText = async (panelSelector, wanted) => {
      if (!wanted) return true;
      const panel = el.querySelector(panelSelector);
      if (!panel) return false;
      const item = Array.from(panel.querySelectorAll('li, a, button')).find(x => x.textContent.trim() === wanted);
      if (!item) return false;
      item.click();
      await sleep(70);
      return true;
    };
    el.click();
    await sleep(100);
    if (!await clickText('.slideConYear', year)) return false;
    if (!await clickText('.slideConMon', month)) return false;
    if (!await clickText('.slideConDay', day)) return false;
    const display = el.querySelector(':scope > span');
    const shown = display ? display.textContent.trim() : '';
    return valuesEquivalent(shown, value) || (shown.startsWith(year) && (!month || shown.includes(String(+month))));
  }

  // ===== ant-design-vue DatePicker 日历点选 =====
  // 点击输入框打开日历面板 → 年份面板选年（跨 decade 自动翻页）→ 月份面板按月序号选月 →
  // 点目标日期格子（当前月、按天数匹配，与语言无关）。
  // 导航失败（面板找到但点选中途失败，多为过渡/时序）会清理现场后重试；
  // 根本没弹面板（非 ant 控件）不重试，直接走回退赋值。
  async function selectDateInCalendar(input, value, selector) {
    const m = /^(\d{4})[-\/.](\d{1,2})(?:[-\/.](\d{1,2}))?/.exec(String(value || '').trim());
    if (!m) return false;
    const year = +m[1], month = +m[2], day = m[3] ? +m[3] : 1;

    // ant 输入框（.ant-calendar-picker 内）首次打开面板可能较慢 → 无面板也重试；
    // 非 ant 控件（根本不是 ant 日历）返回 false 不重试，直接走回退赋值
    const isAnt = !!input.closest('.ant-calendar-picker');
    for (let attempt = 0; attempt < 3; attempt++) {
      // Vue 重渲染可能替换输入框节点（提交一次值后列表重排）→ 每次尝试前按 selector 重查，
      // 否则点的是 detached 旧引用，面板打不开（B 站 2026-06 实测卡在这）
      if (selector) {
        const fresh = findElement(selector);
        // selector 可能指向容器（采集时未解包）→ 重查后同样解包成内部 input
        if (fresh) input = fresh.tagName === 'INPUT' ? fresh : (fresh.querySelector('input') || fresh);
      }
      const r = await trySelectDate(input, year, month, day);
      if (r === true) {
        // 提交后校验：B 站 Vue 重渲染慢时月份点击会用旧年份提交（实测差一年），
        // 年份不符则当失败重试（第二次面板已热，通常能对上）。
        // 注意：受控组件（Vue/React）点选后写回 input.value 是异步的（数百 ms 延迟），
        // 立即校验会误判"年份不符" → 触发下方 Escape 取消刚选中的日期 + 重开面板重选，
        // 表现为日期面板反复开关、时间被反复刷新。先等渲染稳定再校验，通常一次通过。
        await sleep(400);
        // 选中日期后 Vue/React 可能立即替换 input。必须重新按稳定选择器读取当前节点，
        // 否则旧引用仍为空，会把成功点选误判为失败并再次打开日历。
        let verifiedInput = input;
        if (selector) {
          const fresh = findElement(selector);
          if (fresh) verifiedInput = fresh.tagName === 'INPUT' ? fresh : (fresh.querySelector('input') || input);
        }
        const val = String(verifiedInput.value || '').trim();
        if (dateValuesMatchPrecision(val, value)) return true;
        input = verifiedInput;
        console.warn('[简历填充] 日期年份不符，正在重试');
      } else if (r === false && !isAnt) {
        return false;   // 非 ant，重试无意义
      }
      // 清理现场后重试：必须用 Escape-on-input 可靠关掉残留面板
      // （B 站忽略 document 级合成事件，直接用 body mousedown/Escape 关不掉，
      //   下次 input.click() 会把还开着的面板 toggle 关掉 → 找不到面板）
      await closeOpenPanel(input, input, false);
      await sleep(200);
    }
    return false;
  }

  // 单次日历点选；返回 true / false（无面板）/ 'nav-failed'（面板在但导航中断）
  async function trySelectDate(input, year, month, day) {
    input.click();
    input.focus();
    await sleep(400);
    let panel = findOpenCalendarNear(input);
    if (!panel) return false;

    // 读当前显示年份：近距离（±6 年内且非同年）用"上一年/下一年"按钮直接跳——
    // 避免年份面板导航的竞态（B 站实测偶发选错年，如 2025-05 被选成 2026）；
    // 同年或远距离（如 2002）走年份面板（同年的面板流程已验证可用）
    const curYearEl = panel.querySelector('.ant-calendar-year-select');
    const curYear = curYearEl ? parseInt(curYearEl.textContent.trim(), 10) : NaN;
    const diff = isNaN(curYear) ? NaN : year - curYear;
    if (!isNaN(diff) && diff !== 0 && Math.abs(diff) <= 6) {
      const stepBtn = panel.querySelector(diff > 0 ? '.ant-calendar-next-year-btn' : '.ant-calendar-prev-year-btn');
      if (!stepBtn) return 'nav-failed';
      for (let i = 0; i < Math.abs(diff); i++) {
        stepBtn.click();
        await sleep(120);
      }
    } else {
      const yearBtn = panel.querySelector('.ant-calendar-year-select');
      if (!yearBtn) return 'nav-failed';
      yearBtn.click();
      await sleep(400);
      panel = findOpenCalendarNear(input);
      if (!panel) return 'nav-failed';
      let yCell = findYearCell(panel, year);
      for (let i = 0; i < 8 && !yCell; i++) {
        const years = Array.from(panel.querySelectorAll('.ant-calendar-year-panel-year'))
          .map(y => parseInt(y.textContent.trim(), 10)).filter(n => !isNaN(n));
        if (!years.length) return 'nav-failed';
        const first = Math.min(...years);
        const btn = panel.querySelector(year < first ? '.ant-calendar-year-panel-prev-decade-btn' : '.ant-calendar-year-panel-next-decade-btn');
        if (!btn) return 'nav-failed';
        btn.click();
        await sleep(300);
        panel = findOpenCalendarNear(input);
        if (!panel) return 'nav-failed';
        yCell = findYearCell(panel, year);
      }
      if (!yCell) return 'nav-failed';
      yCell.click();
      // B 站 Vue 重渲染较慢：选完年后等久一点，再切回月份网格，降低"用旧年份提交"的竞态
      await sleep(500);
    }

    // 月份面板（按月序号匹配，避免语言差异）。
    // 注意：月份选择器（mode=month / MonthPicker，B 站起止时间即是）选完年份后
    // 面板仍停在年份视图，必须再点 month-select 切回月份网格；普通日期选择器同理打开月份面板
    panel = findOpenCalendarNear(input);
    if (!panel) return 'nav-failed';
    const monthBtn = panel.querySelector('.ant-calendar-month-select');
    if (!monthBtn) return 'nav-failed';
    monthBtn.click();
    await sleep(500);
    panel = findOpenCalendarNear(input);
    if (!panel) return 'nav-failed';
    const mCell = Array.from(panel.querySelectorAll('.ant-calendar-month-panel-month'))[month - 1];
    if (!mCell) return 'nav-failed';
    mCell.click();
    await sleep(350);

    // 月份模式：点完月份即提交，无日期格子；日期模式：面板切到日视图，再点目标天
    panel = findOpenCalendarNear(input);
    if (panel && panel.querySelector('.ant-calendar-date-panel, .ant-calendar-date')) {
      const dCell = Array.from(panel.querySelectorAll('.ant-calendar-cell:not(.ant-calendar-last-month-cell):not(.ant-calendar-next-month-cell)'))
        .find(td => {
          const d = td.querySelector('.ant-calendar-date');
          return d && d.textContent.trim() === String(day);
        });
      if (!dCell) return 'nav-failed';
      dCell.querySelector('.ant-calendar-date').click();
      await sleep(150);
    }
    return true;
  }

  // 打开中的 ant 日历面板（portal 在 body 下）。
  // 优先取紧邻输入框的；找不到则退回任意可见面板——面板可能开在输入框上方
  // （字段在视口底部时朝上弹出），严格按位置找会漏。忽略 opacity（过渡中会为 0）。
  function findOpenCalendarNear(el) {
    const r = el.getBoundingClientRect();
    let anyVisible = null;
    for (const node of document.querySelectorAll('.ant-calendar-picker-panel, .ant-calendar')) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const pr = node.getBoundingClientRect();
      if (pr.width <= 0 || pr.height <= 0) continue;
      if (!anyVisible) anyVisible = node;
      if (pr.left < r.right + 400 && pr.right > r.left - 400 &&
          pr.top >= r.top - 400 && pr.top <= r.bottom + 900) return node;
    }
    return anyVisible;
  }

  function findYearCell(panel, year) {
    const cells = panel.querySelectorAll('.ant-calendar-year-panel-year');
    for (const c of cells) if (c.textContent.trim() === String(year)) return c;
    return null;
  }

  // ===== 泛用年月网格日期选择器（非 ant 自定义组件，如 Moka） =====
  // 策略：打开面板 → 找到 "{year}年" 元素点选年份 → 找到中文月份（一月..十二月）点选 →
  // 验证输入值年份正确。最多重试 3 次。

  // 在输入框附近找任意可见面板（使用 PANEL_SELECTORS 泛用模式，不限于 ant calendar）
  function findOpenGenericPanelNear(el) {
    const r = el.getBoundingClientRect();
    let best = null;
    for (const node of document.querySelectorAll(PANEL_SELECTORS)) {
      if (!isVisible(node)) continue;
      if (node.contains(el)) continue;
      const pr = node.getBoundingClientRect();
      if (pr.width <= 0 || pr.height <= 0) continue;
      if (pr.left < r.right + 450 && pr.right > r.left - 450 &&
          pr.top >= r.top - 650 && pr.top <= r.bottom + 650) {
        const dist = Math.abs(pr.top - r.bottom) + Math.abs(pr.left - r.left);
        if (!best || dist < best._dist) { best = node; best._dist = dist; }
      }
    }
    return best;
  }

  // 在面板内找文本精确匹配的可点击叶子节点（优先精确匹配，兜底包含匹配）
  function findTextInPanel(panel, text) {
    const all = panel.querySelectorAll('*');
    let best = null;
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 20) continue;
      if (!isVisible(el)) continue;
      if (t === text) return el;
      if (!best && t.includes(text) && el.children.length === 0) best = el;
    }
    return best;
  }

  async function selectDateInGenericPicker(input, value, selector) {
    const m = /^(\d{4})[-\/.](\d{1,2})(?:[-\/.](\d{1,2}))?/.exec(String(value || '').trim());
    if (!m) return false;
    const year = +m[1], month = +m[2];
    const YEAR_MONTHS = ['', '一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];

    for (let attempt = 0; attempt < 3; attempt++) {
      if (selector) {
        const fresh = findElement(selector);
        if (fresh) input = fresh.tagName === 'INPUT' ? fresh : (fresh.querySelector('input') || fresh);
      }

      // 打开面板：click + focus，也尝试点 addon/picker 图标
      input.click();
      input.focus();
      await sleep(400);
      let panel = findOpenGenericPanelNear(input);
      if (!panel) {
        const addon = input.parentElement && input.parentElement.querySelector('[class*="picker"], [class*="calendar"], [class*="addon"]');
        if (addon) { addon.click(); await sleep(400); }
        panel = findOpenGenericPanelNear(input);
      }
      if (!panel) return false;

      // 点选年份：找文本精确为 "{year}年" 的元素
      const yearEl = findTextInPanel(panel, year + '年');
      if (!yearEl) { await closeOpenPanel(input, input, false); await sleep(150); continue; }
      yearEl.click();
      await sleep(350);

      // 年份点击后重查面板（可能面板内容已切换）
      panel = findOpenGenericPanelNear(input);
      if (!panel) { await closeOpenPanel(input, input, false); await sleep(150); continue; }

      // 点选月份：先试中文名，再试数字
      const targetMonth = YEAR_MONTHS[month] || '';
      let monthEl = targetMonth ? findTextInPanel(panel, targetMonth) : null;
      if (!monthEl) monthEl = findTextInPanel(panel, month + '月');
      if (!monthEl) { await closeOpenPanel(input, input, false); await sleep(150); continue; }
      monthEl.click();
      await sleep(400);

      // 验证输入值年份正确（Moka 填充后 input.value 会更新为 "1990-01" 之类）
      // 同样先等受控组件写回 value 稳定，避免误判失败反复重选
      const val = String(input.value || '').trim();
      if (/^\d{4}/.test(val) && parseInt(val.slice(0, 4), 10) === year) return true;

      // 失败则关面板重试
      await closeOpenPanel(input, input, false);
      await sleep(200);
    }
    return false;
  }

  // ===== 面板收起（下拉/级联/日期共用） =====
  // 部分框架（尤其 B 站 ant-design-vue / bili-date）忽略 isTrusted=false 的合成事件，
  // 只发 document 级 mousedown/click 关不掉面板。因此：多层机制 + 确认重试。
  const PANEL_SELECTORS = [
    '[role="listbox"]', '[role="dialog"]',
    '[class*="dropdown-menu"]', '[class*="dropdown-content"]', '[class*="dropdown-list"]',
    '[class*="dropdown"]',
    '[class*="menus"]', '[class*="menu-list"]', '[class*="menu"]',
    '[class*="popup"]', '[class*="select-menu"]',
    '[class*="picker-panel"]', '[class*="calendar-panel"]', '[class*="calendar"]', '[class*="picker"]',
    '[class*="panel"]', '[class*="cascader-menu"]', '[class*="option-list"]',
    '[class*="overlay"]', '[class*="layer"]',
    '[class*="select"] [class*="menu"]'
  ].join(',');

  // 字段附近是否仍有打开的面板（宽松判断，仅用于确认收起；误报无害）
  function isPanelOpenNear(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (const node of document.querySelectorAll(PANEL_SELECTORS)) {
      if (!isVisible(node)) continue;
      // 跳过包含触发元素自身的节点（避免把字段容器误判为打开的面板）
      if (node.contains(el)) continue;
      const pr = node.getBoundingClientRect();
      const hOverlap = pr.left < r.right + 150 && pr.right > r.left - 150;
      const vNear = pr.top >= r.top - 120 && pr.top <= r.bottom + 600;
      if (hOverlap && vNear) return true;
    }
    return false;
  }

  // 发一轮收起事件。
  // 关键：多数框架（ant Select/DatePicker、bili-date）把 Escape 监听挂在输入框上，
  // 对输入框本身派发 Escape 不受 isTrusted 限制、也无需元素在焦点上。
  // withEscape=false 用于日期选择器首轮：Escape 会取消"Enter 刚确认的日期"，
  // 所以先只发非破坏性关闭（blur + 文档 mousedown/click），面板仍开着才升级 Escape
  function fireCloseEvents(el, trigger, withEscape) {
    // el/trigger 本身就是输入框时（日期选择器字段），直接用其作为 Escape/blur 目标——
    // 否则 querySelector('input') 返回 null，Escape 打不到输入框，面板关不掉（B 站实测）
    const asInput = node => node && node.tagName === 'INPUT' ? node : null;
    const inner = asInput(trigger) ||
                  (trigger && trigger.querySelector ? trigger.querySelector('input') : null) ||
                  asInput(el) ||
                  (el && el.querySelector ? el.querySelector('input') : null);
    if (withEscape) {
      if (inner) inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      const act = document.activeElement;
      if (act && act !== document.body && typeof act.blur === 'function') {
        act.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    }
    const act = document.activeElement;
    if (act && act !== document.body && typeof act.blur === 'function') act.blur();
    if (inner && inner !== document.activeElement) inner.blur();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.click();
  }

  // 主动收起：下拉/级联直接命中 Escape（B 站 ant 忽略文档级事件，实测有效）；
  // protect=true（日期选择器）首轮不带 Escape，避免取消刚确认的日期
  async function closeOpenPanel(el, trigger, protect) {
    if (!isPanelOpenNear(el)) return;
    fireCloseEvents(el, trigger, !protect);
    if (await waitForCondition(() => !isPanelOpenNear(el), protect ? 150 : 120, 20)) return;
    for (let i = 0; i < 3 && isPanelOpenNear(el); i++) {
      fireCloseEvents(el, trigger, true);
      if (await waitForCondition(() => !isPanelOpenNear(el), 150, 20)) return;
    }
  }

  // 兜底：填充结束后清理任何残留面板
  async function closeAllPanels() {
    for (let i = 0; i < 2; i++) {
      fireCloseEvents(null, null, i > 0);
      await sleep(100);
    }
  }

  // ===== 高亮 =====
  function highlightField(el) {
    const target = el.closest('[class*="select"], [class*="input"], [class*="picker"], [class*="field"]') || el;
    const orig = target.style.boxShadow;
    target.style.boxShadow = '0 0 0 2px rgba(82, 196, 26, 0.5)';
    target.style.transition = 'box-shadow 0.3s';
    setTimeout(() => { target.style.boxShadow = orig; }, 2000);
  }

  // ===== 工具函数 =====
  function findElement(selector) {
    try { return document.querySelector(selector); } catch { return null; }
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  async function waitForCondition(predicate, timeoutMs, intervalMs = 25) {
    const started = Date.now();
    while (true) {
      try { if (predicate()) return true; } catch { /* DOM 正在重渲染，下一轮重试 */ }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) return false;
      await sleep(Math.min(intervalMs, timeoutMs - elapsed));
    }
  }
  async function waitForFieldLayoutStable(timeoutMs = 1200, intervalMs = 100) {
    const started = Date.now();
    let lastCount = -1;
    let stableRounds = 0;
    while (Date.now() - started < timeoutMs) {
      let count = 0;
      try { count = scanFieldElements().length; } catch { count = -1; }
      if (count >= 0 && count === lastCount) stableRounds++;
      else stableRounds = 0;
      if (stableRounds >= 2) return true;
      lastCount = count;
      await sleep(intervalMs);
    }
    return false;
  }
  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function getProfile() {
    return new Promise(resolve => {
      chrome.storage.local.get(null, result => {
        resolve({
          basic: result.basic || {},
          education: result.education || [],
          work: result.work || [],
          projects: result.projects || [],
          campusDuties: result.campusDuties || [],
          computerSkills: result.computerSkills || [],
          patents: result.patents || [],
          papers: result.papers || [],
          awards: result.awards || [],
          families: result.families || [],
          languages: result.languages || '',
          certificates: result.certificates || '',
          skills: result.skills || '',
          hobbies: result.hobbies || '',
          jobIntention: result.jobIntention || {},
          extra: result.extra || {},
          selfEvaluation: result.selfEvaluation || ''
        });
      });
    });
  }

  // ===== 输入框点击快速填充（手动选择简历信息） =====
  // 点击任意可填写的表单字段时，弹出"简历信息选择面板"，列出插件已保存的简历信息，
  // 点选一项即自动填充到该输入框。不依赖 AI/LLM，用于手动精确填充单个字段。

  const QP_GROUP_TITLES = {
    basic: '基本信息',
    languageQualifications: '语言能力与资格证书',
    jobIntention: '求职意向',
    professionalSkills: '专业技能',
    extra: '其他补充信息',
    selfEvaluation: '自我评价'
  };

  // 各分组主题色（标题色条 + 条目标签着色，便于列表间区分）
  const QP_GROUP_COLORS = {
    basic: '#1677ff',        // 蓝
    jobIntention: '#722ed1', // 紫
    extra: '#13c2c2',        // 青
    education: '#389e0d',    // 绿
    work: '#d46b08',         // 橙
    projects: '#eb2f96',     // 粉
    campusDuties: '#08979c', // 蓝绿（校内职务）
    computerSkills: '#531dab', // 紫（计算机技能）
    patents: '#0958d9',      // 靛蓝
    papers: '#08979c',       // 蓝绿
    awards: '#d48806',       // 金（奖励荣誉）
    families: '#c41d7f',     // 玫红
    languages: '#2f54eb',    // 蓝紫（语言能力）
    languageQualifications: '#2f54eb',
    professionalSkills: '#0d9488',
    selfEvaluation: '#eab308',
    text: '#8c8c8c'          // 灰
  };
  const QP_FALLBACK_COLORS = ['#1677ff', '#13c2c2', '#fa8c16', '#722ed1', '#389e0d', '#eb2f96', '#d48806', '#0958d9'];

  // 组内多记录（教育1/教育2…）序号取色板，用于同组内不同记录间的颜色区分
  const QP_ENTRY_COLORS = ['#1677ff', '#fa8c16', '#722ed1', '#13c2c2', '#eb2f96', '#389e0d', '#d48806', '#0958d9', '#c41d7f', '#08979c', '#8c8c8c'];

  // 分组 → 主题色（未在表中用 key 哈希轮换取色，保证稳定）
  function quickGroupColor(key) {
    if (QP_GROUP_COLORS[key]) return QP_GROUP_COLORS[key];
    let h = 0;
    for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return QP_FALLBACK_COLORS[h % QP_FALLBACK_COLORS.length];
  }
  const QP_LABELS = {
    basic: {
      name: '姓名', englishName: '英文名', gender: '性别', birthday: '出生日期', idType: '证件类型',
      phone: '手机号', email: '邮箱', idCard: '身份证号', location: '所在城市', hukou: '户籍所在地',
      nativePlace: '籍贯', ethnicity: '民族', nationality: '国籍', hukouType: '户口类型',
      political: '政治面貌', marital: '婚姻状况', joinPartyDate: '入党团时间',
      hasOverseas: '有无海外留学经历', workYears: '工作年限', availableDate: '到岗时间',
      graduationDate: '毕业时间', freshGraduate: '是否为应届毕业生', jobStatus: '求职状态',
      currentSalary: '当前薪资', address: '详细地址', website: '个人网站 / GitHub',
      wechat: '微信号', height: '身高(cm)', weight: '体重(kg)',
      isDomesticMobile: '是否为国内号码', healthDesc: '健康说明'
    },
    jobIntention: {
      position: '期望职位', salary: '期望薪资', city: '期望城市', city2: '期望城市2',
      interviewCity: '期望面试地点', adjustCity: '调剂工作城市', type: '工作类型',
      industry: '期望行业', minSalary: '税前月薪最低要求', obeyAllocate: '是否服从公司调剂',
      currentAnnual: '目前年薪', infoChannel: '信息渠道'
    },
    extra: {
      operatorExp: '是否有运营商实习经验', jobTransfer: '是否接受岗位调剂',
      schoolCity: '就读院校所在城市', jobObjective: '职业目标', careerPlan: '职业规划'
    }
  };
  const QP_ARRAY_GROUPS = [
    // 语言能力放最前：其字段名通用（级别/分数/时间），靠上下文关键词防误配，
    // 且避免"英语水平/考试时间"等标签被论文"水平"、奖项"时间"抢先匹配
    { key: 'languages', title: '语言能力', context: ['语言', '英语', 'CET', '四六', '语种', '外语', '六级', '四级'], fields: { level: '级别/名称', score: '分数', date: '时间', passed: '是否通过', certName: '证书名称', proficiency: '掌握程度', otherLang: '其他语种' }, panelFields: { level: '级别/名称', score: '分数', date: '时间', passed: '是否通过', certName: '证书名称', proficiency: '掌握程度' } },
    { key: 'education', title: '教育经历', fields: { school: '学校', major: '专业', degree: '学历', degreeTitle: '学位', duration: '学制', isRegular: '是否统招', isHighest: '是否最高学历', department: '院系', eduType: '教育类型', schoolNature: '院校性质', isFulltime: '是否全日制', countryRegion: '院校所属国家及地区', isFulltimeHighest: '是否为全日制最高学历', isDoubleDegree: '是否双学位', isHighestDegree: '是否最高学位', isMainStudy: '是否主学习经历', researchArea: '研究方向', majorDesc: '专业描述', gpa: 'GPA/排名', rank: '年级排名', comprehensiveRank: '班级或年级综合排名(排名/总人数)', avgScore: '必修课平均分', courses: '专业课程', startDate: '开始时间', endDate: '结束时间', description: '在校经历', tutor: '导师', tutorContact: '导师联系方式', isOverseas: '是否海外留学经历', thesisTitle: '毕业论文名称', thesisSummary: '毕业论文核心概述', awards: '获奖/荣誉', publications: '论文/专利' } },
    { key: 'work', title: '实习经历', fields: { company: '公司', department: '部门', position: '职位', type: '工作类型', city: '工作城市', startDate: '开始时间', endDate: '结束时间', companyNature: '企业性质', monthlySalary: '税前职位月薪(元)', description: '工作描述', hrContactName: 'HR联系人', hrContactPhone: 'HR联系电话', certifierName: '证明人姓名', certifierRelation: '证明人关系', certifierDuty: '证明人职务', certifierCompany: '证明人单位', certifierContact: '证明人联系方式' }, panelFields: { company: '公司', department: '部门', position: '职位', type: '工作类型', city: '工作城市', startDate: '开始时间', endDate: '结束时间', companyNature: '企业性质', monthlySalary: '税前职位月薪(元)', description: '工作描述', certifierName: '证明人姓名', certifierRelation: '证明人关系', certifierDuty: '证明人职务', certifierCompany: '证明人单位', certifierContact: '证明人联系方式' } },
    { key: 'projects', title: '项目经历', fields: { projectName: '项目名称', role: '担任角色', company: '所在公司', techStack: '技术栈', startDate: '开始时间', endDate: '结束时间', description: '项目描述', responsibilities: '项目职责' } },
    { key: 'campusDuties', title: '校内职务', fields: { organization: '组织团体名称', duty: '担任职务', cadreLevel: '干部级别', achievement: '职责和成就' } },
    { key: 'computerSkills', title: '计算机技能', fields: { skillType: '技能类别', description: '技能描述' } },
    { key: 'patents', title: '专利发表', fields: { type: '专利类型', stage: '发表阶段', name: '专利名称', authorRank: '作者排序' } },
    { key: 'papers', title: '论文发表', fields: { title: '论文名称', journal: '期刊/会议', level: '水平', publishDate: '发表日期', yearIssue: '年度/期次', authorRank: '作者排序', status: '发表状态', impactFactor: '影响因子', synopsis: '内容提要', achievement: '成就/等级', situation: '交流情况', coauthorType: '合(独)著/译' }, panelFields: { title: '论文名称', journal: '期刊/会议', level: '水平', publishDate: '发表日期', yearIssue: '年度/期次', authorRank: '作者排序', status: '发表状态', impactFactor: '影响因子', synopsis: '内容提要' } },
    { key: 'awards', title: '奖励荣誉', fields: { name: '奖励名称', category: '奖项类别', level: '奖励级别', grade: '奖励等级', date: '获奖时间', school: '所在学校', isCadre: '是否学生干部', cadreDesc: '学生干部描述', issuer: '颁发单位', summary: '简要描述' } },
    { key: 'families', title: '家庭关系', fields: { name: '姓名', relation: '关系', gender: '性别', inTelecom: '是否在运营商/系统内任职', workUnit: '工作单位', position: '职务/岗位', department: '所在部门', phone: '联系电话', livePlace: '现居住地址', political: '政治面貌' }, panelFields: { name: '姓名', relation: '关系', gender: '性别', inTelecom: '是否在运营商/系统内任职', workUnit: '工作单位', position: '职务/岗位', phone: '联系电话', livePlace: '现居住地址', political: '政治面貌' } }
  ];
  const QP_GROUP_CONTEXT = {
    languages: /语言|英语|外语|语种|CET|四六级/i,
    education: /教育|学习经历|求学经历|教育背景|学校|院校|学历|学位|毕业论文/,
    work: /实习|工作经历|任职经历|职业经历|就业经历|从业经历|实践经历|任职单位|工作单位|企业名称|公司名称|职位名称|工作性质|工作描述|证明人(?:姓名|职务|联系方式)/,
    projects: /项目|课题|研究经历|科研项目/,
    campusDuties: /校内职务|校园经历|校园活动|学生工作|学生干部|社团|社会实践/,
    computerSkills: /计算机技能|IT技能|技能类别/i,
    patents: /专利/,
    papers: /论文|期刊|会议发表|学术成果|科研成果/,
    awards: /奖励|奖项|获奖|荣誉|奖学金|表彰/,
    families: /家庭|亲属|家属|社会关系/
  };
  // 已标准化字段优先本地逐条绑定；陌生字段文案仍保留给大模型兜底。
  // recordGroupKey/recordIndex 会随字段一起发送，模型不会跨记录串填。
  // 站点字段文案往往与简历字段不完全同名；这些模式只决定字段含义，记录类型仍由
  // 区块/重复容器上下文打分，因而“获得时间”不会在语言、奖励、证书之间串组。
  const QP_FIELD_PATTERNS = {
    education: [
      ['thesisSummary', /毕业论文(?:核心)?(?:概述|摘要|简介)|thesis.?(?:summary|abstract|description)/i],
      ['thesisTitle', /毕业论文(?:名称|题目)|(?:graduation.?)?thesis.?(?:name|title)/i],
      ['school', /学校|院校|school|university|college|institution/i], ['major', /专业|major|speciality|specialty/i],
      ['degreeTitle', /学位|degree.?title/i], ['degree', /学历|教育层次|education.?level|degree/i],
      ['department', /院系|学院|department|faculty/i], ['startDate', /入学|开始时间|起始时间|start.?date|from.?date/i],
      ['endDate', /毕业时间|结束时间|截止时间|end.?date|to.?date/i], ['gpa', /gpa|绩点/i],
      ['comprehensiveRank', /班级或年级综合排名|班级.*综合排名|年级.*综合排名|综合排名|排名\s*[\/／]\s*总人数|class.?rank/i],
      ['rank', /年级排名|专业排名|排名|rank/i], ['avgScore', /必修课平均分|平均分|average.?score/i], ['courses', /专业课程|主修课程|courses?/i],
      ['isHighest', /是否最高学历|最高学历/i], ['eduType', /受教育类型|教育类型|培养方式|education.?type/i],
      ['duration', /学制|学习年限|duration/i], ['isRegular', /是否统招|统招/i], ['schoolNature', /院校性质|学校性质/i],
      ['isFulltime', /是否全日制|全日制/i], ['countryRegion', /国家地区|国家\/地区|country|region/i],
      ['researchArea', /研究方向|research.?area/i], ['description', /在校经历|教育描述|学习描述/i],
      ['tutorContact', /导师联系方式|导师电话|导师邮箱|(?:mentor|advisor).?contact/i],
      ['tutor', /导师|mentor|advisor|supervisor/i],
      ['isOverseas', /是否海外留学|是否为海外留学|海外留学经历|overseas.?education/i]
    ],
    work: [
      ['hrContactPhone', /HR联系电话|HR联系方式|人事联系电话|人事联系方式|联系人电话|联系人手机|hr.?(?:phone|tel|contact)/i],
      ['hrContactName', /HR联系人|人事联系人|招聘联系人|联系人姓名|hr.?contact.?name/i],
      ['company', /公司|企业|单位名称|实习单位|任职单位|company|employer/i], ['position', /职位|岗位|职务|position|job.?title|role/i],
      ['department', /部门|department|division|team/i], ['city', /城市|地点|location|city/i],
      ['startDate', /入职|开始时间|起始时间|start.?date|from.?date/i], ['endDate', /离职|结束时间|截止时间|end.?date|to.?date/i],
      ['description', /工作描述|工作职责|实习描述|工作内容|主要职责|description|responsibilit/i],
      ['type', /工作性质|工作类型|任职类型|employment.?type|work.?type/i], ['companyNature', /企业性质|公司性质/i],
      ['monthlySalary', /税前.*月薪|月薪|薪资|salary/i], ['certifierName', /证明人姓名|证明人(?!关系|职务|单位|联系)/i],
      ['certifierRelation', /证明人关系/i], ['certifierDuty', /证明人职务/i], ['certifierCompany', /证明人单位/i],
      ['certifierContact', /证明人联系方式|证明人电话|证明人手机/i]
    ],
    projects: [
      ['projectName', /项目名称|课题名称|project.?name|project.?title/i], ['role', /角色|项目职务|担任职务|(?:^|\s)职务(?:[：:*＊\s]|$)|role|position/i],
      ['responsibilities', /项目职责|职责描述|负责内容|承担工作|responsibilit|duties/i],
      ['company', /所在公司|所属公司|company|organization/i], ['techStack', /技术栈|使用技术|tech.?stack|technolog/i],
      ['startDate', /开始时间|起始时间|start.?date|from.?date/i], ['endDate', /结束时间|截止时间|end.?date|to.?date/i],
      ['description', /项目描述|项目内容|项目概述|description/i]
    ],
    awards: [
      ['name', /奖励名称|奖项名称|(?:^|[\s*＊])获奖项(?:[：:\s*＊]|$)|荣誉名称|奖学金名称|证书名称|award.?name|honou?r.?name/i],
      ['category', /奖项类别|奖励类别|荣誉类别|荣誉类型|奖项类型|奖励类型|award.?category|award.?type/i],
      ['level', /奖励级别|奖项级别|获奖级别|荣誉级别|award.?level/i], ['grade', /奖励等级|奖项等级|获奖等级|荣誉等级|award.?grade/i],
      ['date', /获奖时间|获得时间|颁发时间|award.?date|date.?received/i],
      ['issuer', /颁发单位|授予单位|发奖单位|issuing.?organization|issuer/i], ['school', /所在学校|获奖学校/i],
      ['isCadre', /是否学生干部|学生干部/i], ['cadreDesc', /学生干部描述|干部经历/i],
      ['summary', /奖励描述|奖项描述|简要描述|证书描述|award.?summary|award.?description/i]
    ],
    papers: [
      ['title', /论文名称|论文题目|成果名称|paper.?title|publication.?title/i],
      ['publishDate', /发表日期|发表时间|发布时间|接受日期|接收日期|publication.?date/i],
      ['level', /期刊类型|期刊级别|论文级别|论文等级|收录类型|检索类型|期刊或会议水平|paper.?level|journal.?type/i],
      ['journal', /期刊名称|会议名称|期刊\/会议|发表期刊|发表会议|所属期刊|journal|conference/i],
      ['authorRank', /作者排序|作者顺序|作者位次|第几作者|author.?rank|author.?order/i],
      ['yearIssue', /年度\s*[\/／]\s*期次|年[度份]\s*[\/／]\s*期号|卷[期号]\s*[\/／]\s*期号|year.?issue|volume.?issue/i],
      ['status', /发表状态|论文状态|publication.?status/i],
      ['impactFactor', /影响因子|impact.?factor/i],
      ['synopsis', /内容提要|论文摘要|成果概述|abstract|synopsis/i],
      ['achievement', /成就\/等级|成果等级|获奖等级/i],
      ['coauthorType', /合\(独\)著\/译|合著|独著|译著/i],
      ['situation', /出版.*情况|登载.*情况|获奖.*情况|交流.*情况/i]
    ],
    patents: [
      ['name', /专利名称|专利题目|patent.?name|patent.?title/i],
      ['stage', /专利阶段|发表阶段|申请阶段|授权状态|patent.?stage|status/i],
      ['type', /专利类型|专利类别|patent.?type/i],
      ['authorRank', /作者排序|发明人排序|发明人位次|author.?rank/i]
    ],
    campusDuties: [['organization', /组织|团体|社团|organization|club/i], ['duty', /职务|职责|duty|position|role/i]],
    computerSkills: [['skillType', /技能类别|技能名称|skill.?type|skill.?name/i], ['description', /技能描述|description/i]],
    families: [['name', /亲属姓名|家属姓名|family.?name|relative.?name/i], ['relation', /亲属关系|家属关系|relationship/i], ['phone', /联系电话|手机号码|phone|mobile/i], ['workUnit', /工作单位|work.?unit|employer/i], ['position', /职务|岗位|position/i]]
  };
  function buildQuickArrayItems(profile, group) {
    let records = profile[group.key];
    if (group.key === 'languages' && !Array.isArray(records) && records != null && String(records).trim()) {
      records = String(records).trim().split('\n').map(line => ({ level: line.trim() }));
    }
    if (!Array.isArray(records) || !records.length) return [];

    const items = [];
    const visibleFields = group.panelFields || group.fields;
    records.forEach((record, index) => {
      for (const [fieldKey, label] of Object.entries(visibleFields)) {
        const raw = record && record[fieldKey];
        if (raw == null || String(raw).trim() === '') continue;
        items.push({
          label: `${index + 1} · ${label}`,
          value: String(raw).trim(),
          groupKey: group.key,
          fieldKey,
          recordIndex: index
        });
      }
    });
    return items;
  }

  // 面板分组、顺序和可见字段与 popup 保持一致。识别层仍可使用 fields 中的旧字段兼容项，
  // 但面板只遍历 panelFields，避免显示 popup 已删除的数据。
  function buildQuickEntries(profile) {
    const groups = [];
    const arrayByKey = Object.fromEntries(QP_ARRAY_GROUPS.map(g => [g.key, g]));
    const pushArrayGroup = (key, title) => {
      const group = arrayByKey[key];
      if (!group) return [];
      const items = buildQuickArrayItems(profile, group);
      if (items.length) groups.push({ key, title: title || group.title, items });
      return items;
    };

    // 1. 基本信息（个人网站与 GitHub 共用 popup 的单一字段）。
    {
      const obj = profile.basic || {};
      const items = [];
      for (const [k, label] of Object.entries(QP_LABELS.basic)) {
        const raw = k === 'website' ? (obj.website || obj.github) : obj[k];
        if (raw == null || String(raw).trim() === '') continue;
        items.push({ label, value: String(raw).trim(), groupKey: 'basic.' + k, fieldKey: k });
      }
      if (items.length) groups.push({ key: 'basic', title: QP_GROUP_TITLES.basic, items });
    }

    // 2-7. 教育、实习、项目、专利、论文、奖励。
    for (const key of ['education', 'work', 'projects', 'patents', 'papers', 'awards']) pushArrayGroup(key);

    // 8. 语言能力与资格证书（与 popup 合并为同一分组）。
    {
      const languageGroup = arrayByKey.languages;
      const items = languageGroup ? buildQuickArrayItems(profile, languageGroup) : [];
      const certificates = profile.certificates;
      if (certificates != null && String(certificates).trim()) {
        items.push({ label: '资格证书（每行一项）', value: String(certificates).trim(), groupKey: 'certificates', fieldKey: 'certificates' });
      }
      if (items.length) groups.push({ key: 'languageQualifications', title: QP_GROUP_TITLES.languageQualifications, items });
    }

    // 9. 校内职务。
    pushArrayGroup('campusDuties');

    // 10. 家庭关系（紧急联系人也属于 popup 的家庭关系区块）。
    {
      const basic = profile.basic || {};
      const items = [];
      for (const [fieldKey, label] of [
        ['emergencyName', '紧急联系人'],
        ['emergencyPhone', '紧急联系电话'],
        ['emergencyRelation', '紧急联系人关系']
      ]) {
        const raw = basic[fieldKey];
        if (raw != null && String(raw).trim()) {
          items.push({ label, value: String(raw).trim(), groupKey: `basic.${fieldKey}`, fieldKey });
        }
      }
      const familyGroup = arrayByKey.families;
      if (familyGroup) items.push(...buildQuickArrayItems(profile, familyGroup));
      if (items.length) groups.push({ key: 'families', title: '家庭关系', items });
    }

    // 11. 求职意向。
    {
      const obj = profile.jobIntention || {};
      const items = [];
      for (const [k, label] of Object.entries(QP_LABELS.jobIntention)) {
        const raw = obj[k];
        if (raw == null || String(raw).trim() === '') continue;
        items.push({ label, value: String(raw).trim(), groupKey: 'jobIntention.' + k, fieldKey: k });
      }
      if (items.length) groups.push({ key: 'jobIntention', title: QP_GROUP_TITLES.jobIntention, items });
    }

    // 12. 专业技能（包含 popup 同区块中的个人爱好）。
    {
      const items = [];
      for (const [fieldKey, label] of [
        ['skills', '技能列表（每行一项）'],
        ['hobbies', '个人爱好（每行一项）']
      ]) {
        const raw = profile[fieldKey];
        if (raw != null && String(raw).trim()) {
          items.push({ label, value: String(raw).trim(), groupKey: fieldKey, fieldKey });
        }
      }
      if (items.length) groups.push({ key: 'professionalSkills', title: QP_GROUP_TITLES.professionalSkills, items });
    }

    // 13. 计算机技能。
    pushArrayGroup('computerSkills');

    // 14. 其他补充信息（亲属任职字段实际存储在 basic，展示位置与 popup 一致）。
    {
      const obj = profile.extra || {};
      const items = [];
      const hasRelative = profile.basic && profile.basic.hasRelativeInCompany;
      if (hasRelative != null && String(hasRelative).trim()) {
        items.push({
          label: '是否有亲属在单位、集团内任职',
          value: String(hasRelative).trim(),
          groupKey: 'basic.hasRelativeInCompany',
          fieldKey: 'hasRelativeInCompany'
        });
      }
      for (const [k, label] of Object.entries(QP_LABELS.extra)) {
        const raw = obj[k];
        if (raw == null || String(raw).trim() === '') continue;
        items.push({ label, value: String(raw).trim(), groupKey: 'extra.' + k, fieldKey: k });
      }
      if (items.length) groups.push({ key: 'extra', title: QP_GROUP_TITLES.extra, items });
    }

    // 15. 自我评价。
    {
      const raw = profile.selfEvaluation;
      if (raw != null && String(raw).trim()) {
        groups.push({
          key: 'selfEvaluation',
          title: QP_GROUP_TITLES.selfEvaluation,
          items: [{ label: '自我评价', value: String(raw).trim(), groupKey: 'selfEvaluation', fieldKey: 'selfEvaluation' }]
        });
      }
    }
    return groups;
  }

  // 判断输入框属于哪类多条目记录（工作/实习、项目、奖项、语言能力等）及对应字段 key。
  // 用标签/占位符与经历字段中文名做包含匹配（"公司名称"→work.company）。
  // 语言能力的"级别/分数/时间"字段名较通用：需自身或同容器兄弟字段含语言关键词才命中，防误配奖项/时间等。
  function quickSignatureCandidates(el) {
    const direct = [getLabelText(el), getPlaceholder(el), el.name || '', el.id || ''].filter(Boolean).join(' ').trim();
    if (!direct) return [];
    const record = getRecordContext(el);
    const nearby = [direct, getSectionTitle(el), record && record.group, getContextText(el)].filter(Boolean).join(' ');
    const select = el.tagName === 'SELECT' ? el : el.querySelector && el.querySelector('select');
    const optionText = select
      ? Array.from(select.options || []).map(option => option.textContent.trim()).join(' ')
      : collectDropdownOptions(el).join(' ');
    const candidates = [];

    const beisen = getBeisenSectionInfo(el);
    if (beisen) {
      const signature = descriptorFieldSignature({ label: getLabelText(el), placeholder: getPlaceholder(el), options: optionText.split(' ') }, beisen.groupKey);
      if (signature) candidates.push({ ...signature, directLabel: getLabelText(el), strictRecordIndex: true, groupKey: beisen.groupKey, contextMatched: true, score: 300 });
    }

    for (const g of QP_ARRAY_GROUPS) {
      const contextRe = QP_GROUP_CONTEXT[g.key];
      const contextMatched = !!(contextRe && contextRe.test(nearby));
      if (g.key === 'languages') {
        const inLangBlock = contextMatched || g.context.some(kw => direct.includes(kw)) || hasLangContextNearby(el, g.context);
        if (!inLangBlock) continue;
        let fieldKey = 'level', label = '级别', matchLength = 2;
        if (/成绩|分数/.test(direct)) { fieldKey = 'score'; label = '分数'; }
        else if (/时间|日期/.test(direct)) { fieldKey = 'date'; label = '时间'; }
        else if (/是否通过|通过情况/.test(direct)) { fieldKey = 'passed'; label = '是否通过'; }
        else if (/证书/.test(direct)) { fieldKey = 'certName'; label = '证书名称'; }
        else if (/掌握程度|熟练程度|熟练度|听说|口语|读写|阅读|写作/.test(direct)) {
          fieldKey = 'proficiency';
          label = /听说|口语/.test(direct) ? '听说' : (/读写|阅读|写作/.test(direct) ? '读写' : '掌握程度');
          matchLength = label.length;
        }
        else if (/其他语种/.test(direct)) { fieldKey = 'otherLang'; label = '其他语种'; }
        candidates.push({ groupKey: g.key, fieldKey, label, contextMatched: true, score: 120 + matchLength });
        continue;
      }

      const patterns = QP_FIELD_PATTERNS[g.key] || [];
      let best = null;
      if (g.key === 'education') {
        const valuePart = gpaValuePart(direct);
        if (valuePart) {
          const label = valuePart === 'score' ? 'GPA分数' : 'GPA总分';
          best = { fieldKey: 'gpa', valuePart, label, matchLength: label.length + 20 };
        }
      }
      // “奖励等级”在不同站点可能表示 level（国家/省/市/校级）或 grade（特/一/二/三等）。
      // 通过真实选项判别语义，比硬编码某个网站的标签更泛化。
      if (g.key === 'awards' && /奖励等级|奖项等级/.test(direct)) {
        const levelOptions = /国际级|国家级|国际\s*[\/／]\s*国家|省\s*[\/／]\s*市|校内|省部级|省区级|省级|县市级|市级|县级|院校级|校级|院级|班组级|公司级|集团级/.test(optionText);
        const gradeOptions = /特等|一等奖|二等奖|三等奖|一等|二等|三等/.test(optionText);
        const fieldKey = levelOptions && !gradeOptions ? 'level' : 'grade';
        best = { fieldKey, label: g.fields[fieldKey], matchLength: 4 };
      }
      for (const [fieldKey, re] of patterns) {
        const match = direct.match(re);
        if (match && (!best || match[0].length > best.matchLength)) {
          best = { fieldKey, label: g.fields[fieldKey], matchLength: match[0].length };
        }
      }
      for (const [fieldKey, label] of Object.entries(g.fields)) {
        if (label && (direct.includes(label) || label.includes(direct))) {
          const matchLength = Math.min(label.length, direct.length);
          if (!best || matchLength > best.matchLength) best = { fieldKey, label, matchLength };
        }
      }
      if (best) {
        candidates.push({
          groupKey: g.key,
          fieldKey: best.fieldKey,
          valuePart: best.valuePart,
          label: best.label,
          contextMatched,
          score: best.matchLength + (contextMatched ? 100 : 0) + (direct === best.label ? 10 : 0)
        });
      }
    }
    return candidates.sort((a, b) => b.score - a.score);
  }

  function quickFieldSignature(el) {
    return quickSignatureCandidates(el)[0] || null;
  }

  // 语言块判定：向上 3 层，看容器内其他可见字段（如"英语水平/CET等级"）是否含语言关键词
  function hasLangContextNearby(el, kws) {
    let cur = el.parentElement;
    for (let i = 0; i < 3 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      const fields = cur.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
      for (const f of fields) {
        if (f === el) continue;
        const t = [getLabelText(f), getPlaceholder(f), f.name || ''].join(' ').trim();
        if (kws.some(kw => t.includes(kw))) return true;
      }
    }
    return false;
  }

  // 检测当前输入框在其所属多条目区块中是第几条（0-based）。
  // 向上找包含 >=2 个同标签字段的容器（即多条目表单块），再统计 el 是第几个。
  function quickRecordIndex(el, sigLabel) {
    if (!sigLabel) return 0;
    // 统一为可写字段：点击命中的可能是自定义组件容器（div[role=combobox]/picker 等），
    // 若直接用容器对比 querySelectorAll 返回的原生字段会永远不相等 → 永远返回 0（推荐第 1 条）。
    // 解包为容器内部的可写 input/textarea 再参与统计。
    const isWritable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    const target = isWritable ? el : (el && el.querySelector ? el.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select') : null);
    if (!target) return 0;

    const structural = getRecordContext(target);
    if (structural && Number.isInteger(structural.index)) return structural.index;

    let container = null;
    let cur = el.parentElement;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      const fields = cur.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
      let cnt = 0;
      fields.forEach(f => {
        if (!isVisible(f)) return;
        const l = getLabelText(f) || getPlaceholder(f);
        if (l && (l === sigLabel || l.includes(sigLabel) || sigLabel.includes(l))) cnt++;
      });
      // 容器需包含目标字段，避免误认到不相关的其他区块容器
      if (cnt >= 2 && cur.contains(target)) { container = cur; break; }
    }
    if (!container) return 0;
    const fields = container.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
    let idx = 0, found = false;
    fields.forEach(f => {
      const l = getLabelText(f) || getPlaceholder(f);
      if (!l) return;                                       // 无标签/占位符的字段不参与同标签统计
      if (l === sigLabel || l.includes(sigLabel) || sigLabel.includes(l)) {
        if (f === target) found = true;
        else if (!found) idx++;
      }
    });
    return found ? idx : 0;
  }

  // 为多条目字段计算推荐值：取简历该类型第 index 条记录中同名字段的值
  function quickRecommend(profile, sig, index) {
    if (!sig) return null;
    const arr = profile[sig.groupKey];
    if (!Array.isArray(arr) || !arr.length) return null;
    if (sig.strictRecordIndex && (index < 0 || index >= arr.length)) return null;
    const rec = arr[Math.min(index, arr.length - 1)];
    const val = rec && derivedRecordValueCandidates(rec, sig.groupKey, sig.fieldKey, sig.directLabel)[0];
    if (val == null || String(val).trim() === '') return null;
    let recommendedValue = String(val).trim();
    if (sig.groupKey === 'education' && sig.fieldKey === 'gpa' && sig.valuePart) {
      const split = splitCombinedGpa(recommendedValue);
      if (!split || !split[sig.valuePart]) return null;
      recommendedValue = split[sig.valuePart];
    }
    return {
      groupKey: sig.groupKey,
      fieldKey: sig.fieldKey,
      valuePart: sig.valuePart,
      value: recommendedValue,
      index,
      total: arr.length
    };
  }

  // 点击目标 → 可填写的表单字段（原生或自定义组件容器）；非字段返回 null
  function resolveQuickField(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target.closest('#resume-autofill-actions')) return null;   // 插件自身元素不弹
    let el = target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
    if (!el) {
      // 自定义组件：点击了外层容器（ant-select / picker 等），需内含可写 input/textarea
      el = target.closest('[class*="select"]:not(select), [class*="picker"], [class*="dropdown"], [class*="combobox"], [class*="cascader"], [role="combobox"]');
      if (!el || !el.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea')) return null;
    }
    if (el.tagName === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'file', 'password', 'search', 'range', 'color'].includes(type)) return null;
    }
    if (!isVisible(el)) return null;
    if (isSearchLikeField(el)) return null;                    // 搜索框不弹
    if (isBlockedAutofillField(el)) return null;                // 验证码/OTP 等安全字段绝不自动填充
    return el;
  }

  // 面板宿主（Shadow DOM 隔离页面样式）
  let qp = null;

  function createQuickPanel() {
    const host = document.createElement('div');
    host.id = 'resume-autofill-qp';
    host.style.position = 'absolute';
    host.style.zIndex = '2147483647';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { color-scheme: light; --qp-surface: #f7faff; --qp-control: #fff; --qp-blur: none;
        --qp-border: rgba(168,183,203,.5); --qp-accent: #5298fa; }
      .qp { position: relative; width: 360px; max-height: 380px; display: flex; flex-direction: column;
        background: var(--qp-surface); border: 1px solid var(--qp-border); border-radius: 18px;
        box-shadow: 0 14px 34px rgba(39,57,86,.2), inset 0 1px 0 #fff; box-sizing: border-box;
        -webkit-backdrop-filter: var(--qp-blur); backdrop-filter: var(--qp-blur);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 13px; color: #202b3c; overflow: hidden; }
      .qp * { box-sizing: border-box; }
      .qp-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 6px;
        font-weight: 600; font-size: 12px; color: #56667e; }
      .qp-head-actions { display: flex; align-items: center; gap: 6px; }
      .qp-icon-button { flex: 0 0 auto; width: 20px; height: 20px; border: 1px solid rgba(151,173,202,.4);
        background: var(--qp-control); color: #50627b; border-radius: 6px; cursor: pointer;
        font-family: inherit; font-size: 13px; line-height: 1; display: flex; align-items: center;
        justify-content: center; padding: 0; box-shadow: inset 0 1px 0 rgba(255,255,255,.9);
        transition: background .16s ease, border-color .16s ease, color .16s ease; }
      .qp-icon-button:hover { background: #fff; border-color: #91b5e6; color: #285cae; }
      .qp-close, .qp-append { width: auto; height: 28px; gap: 6px; padding: 0 8px;
        border-radius: 999px; white-space: nowrap; font-size: 11px; font-weight: 600; }
      .qp-close.is-enabled, .qp-append.is-enabled { background: rgba(225,239,255,.85); border-color: #b5d2f5; color: #285cae; }
      .qp-close.is-enabled:hover, .qp-append.is-enabled:hover { background: #d3e7ff; border-color: #91b5e6; color: #174f9d; }
      .qp-toggle-track { position: relative; flex: 0 0 22px; width: 22px; height: 13px; border-radius: 999px;
        background: #9aa9bb; box-shadow: inset 0 1px 2px rgba(39,57,86,.12); transition: background .16s ease; }
      .qp-toggle-track::after { content: ''; position: absolute; width: 9px; height: 9px; left: 2px; top: 2px;
        border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(39,57,86,.22); transition: transform .16s ease; }
      .is-enabled .qp-toggle-track { background: #418be9; }
      .is-enabled .qp-toggle-track::after { transform: translateX(9px); }
      .qp-collapse { width: 26px; height: 26px; border-radius: 50%; }
      .qp-append:disabled { opacity: .5; cursor: not-allowed; }
      .qp-icon-button:focus-visible { outline: 2px solid #397fe5; outline-offset: 1px; }
      /* 收起后的小图标（点击重新展开完整面板） */
      .qp-mini { display: none; width: 46px; height: 46px; box-sizing: border-box; border-radius: 50%;
        border: 1px solid var(--qp-border); background: var(--qp-surface); color: #285cae;
        -webkit-backdrop-filter: var(--qp-blur); backdrop-filter: var(--qp-blur);
        font-size: 18px; font-weight: 700; align-items: center; justify-content: center; cursor: pointer;
        box-shadow: 0 6px 20px rgba(39,57,86,.18), inset 0 1px 0 #fff; user-select: none; }
      .qp-mini:hover { background: #e6f1ff; }
      .qp-mini:active { transform: scale(.95); }
      .qp-reco-tip { display: none; margin: 0 10px 4px; padding: 5px 8px; background: rgba(255,247,230,.8); color: #965609;
        border: 1px solid rgba(224,183,112,.25); border-radius: 8px; font-size: 11px; }
      .qp-search { display: block; width: calc(100% - 20px); margin: 4px 10px 8px; padding: 6px 9px;
        border: 1px solid rgba(136,160,192,.38); border-radius: 10px; background: var(--qp-control);
        font-family: inherit; font-size: 12px; outline: none; color: #26324a;
        box-shadow: inset 0 1px 2px rgba(69,92,128,.03), 0 1px 0 rgba(255,255,255,.6); }
      .qp-search::placeholder { color: #738097; }
      .qp-search:focus { border-color: #69a3f0; box-shadow: 0 0 0 3px rgba(82,152,250,.17); }
      .qp-list { overflow-y: auto; max-height: 300px; min-height: 0; padding: 0 6px 6px;
        scrollbar-width: thin; scrollbar-color: rgba(113,142,180,.4) transparent; }
      .qp-group + .qp-group { margin-top: 4px; }
      .qp-group-head { display: flex; align-items: center; gap: 6px; padding: 7px 9px; font-size: 12px; color: #56667e;
        background: var(--qp-group-tint, rgba(255,255,255,.3)); border-radius: 9px; cursor: pointer; user-select: none;
        border-bottom: 1px solid rgba(90,116,153,.08); }
      .qp-group-head:hover { background: rgba(211,232,255,.65); }
      .qp-caret { flex: 0 0 auto; width: 0; height: 0; border-left: 5px solid #7a8ca5; border-top: 4px solid transparent;
        border-bottom: 4px solid transparent; transition: transform .15s; }
      .qp-group-head.open .qp-caret { transform: rotate(90deg); }
      .qp-group-title-text { flex: 1 1 auto; }
      .qp-group-count { flex: 0 0 auto; color: #738097; font-size: 11px; }
      .qp-group-body { display: none; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 2px 4px; padding-top: 3px; }
      .qp-item { display: flex; align-items: baseline; gap: 6px; padding: 6px 8px; border-radius: 7px;
        cursor: pointer; line-height: 1.5; min-width: 0; }
      .qp-item-reco { background: rgba(255,245,211,.75); box-shadow: inset 2px 0 0 #e9a23b; }
      .qp-item:hover, .qp-item.active { background: var(--qp-accent); }
      .qp-item-label { flex: 0 0 64px; width: 64px; max-width: 40%; min-width: 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; color: var(--qp-label-color, #64748b); font-size: 12px; }
      .qp-item-value { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #202b3c; }
      .qp-item:hover .qp-item-label, .qp-item:hover .qp-item-value,
      .qp-item.active .qp-item-label, .qp-item.active .qp-item-value { color: #fff; }
      .qp-remember { align-self: center; background: var(--qp-control); color: #345581; }
      .qp-remember:hover { background: #fff; color: #285cae; }
      .qp-remember.is-saved { border-color: #b7dfc2; background: rgba(240,255,244,.9); color: #237a3b; }
      .qp-empty { padding: 14px; text-align: center; color: #64748b; font-size: 12px; }
      @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        :host { --qp-surface: rgba(250,252,255,.78); --qp-control: rgba(255,255,255,.58);
          --qp-blur: blur(24px) saturate(145%); }
      }
      @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
        :host { --qp-surface: #f7faff; --qp-control: #fff; --qp-border: #b7c5d8; --qp-blur: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .qp *, .qp-toggle-track::after, .qp-mini { transition: none; }
        .qp-mini:active { transform: none; }
      }
    `;
    const box = document.createElement('div');
    box.className = 'qp';
    box.innerHTML =
      '<div class="qp-head"><span>选择简历信息</span><div class="qp-head-actions">' +
      '<button class="qp-icon-button qp-append" type="button" title="开启后依次追加到文本框末尾" aria-label="追加填写" aria-pressed="false"><span>追加填写</span><span class="qp-toggle-track" aria-hidden="true"></span></button>' +
      '<button class="qp-icon-button qp-close" type="button" title="关闭自动推荐填写" aria-label="自动推荐" aria-pressed="true"><span>自动推荐</span><span class="qp-toggle-track" aria-hidden="true"></span></button>' +
      '<button class="qp-icon-button qp-collapse" type="button" title="收起为小图标" aria-label="收起推荐框">—</button>' +
      '</div></div>' +
      '<div class="qp-reco-tip"></div>' +
      '<input class="qp-search" type="text" placeholder="搜索（姓名/手机/学校…）"/>' +
      '<div class="qp-list"></div>';
    const search = box.querySelector('.qp-search');
    search.addEventListener('input', () => {
      renderQuickList(qp.groups || [], search.value, qp.reco);
      if (enhancement && qp?.target) positionQuickPanel(qp.target);
    });
    // 收起为小图标（仅隐藏面板主体，保留小圆钮便于重新展开）
    box.querySelector('.qp-collapse').addEventListener('click', (e) => {
      e.stopPropagation();
      minimizeQuickPanel();
    });
    // 自动填写开关：只切换“点击字段后直接写入”，面板本身保持打开且仍可手动点选。
    box.querySelector('.qp-close').addEventListener('mousedown', e => e.preventDefault());
    box.querySelector('.qp-close').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQuickAutoFill();
    });
    const appendButton = box.querySelector('.qp-append');
    appendButton.addEventListener('mousedown', e => e.preventDefault());
    appendButton.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQuickAppend();
    });
    // 小图标：点击重新展开完整面板
    const mini = document.createElement('div');
    mini.className = 'qp-mini';
    mini.textContent = '简';
    mini.title = '展开简历信息面板';
    mini.addEventListener('click', () => expandQuickPanel());
    shadow.appendChild(style);
    shadow.appendChild(box);
    shadow.appendChild(mini);
    document.body.appendChild(host);
    host.style.display = 'none';
    return { host, box, search, list: box.querySelector('.qp-list'), recoTip: box.querySelector('.qp-reco-tip'), mini };
  }

  // 收起面板 → 只保留小图标（minimized 态下外部点击/Esc/滚动不关闭，小图标常驻）
  function minimizeQuickPanel() {
    if (!qp) return;
    qp.minimized = true;
    qp.box.style.display = 'none';
    qp.mini.style.display = 'flex';
  }

  // 点击小图标 → 重新展开完整面板
  function expandQuickPanel() {
    if (!qp) return;
    qp.minimized = false;
    qp.box.style.display = 'flex';
    qp.mini.style.display = 'none';
  }

  function updateQuickAutoFillToggle() {
    if (!qp || !qp.box) return;
    const button = qp.box.querySelector('.qp-close');
    if (!button) return;
    button.classList.toggle('is-enabled', quickAutoFillEnabled);
    button.title = quickAutoFillEnabled ? '自动推荐已开启：点击关闭自动填写，仍可手动选择'
      : '自动推荐已关闭：点击开启，匹配后自动填写';
    button.setAttribute('aria-pressed', quickAutoFillEnabled ? 'true' : 'false');
  }

  function toggleQuickAutoFill() {
    quickAutoFillEnabled = !quickAutoFillEnabled;
    updateQuickAutoFillToggle();
    if (qp && qp.open) renderQuickList(qp.groups || [], qp.search.value, qp.reco);
    return quickAutoFillEnabled;
  }

  function quickAppendInput(el) {
    if (!el) return null;
    const type = detectComponentType(el);
    const input = type === 'wrapper-input'
      ? el.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea')
      : el;
    if (!input || input.disabled || input.readOnly || detectComponentType(input) !== 'native-input') return null;
    if (input.tagName === 'TEXTAREA') return input;
    return input.tagName === 'INPUT' && ['text', 'email', 'tel', 'url', 'search'].includes(input.type || 'text')
      ? input : null;
  }

  function quickAppendValue(input, value) {
    // 直接读取原始值，保留用户已有的空白；单行 input 会吞掉换行，先改为空格。
    const multiline = input.tagName === 'TEXTAREA';
    const current = String(input.value || '');
    const next = String(value == null ? '' : value).replace(multiline ? /\r\n?/g : /[\r\n]+/g, multiline ? '\n' : ' ');
    if (!current || !next) return current + next;
    const separated = multiline ? /\n$/.test(current) || /^\n/.test(next) : /\s$/.test(current) || /^\s/.test(next);
    return current + (separated ? '' : multiline ? '\n' : ' ') + next;
  }

  function updateQuickAppendToggle() {
    if (!qp || !qp.box) return;
    const button = qp.box.querySelector('.qp-append');
    if (!button) return;
    const supported = !!quickAppendInput(qp.target);
    button.disabled = !supported;
    button.classList.toggle('is-enabled', quickAppendEnabled && supported);
    button.setAttribute('aria-pressed', String(quickAppendEnabled && supported));
    button.title = !supported ? '此控件不支持文本追加，仍按原方式填写'
      : quickAppendEnabled ? '追加填写已开启：点击恢复覆盖；单行用空格、多行用换行分隔'
        : '追加填写已关闭：点击开启，在原文末尾追加内容';
  }

  function toggleQuickAppend() {
    if (!qp || !quickAppendInput(qp.target)) return quickAppendEnabled;
    quickAppendEnabled = !quickAppendEnabled;
    updateQuickAppendToggle();
    updateQuickPanelTip(qp.reco);
    if (qp.open) positionQuickPanel(qp.target);
    return quickAppendEnabled;
  }

  function updateQuickPanelTip(reco) {
    if (!qp || !qp.recoTip) return;
    const tips = [];
    if (quickAppendEnabled) {
      tips.push(quickAppendInput(qp.target)
        ? '追加填写已开启：单行用空格、多行用换行分隔，可连续点选多条信息'
        : '此控件不支持文本追加，仍按原方式填写');
    }
    if (!quickAutoFillEnabled) {
      tips.push('自动推荐填写已关闭，仍可手动选择；点击顶部“自动推荐”开关可重新开启');
    } else if (reco) {
      tips.push('正在填写第 ' + (reco.index + 1) + '/' + reco.total + ' 条，已推荐对应数据');
    }
    qp.recoTip.textContent = tips.join('；');
    qp.recoTip.style.display = tips.length ? 'block' : 'none';
  }

  function renderQuickList(groups, query, reco) {
    const list = qp.list;
    const hasSavedGroup = qp.expandedGroup !== undefined;
    // 每次只展开一个分组，null 表示用户已收起；保留到本页下次打开。
    if (!hasSavedGroup) qp.expandedGroup = reco?.groupKey || null;
    list.innerHTML = '';
    const q = (query || '').trim().toLowerCase();
    const visibleGroups = groups.map(g => ({ ...g, items: q
      ? g.items.filter(it => it.label.toLowerCase().includes(q) || it.value.toLowerCase().includes(q))
      : g.items })).filter(g => g.items.length);
    // 搜索也只展开一个匹配分组，清空后恢复搜索前的选择。
    if (qp.groupQuery !== q) {
      qp.groupQuery = q;
      qp.searchExpandedGroup = undefined;
    }
    if (q && qp.searchExpandedGroup === undefined) {
      qp.searchExpandedGroup = visibleGroups.some(g => g.key === qp.expandedGroup)
        ? qp.expandedGroup : visibleGroups[0]?.key || null;
    }
    const expandedGroup = q ? qp.searchExpandedGroup : qp.expandedGroup;
    const groupViews = [];
    const pinExpandedGroup = key => {
      const expanded = groupViews.find(view => view.key === key);
      const ordered = expanded ? [expanded, ...groupViews.filter(view => view !== expanded)] : groupViews;
      // 展开分组放在搜索框下方，其余分组保持原顺序；只滚动面板内的列表。
      list.append(...ordered.map(view => view.element));
      list.scrollTop = 0;
    };
    let shown = 0;
    for (const g of visibleGroups) {
      const matched = g.items;
      const groupEl = document.createElement('div');
      groupEl.className = 'qp-group';

      // 大类标题行（可点击展开/收起），带分组主题色
      const gColor = quickGroupColor(g.key);
      const headEl = document.createElement('div');
      headEl.className = 'qp-group-head';
      headEl.style.borderLeft = '3px solid ' + gColor;
      headEl.style.setProperty('--qp-group-tint', gColor + '14');
      const caret = document.createElement('span');
      caret.className = 'qp-caret';
      const title = document.createElement('span');
      title.className = 'qp-group-title-text';
      title.textContent = g.title;
      title.style.color = gColor;
      const count = document.createElement('span');
      count.className = 'qp-group-count';
      count.textContent = String(matched.length);
      count.style.color = gColor;
      headEl.appendChild(caret);
      headEl.appendChild(title);
      headEl.appendChild(count);

      // 条目区（默认折叠）
      const bodyEl = document.createElement('div');
      bodyEl.className = 'qp-group-body';
      for (const it of matched) {
        const row = document.createElement('div');
        row.className = 'qp-item';
        row.dataset.value = it.value;
        // 推荐项（多条目字段自动匹配的第 N 条记录对应值）高亮标注
        const isReco = reco && it.groupKey === reco.groupKey && it.fieldKey === reco.fieldKey &&
          it.value === reco.value && (!reco.valuePart || it.valuePart === reco.valuePart);
        if (isReco) row.classList.add('qp-item-reco');
        const label = document.createElement('span');
        label.className = 'qp-item-label';
        label.textContent = it.label;
        label.title = it.label;
        // 组内多记录（教育1/教育2…）按记录序号取色区分；非数组字段用分组主题色
        label.style.setProperty('--qp-label-color', (typeof it.recordIndex === 'number' && it.recordIndex >= 0)
          ? QP_ENTRY_COLORS[it.recordIndex % QP_ENTRY_COLORS.length]
          : gColor);
        const val = document.createElement('span');
        val.className = 'qp-item-value';
        val.textContent = it.value;
        val.title = it.value;
        row.appendChild(label);
        row.appendChild(val);
        // 阻止 mousedown 导致页面输入框 blur 触发组件重排/收面板
        row.addEventListener('mousedown', ev => ev.preventDefault());
        row.addEventListener('click', () => quickPick(it.value));
        if (enhancement) {
          const remember = document.createElement('button');
          remember.type = 'button';
          remember.className = 'qp-icon-button qp-remember';
          remember.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
          remember.title = '记住对应信息：' + it.label + '（仅补充当前网站未匹配字段）';
          remember.setAttribute('aria-label', remember.title);
          remember.addEventListener('click', async event => {
            event.stopPropagation();
            try {
              await enhancement.remember(qp.target, it, quickAppendEnabled);
              remember.textContent = '✓';
              remember.classList.add('is-saved');
              remember.title = '已记住对应信息：' + it.label;
              remember.setAttribute('aria-label', remember.title);
            }
            catch (error) { showQuickFillFailureTip(qp.target, error.message); }
          });
          row.appendChild(remember);
        }
        bodyEl.appendChild(row);
        shown++;
      }

      const open = expandedGroup === g.key;
      bodyEl.style.display = open ? 'grid' : 'none';
      if (open) headEl.classList.add('open');
      headEl.setAttribute('aria-expanded', String(open));
      groupViews.push({ key: g.key, element: groupEl, head: headEl, body: bodyEl });

      headEl.addEventListener('click', () => {
        const nextGroup = bodyEl.style.display === 'none' ? g.key : null;
        if (q) qp.searchExpandedGroup = nextGroup;
        else qp.expandedGroup = nextGroup;
        for (const view of groupViews) {
          const isOpen = view.key === nextGroup;
          view.body.style.display = isOpen ? 'grid' : 'none';
          view.head.classList.toggle('open', isOpen);
          view.head.setAttribute('aria-expanded', String(isOpen));
        }
        pinExpandedGroup(nextGroup);
        // 新增的“记住对应”入口必须处于可点击区域；展开后重新测量面板高度。
        if (enhancement && qp?.target) positionQuickPanel(qp.target);
      });

      groupEl.appendChild(headEl);
      groupEl.appendChild(bodyEl);
      list.appendChild(groupEl);
    }
    if (!shown) {
      const empty = document.createElement('div');
      empty.className = 'qp-empty';
      empty.textContent = '没有匹配的简历信息';
      list.appendChild(empty);
    }

    // 顶部推荐提示条
    updateQuickPanelTip(reco);

    // 恢复上次展开状态或搜索结果时，同样从置顶分组的标题开始显示。
    pinExpandedGroup(expandedGroup);
  }

  function quickPanelAnchorRect(el) {
    const baseRect = el.getBoundingClientRect();
    let anchorRect = baseRect;
    let current = el;
    const controlSelector = [
      '[role="combobox"]', '[role="radiogroup"]',
      '[class*="ant-select"]', '[class*="ant-picker"]', '[class*="ant-input-affix"]',
      '[class*="el-select"]', '[class*="el-input"]', '[class*="el-date-editor"]',
      '[class*="arco-select"]', '[class*="select-view"]', '[class*="input-wrapper"]',
      '[class*="input-affix"]', '[class*="cascader"]', '[class*="radio-group"]',
      '[class*="checkbox-group"]'
    ].join(',');
    // 自定义选择器常把真正的 input 缩成很小一块；向上寻找尺寸合理的完整控件包装层。
    for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) {
      if (!current.matches) continue;
      let isControl = false;
      try { isControl = current.matches(controlSelector); } catch (e) { /* ignore */ }
      if (!isControl || typeof current.getBoundingClientRect !== 'function') continue;
      const candidate = current.getBoundingClientRect();
      const maxHeight = Math.max(160, (baseRect.height || 32) * 4);
      if (candidate.width > 0 && candidate.height > 0 && candidate.height <= maxHeight &&
          candidate.width >= Math.max(1, baseRect.width || 0)) {
        anchorRect = candidate;
      }
    }
    return anchorRect;
  }

  function calculateQuickPanelPlacement(anchorRect, viewportWidth, viewportHeight, panelWidth, panelHeight) {
    const margin = 8;
    const gap = 12;
    const vw = Math.max(1, Number(viewportWidth) || 1);
    const vh = Math.max(1, Number(viewportHeight) || 1);
    const rect = {
      left: Number(anchorRect.left) || 0,
      top: Number(anchorRect.top) || 0,
      right: Number.isFinite(anchorRect.right) ? anchorRect.right : (Number(anchorRect.left) || 0) + (Number(anchorRect.width) || 0),
      bottom: Number.isFinite(anchorRect.bottom) ? anchorRect.bottom : (Number(anchorRect.top) || 0) + (Number(anchorRect.height) || 0)
    };
    let width = Math.min(Math.max(1, Number(panelWidth) || 360), Math.max(1, vw - margin * 2));
    let height = Math.min(Math.max(1, Number(panelHeight) || 380), Math.max(1, vh - margin * 2));
    const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
    const alignedTop = () => clamp(rect.top, margin, vh - margin - height);
    const rightLeft = rect.right + gap;
    const leftLeft = rect.left - gap - width;

    if (rightLeft + width <= vw - margin) {
      return { left: rightLeft, top: alignedTop(), width, height, side: 'right' };
    }
    if (leftLeft >= margin) {
      return { left: leftLeft, top: alignedTop(), width, height, side: 'left' };
    }

    // 两侧均放不下完整面板时，移到字段下方或上方，避免横向钳位后重新盖住字段。
    const belowTop = rect.bottom + gap;
    const aboveTop = rect.top - gap - height;
    const horizontalLeft = clamp(rect.left, margin, vw - margin - width);
    if (belowTop + height <= vh - margin) {
      return { left: horizontalLeft, top: belowTop, width, height, side: 'below' };
    }
    if (aboveTop >= margin) {
      return { left: horizontalLeft, top: aboveTop, width, height, side: 'above' };
    }

    // 极小视口：选择垂直空间较大的一侧并压缩最大高度，仍不覆盖字段本身。
    const belowSpace = Math.max(1, vh - margin - belowTop);
    const aboveSpace = Math.max(1, rect.top - gap - margin);
    if (belowSpace >= aboveSpace) {
      height = Math.min(height, belowSpace);
      return { left: horizontalLeft, top: belowTop, width, height, side: 'below' };
    }
    height = Math.min(height, aboveSpace);
    return { left: horizontalLeft, top: Math.max(margin, rect.top - gap - height), width, height, side: 'above' };
  }

  function positionQuickPanel(el) {
    const anchorRect = quickPanelAnchorRect(el);
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const sx = window.scrollX, sy = window.scrollY;
    // 先显示再测量实际内容高度；宽度与 .qp 的 360px 保持一致。
    qp.host.style.display = 'block';
    qp.box.style.width = '360px';
    qp.box.style.maxHeight = '380px';
    const panelRect = qp.box.getBoundingClientRect();
    const placement = calculateQuickPanelPlacement(
      anchorRect,
      vw,
      vh,
      panelRect.width || 360,
      panelRect.height || 380
    );
    qp.box.style.width = placement.width + 'px';
    qp.box.style.maxHeight = placement.height + 'px';
    qp.host.style.left = (placement.left + sx) + 'px';
    qp.host.style.top = (placement.top + sy) + 'px';
    qp.host.dataset.side = placement.side;
  }

  async function showQuickPanel(el) {
    if (!quickFillEnabled) return;
    if (!qp) qp = createQuickPanel();
    const profile = await getProfile();
    const groups = buildQuickEntries(profile);
    if (!groups.length) return;                    // 尚未保存简历信息 → 不弹
    // 多条目字段推荐：识别输入框属于哪类经历的第几条，推荐对应记录的同名字段值
    let reco = null;
    const sig = quickFieldSignature(el);
    if (sig) {
      const index = quickRecordIndex(el, sig.label);
      reco = quickRecommend(profile, sig, index);
    }
    qp.target = el;
    qp.targetSelector = generateSelector(el);
    qp.groups = groups;
    qp.reco = reco;
    qp.minimized = false;                    // 每次弹出都重置为展开态
    qp.box.style.display = 'flex';
    qp.mini.style.display = 'none';
    qp.search.value = '';
    updateQuickAutoFillToggle();
    updateQuickAppendToggle();
    renderQuickList(groups, '', reco);
    positionQuickPanel(el);
    qp.open = true;
  }

  function closeQuickPanel() {
    if (!qp) return;
    qp.open = false;
    qp.minimized = false;
    qp.host.style.display = 'none';
    qp.target = null;
    qp.targetSelector = null;
    qp.reco = null;
  }

  function resolveQuickFillElement(el, selector) {
    if (selector) {
      const fresh = findElement(selector);
      if (fresh) return fresh;
    }
    return el && el.isConnected !== false ? el : null;
  }

  function quickFillValueMatches(el, value) {
    if (!el) return false;
    const candidates = (Array.isArray(value) ? value : [value])
      .map(item => String(item == null ? '' : item).trim()).filter(Boolean);
    if (!candidates.length) return false;
    const actual = currentFieldValue(el);
    const display = getDropdownDisplayValue(el);
    if (getPhoenixDateTrigger(el)) return candidates.some(candidate => dateValuesMatchPrecision(display, candidate));
    return candidates.some(candidate => valuesEquivalent(actual, candidate) || valuesEquivalent(display, candidate));
  }

  async function confirmQuickFillResult(el, value, componentType, selector) {
    const matches = () => quickFillValueMatches(resolveQuickFillElement(el, selector) || el, value);
    if (matches()) return true;
    if (!String(componentType || '').startsWith('custom-')) return false;
    return waitForCondition(matches, componentType === 'custom-datepicker' ? 700 : 360, 25);
  }

  async function quickPick(value) {
    const el = qp && resolveQuickFillElement(qp.target, qp.targetSelector);
    if (!el) return;
    if (running || quickFillRunning) return;
    const appendInput = quickAppendEnabled && quickAppendInput(el);
    const searchFocused = qp.search.getRootNode().activeElement === qp.search;
    if (!appendInput) closeQuickPanel();
    quickFillRunning = true;
    try {
      const componentType = detectComponentType(el);
      let fillEl = el;
      // 容器型（wrapper-input）：解包到内部 input 再填，避免对 div 调原生 setter
      if (componentType === 'wrapper-input') {
        const inner = el.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea');
        if (inner) fillEl = inner;
      }
      const selectorForFill = generateSelector(fillEl) || generateSelector(el);
      if (appendInput) value = quickAppendValue(appendInput, value);
      // 追加后的总长度超限时保留原文，避免网站静默截断已填内容。
      if (appendInput && appendInput.maxLength >= 0 && value.length > appendInput.maxLength) {
        showQuickFillFailureTip(appendInput, '追加后超出此输入框的字数限制，请精简内容后重试');
        return;
      }
      let filled = await fillByType(fillEl, value, componentType, selectorForFill);
      if (!filled) filled = await confirmQuickFillResult(fillEl, value, componentType, selectorForFill);
      const liveEl = resolveQuickFillElement(fillEl, selectorForFill) || fillEl;
      if (appendInput && qp.open) {
        qp.target = liveEl;
        qp.targetSelector = selectorForFill;
        positionQuickPanel(liveEl);
        if (searchFocused) qp.search.focus({ preventScroll: true });
      }
      if (!filled) {
        console.warn('[简历填充] 推荐信息写入后校验未通过:', selectorForFill, componentType);
        showQuickFillFailureTip(liveEl, componentType === 'custom-datepicker'
          ? '日期未能自动写入，请使用页面日期选择器'
          : '推荐信息未能写入，请重试');
        return;
      }
      highlightField(liveEl);
      enhancement?.manualPick(liveEl);
      if (appendInput) showQuickFillTip(liveEl, '已追加：推荐信息，可继续点选', 'success');
      else showAutoFillTip(liveEl, '推荐信息');
    } catch (err) {
      console.warn('[简历填充] 快速填充失败:', err);
    } finally {
      quickFillRunning = false;
    }
  }

  function currentFieldValue(el) {
    if (el.tagName === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        return getChoiceGroupElements(el).filter(x => x.checked).map(getChoiceOptionText).join('、');
      }
      return isPlaceholderLikeValue(el) ? '' : (el.value || '');
    }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return isPlaceholderLikeValue(el) ? '' : (el.value || '');
    if (el.isContentEditable) return (el.textContent || '').trim();
    const inner = el.querySelector('input:not([type="hidden"]), textarea, select');
    return inner ? (isPlaceholderLikeValue(inner) ? '' : (inner.value || '')) : '';
  }

  // ===== 点击输入框自动匹配（直填；未命中/已有值/有歧义时返回 false 由调用方兜底弹面板）=====
  // 匹配顺序：① 单记录字段（基本信息/求职意向/其他补充/紧急联系人等）→ 本地规则直填（保守带负向排除）
  //          ② 多记录字段（教育/实习/项目/奖项…）→ 标签无跨组歧义时按记录序号取推荐值
  function isMultiRecordField(el) {
    if (getRecordContext(el)) return true;
    const label = getLabelText(el) || getPlaceholder(el) || '';
    if (!label.trim()) return false;
    let cur = el.parentElement;
    for (let i = 0; i < 5 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      const fields = cur.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
      let cnt = 0;
      fields.forEach(f => {
        if (!isVisible(f)) return;
        const l = getLabelText(f) || getPlaceholder(f) || '';
        if (l && (l === label || l.includes(label) || label.includes(l))) cnt++;
      });
      if (cnt >= 2) return true;
    }
    return false;
  }

  // 多记录字段自动填的最佳签名：取"匹配标签最长"的组（短标签如"公司"不遮蔽项目的"所在公司"），
  // 供自动匹配使用；面板内推荐仍用 quickFieldSignature（首个匹配）保持原行为。
  function quickBestSignature(el) {
    return quickSignatureCandidates(el)[0] || null;
  }

  // 多记录字段自动填的置信度判定：裸通用词 / 点击文本命中多个分组 → 歧义，交面板人工选择。
  // 歧义计数规则：短标签(长度<3)仅当"恰好等于文本"时算一个候选组（裸"公司/职位"确实跨组歧义），
  // 作为子串时不计数（避免 awards"名称"覆盖所有"X名称"、work"公司"覆盖"所在公司"）。
  const QP_AUTO_GENERIC = ['姓名', '城市', '时间', '日期', '描述', '名称', '电话', '角色', '关系', '级别', '分数', '水平', '状态', '编号', '地址', '单位', '部门', '类型'];
  function quickAutoConfident(el, sig) {
    if (!sig) return false;
    const text = [getLabelText(el), getPlaceholder(el), el.name || ''].join(' ').trim();
    if (!text) return false;
    if (sig.contextMatched) return true;                               // 重复记录/区块上下文已消除跨组歧义
    if (QP_AUTO_GENERIC.includes(text.trim())) return false;           // 裸通用词
    let groupCount = 0;
    const overlap = (L) => L && (text.includes(L) || L.includes(text)) && (L.length >= 3 || L === text);
    for (const g of QP_ARRAY_GROUPS) {
      let hit = false;
      if (g.key === 'languages') {
        const inLang = g.context.some(kw => text.includes(kw)) || hasLangContextNearby(el, g.context);
        if (!inLang) continue;
        hit = Object.values(g.fields).some(overlap);
      } else {
        if (g.context && !g.context.some(kw => text.includes(kw))) continue;
        hit = Object.values(g.fields).some(overlap);
      }
      if (hit) groupCount++;
    }
    return groupCount <= 1;
  }

  async function tryAutoFillQuickField(el) {
    if (!quickFillEnabled || !quickAutoFillEnabled || running || quickFillRunning) return false;
    if (enhancement && collectFields().some(field => findElement(field.selector) === el && enhancement.blocked(field))) return false;
    // 追加模式由用户逐条选择，空文本框也直接打开面板。
    if (quickAppendEnabled && quickAppendInput(el)) return false;
    quickFillRunning = true;
    try {
      if (currentFieldValue(el)) return false;                        // 字段已有内容 → 不覆盖，弹面板手动选

      const profile = await getProfile();
      if (!profile) return false;

      let value = null, matchedLabel = '';

      // ① 单记录字段：本地规则直填（含基本信息/求职意向/紧急联系人/单记录学历）
      if (!isMultiRecordField(el)) {
        const quickType = detectComponentType(el);
        const isChoice = quickType === 'native-radio' || quickType === 'native-checkbox';
        const fd = {
          selector: generateSelector(el),
          componentType: quickType,
          label: isChoice ? getChoiceGroupLabel(el) : getLabelText(el),
          placeholder: getPlaceholder(el),
          name: el.name || el.getAttribute('name') || '',
          id: el.id || '',
          contextText: getContextText(el),
          section: getSectionTitle(el)
        };
        if (quickType === 'native-select') {
          fd.options = Array.from(el.options || []).map(option => option.textContent.trim()).filter(Boolean);
        } else if (quickType === 'custom-dropdown' || quickType === 'custom-interactive') {
          const optionRoot = el.closest && el.closest('[role="combobox"], [class*="select"], [class*="dropdown"], [class*="combobox"]');
          let options = collectDropdownOptions(optionRoot || el);
          // 搜索式下拉常把选项渲染到 body 门户节点，而不是字段容器内部。
          if (options.length < 2) {
            options = Array.from(document.querySelectorAll('[role="option"], [class*="option"]'))
              .filter(isVisible)
              .map(option => (option.textContent || '').trim())
              .filter(text => text && text.length < 50);
          }
          if (options.length) fd.options = Array.from(new Set(options));
        }
        const lm = matchByLocalRules([fd], profile);
        if (lm.mappings.length === 1) {
          value = lm.mappings[0].value;
          matchedLabel = lm.mappings[0].label;
        }
      }

      // ② 多记录字段 / 单记录未命中：推荐值（按记录序号），仅当标签无跨组歧义
      if (value == null) {
        const sig = quickBestSignature(el);
        if (sig && quickAutoConfident(el, sig)) {
          const index = quickRecordIndex(el, sig.label);
          const reco = quickRecommend(profile, sig, index);
          if (reco && reco.value) {
            value = reco.value;
            matchedLabel = sig.label;
          }
        }
      }

      if (value == null || String(value).trim() === '') return false;

      // ③ 填入（复用 quickPick 的填充路径）
      const componentType = detectComponentType(el);
      let fillEl = el;
      if (componentType === 'wrapper-input') {
        const inner = el.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea');
        if (inner) fillEl = inner;
      }
      const selectorForFill = generateSelector(fillEl) || generateSelector(el);
      let filled = await fillByType(fillEl, value, componentType, selectorForFill);
      if (!filled) filled = await confirmQuickFillResult(fillEl, value, componentType, selectorForFill);
      if (!filled) return false;
      const liveEl = resolveQuickFillElement(fillEl, selectorForFill) || fillEl;
      highlightField(liveEl);
      showAutoFillTip(liveEl, matchedLabel || '已填入');
      return true;
    } catch (err) {
      console.warn('[简历填充] 点击自动匹配失败:', err);
      return false;
    } finally {
      quickFillRunning = false;
    }
  }

  // 自动填入后的简短角标提示（1.2s 淡出，不阻塞）
  let qpTip = null;
  let qpTipLastElement = null;
  let qpTipLastLabel = '';
  let qpTipLastAt = 0;
  function showQuickFillTip(el, text, tone) {
    try {
      const now = Date.now();
      const tipKey = String(tone || 'success') + ':' + String(text || '');
      if (qpTipLastElement === el && qpTipLastLabel === tipKey && now - qpTipLastAt < 1500) return;
      qpTipLastElement = el;
      qpTipLastLabel = tipKey;
      qpTipLastAt = now;
      if (!qpTip) {
        qpTip = document.createElement('div');
        qpTip.id = 'resume-autofill-qp-tip';
        qpTip.style.cssText = 'position:fixed;z-index:2147483647;color:#fff;font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:4px 10px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.18);pointer-events:none;opacity:0;transition:opacity .25s;';
        document.body.appendChild(qpTip);
      }
      const r = el.getBoundingClientRect();
      qpTip.style.background = tone === 'error' ? 'rgba(220,38,38,.95)' : 'rgba(51,112,255,.94)';
      qpTip.textContent = text;
      qpTip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 150)) + 'px';
      qpTip.style.top = Math.max(4, r.top - 32) + 'px';
      qpTip.style.opacity = '1';
      clearTimeout(qpTip._t);
      qpTip._t = setTimeout(() => { qpTip.style.opacity = '0'; }, 1200);
    } catch (e) { /* 提示失败不影响填充 */ }
  }

  function showAutoFillTip(el, label) {
    showQuickFillTip(el, `已自动填入：${label}`, 'success');
  }

  function showQuickFillFailureTip(el, message) {
    showQuickFillTip(el, message || '推荐信息未能写入，请重试', 'error');
  }

  // 下拉控件先让站点处理真实点击、展开选项，再启动推荐匹配；避免推荐逻辑二次点击把菜单关掉。
  function isQuickDropdownControl(el) {
    const type = detectComponentType(el);
    return type === 'native-select' || type === 'custom-dropdown' || type === 'custom-interactive';
  }

  function initQuickFill() {
    if (window.__resumeAutofillQuickInit) return;
    window.__resumeAutofillQuickInit = true;

    // 捕获阶段监听点击：面板外点击 → 先尝试自动匹配直填，未命中/已有值时兜底弹出选择面板；
    // 面板内点击（composedPath 含 host）→ 由面板自身处理，不关闭不重弹
    document.addEventListener('click', (e) => {
      // 整页填充和点击推荐必须互斥；日期/下拉内部会产生合成 click，不能递归触发推荐。
      if (!quickFillEnabled || !e.isTrusted || running || quickFillRunning) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.some(n => n && n.id === 'resume-autofill-qp')) return;
      const el = resolveQuickField(e.target);
      const runQuickRecommendation = () => {
        tryAutoFillQuickField(el).then(filled => {
          if (!filled) showQuickPanel(el);
        });
      };
      if (el && isQuickDropdownControl(el)) {
        closeQuickPanel();
        // 捕获阶段之后，给页面自己的 click/状态更新留出一帧，再读取已展开的真实选项。
        setTimeout(runQuickRecommendation, 40);
        return;
      }
      if (qp && qp.minimized) {
        // 收起态：点击可填字段 → 先自动匹配，否则展开新面板（mini 随之隐藏）
        if (el) {
          qp.minimized = false;
          closeQuickPanel();
          runQuickRecommendation();
        }
        return;
      }
      closeQuickPanel();
      if (el) runQuickRecommendation();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!qp || !qp.open) return;
      if (qp.minimized) return;              // 收起态：Esc 不关闭小图标
      if (e.key === 'Escape') { closeQuickPanel(); return; }
      // 键盘上下选择 + 回车填充：仅在面板搜索框聚焦时启用，避免干扰页面输入框
      if (e.target === qp.search) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveQuickActive(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const active = qp.list.querySelector('.qp-item.active');
          if (active) quickPick(active.dataset.value);
        }
      }
    }, true);

    // 滚动/缩放时关闭（跟随定位复杂，直接关闭更稳妥）；收起态不关闭
    window.addEventListener('scroll', (e) => {
      if (qp && (qp.minimized || (e.composedPath && e.composedPath().includes(qp.host)))) return;
      closeQuickPanel();
    }, { capture: true, passive: true });
    window.addEventListener('resize', () => { if (qp && qp.minimized) return; closeQuickPanel(); });
  }

  function moveQuickActive(delta) {
    // 折叠/展开模式下，只在上/下方向导航当前可见的条目（隐藏的组内条目不参与）
    const all = qp.list.querySelectorAll('.qp-item');
    const items = Array.prototype.filter.call(all, it => it.offsetParent !== null);
    if (!items.length) return;
    let idx = items.indexOf(qp.list.querySelector('.qp-item.active'));
    if (idx < 0) idx = 0;
    idx = (idx + delta + items.length) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
    // 仅在面板列表内滚动，避免带动页面滚动条
    const list = qp.list;
    if (items[idx].offsetTop < list.scrollTop) list.scrollTop = items[idx].offsetTop;
    else if (items[idx].offsetTop + items[idx].offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = items[idx].offsetTop + items[idx].offsetHeight - list.clientHeight;
    }
  }

  // ===== 按需显示：检测 + SPA 复查 =====
  function debounce(fn, delay) {
    let timer = null;
    const wrapped = () => {
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
  }

  let observer = null;
  let debouncedCheck = null;
  let lastActionUrl = typeof location !== 'undefined' ? location.href : '';

  function floatingActionFlags(resumePage, metadata) {
    return {
      showAutofill: !!resumePage,
      showRecord: !!(metadata && metadata.applicationDetailsDetected)
    };
  }

  function refreshFloatingActions() {
    const isTopFrame = window.top === window;
    // 小窗口（广告iframe/小部件）跳过；但正常大小的表单 iframe 仍需初始化 quickFill 监听，
    // 否则 iframe 内点击输入框不会弹出推荐面板（如中信银行简历表单在 myFram 中）。
    if (window.innerWidth < 200 || window.innerHeight < 200) return false;
    enhancement?.routeChanged();
    const metadata = getJobPageMetadata();
    const resumePage = isResumePage();
    const manualAllowed = quickFillManualEnabled && !isAccountAccessPage() && !isConversationPage();
    if (quickFillManualEnabled && !manualAllowed) quickFillManualEnabled = false;
    const { showAutofill, showRecord } = floatingActionFlags(resumePage || manualAllowed, metadata);
    quickFillEnabled = showAutofill;

    if (showAutofill) {
      if (isTopFrame) createFloatingButton();  // 浮动按钮只在顶层窗口显示，避免 iframe 内重复
      initQuickFill();                         // quickFill 监听在所有 frame 都初始化
    } else {
      if (isTopFrame) {
        const button = document.getElementById('resume-autofill-btn');
        if (button) button.remove();
        if (qp && qp.open) closeQuickPanel();
      }
    }

    if (isTopFrame && showRecord) createRecordCurrentButton();
    else if (isTopFrame) {
      const button = document.getElementById('resume-record-current-btn');
      if (button) button.remove();
    }

    const dock = document.getElementById('resume-autofill-actions');
    if (dock && !dock.querySelector('.resume-autofill-action')) dock.remove();
    lastActionUrl = location.href;
    return showAutofill || showRecord;
  }

  function mutationsMayAffectActions(mutations) {
    if (location.href !== lastActionUrl) return true;
    return mutations.some(mutation => {
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
      return nodes.some(node => {
        if (!node || node.nodeType !== 1) return false;
        if (node.id === 'resume-autofill-actions' || node.closest && node.closest('#resume-autofill-actions')) return false;
        if (node.matches && node.matches('form, input, textarea, select, table, tr, [role="row"], [role="grid"]')) return true;
        if (node.querySelector && node.querySelector('form, input, textarea, select, table, tr, [role="row"], [role="grid"]')) return true;
        const text = String(node.textContent || '').replace(/\s+/g, ' ').slice(0, 500);
        return /(?:第\s*\d+\s*志愿|投递岗位|申请职位|我的志愿|投递记录|修改申请|职位进展|投递成功|已完成的投递)/.test(text) ||
          APPLICATION_DATED_DELIVERY_RE.test(text) || (/投递/.test(text) && metadataElements(node).some(element =>
            APPLICATION_DATED_DELIVERY_RE.test(compactMetadataText(element.textContent, 100))
          ));
      });
    });
  }

  function onMutations(mutations) {
    if (mutationsMayAffectActions(mutations)) debouncedCheck();
  }

  function onRouteChange() {
    debouncedCheck.cancel();
    refreshFloatingActions();
  }

  function armObserver() {
    if (observer) return;
    debouncedCheck = debounce(refreshFloatingActions, 900);
    observer = new MutationObserver(onMutations);
    // 只监听结构变化，并先检查新增/删除节点是否与表单或志愿记录相关，避免高频全页扫描。
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
  }

  // ===== 当前职位页面信息（供“记录当前职位”预填） =====
  function compactMetadataText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > (maxLength || 180)) return '';
    return text;
  }

  function firstMetadataText(selectors, maxLength) {
    for (const selector of selectors) {
      let elements = [];
      try { elements = document.querySelectorAll(selector); } catch (e) { continue; }
      for (const element of elements) {
        const text = compactMetadataText(element.textContent || element.getAttribute('content'), maxLength);
        if (text) return text;
      }
    }
    return '';
  }

  function getBootstrapSelectContainer(el) {
    if (!el || !el.querySelector) return null;
    if (el.matches && el.matches('.bootstrap-select, [class*="bootstrap-select"]')) return el;
    const closest = el.closest && el.closest('.bootstrap-select, [class*="bootstrap-select"]');
    if (closest) return closest;
    const nested = el.querySelector('.bootstrap-select, [class*="bootstrap-select"]');
    if (nested) return nested;
    // 扫描器有时定位到 bootstrap-select 内部无特征的 dy-form 包装层。
    const native = el.querySelector('select.selectpicker');
    return native && native.parentElement ? native.parentElement : null;
  }

  function getBootstrapNativeSelect(el) {
    const container = getBootstrapSelectContainer(el);
    return container ? container.querySelector('select.selectpicker, select') : null;
  }

  const METADATA_TEXT_SELECTOR = 'h1, h2, h3, h4, p, span, div, a, li, td, th, strong, [role="cell"], [role="gridcell"], [role="columnheader"]';
  const COMPANY_FULL_SUFFIX_RE = /(?:有限责任公司|股份有限公司|集团有限公司|有限公司)$/;
  const COMPANY_OTHER_SUFFIX_RE = /(?:集团|总公司|分公司|公司|银行|证券|保险|研究院|研究所)$/;
  const JOB_TITLE_SIGNAL_RE = /(?:工程师|开发|研发|算法|产品|运营|测试|设计|分析师|顾问|经理|专员|助理|实习生|技术|研究员|科学家|架构师|管培生|岗位|职位|岗)/;
  const APPLICATION_SUCCESS_RE = /^(?:投递成功|已投递|申请成功|报名成功|投递完成|申请已提交|已申请)$/;
  const APPLICATION_PROGRESS_RE = /(?:投递成功|已投递|申请成功|报名成功|投递完成|申请已提交|已申请|筛选中|处理中|笔试|测评|考试|面试|offer|录用|终止|淘汰|未通过|拒绝|撤回|放弃)/i;
  const APPLICATION_PROGRESS_MARKER_RE = /^(?:投递成功|已投递|申请成功|报名成功|投递完成|申请已提交|已申请|筛选中|处理中|笔试中|测评中|考试中|面试中|终试中|已签约|签约完成|已录用|录用|未通过|已撤回)$/i;
  // 北森投递记录卡片只有“2026-09-07 19:53 投递”，不一定另有“投递成功”状态。
  const APPLICATION_DATED_DELIVERY_RE = /^(?:(?:校园|社会|实习生|实习|应届生)招聘\s*[|｜]?\s*)?20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*投递$/;
  const APPLICATION_STAGE_LABEL_RE = /^(?:投递成功|综合测评|岗位笔试|专业面试|综合面试|终试洽谈|签约|简历筛选|在线测评|笔试|初试|复试|终面|录用)$/i;
  const FIRST_PREFERENCE_RE = /^第\s*1\s*志愿$/;
  const PREFERENCE_RE = /第\s*(\d+)\s*志愿/;
  const APPLICATION_SECTION_HEADING_RE = /^(?:我的志愿|投递记录|我的申请|我的职位申请|申请记录|已完成的投递)(?:\s*[（(]\s*\d+\s*[)）])?$/;
  const OTHER_PERSONAL_SECTION_HEADING_RE = /^(?:我的简历|我的收藏)(?:\s*[（(]\s*\d+\s*[)）])?$/;
  const APPLICATION_COLUMN_ALIASES = {
    companyName: /^(?:总公司|总公司名称|招聘公司|公司名称|招聘集团)$/,
    jobTitle: /^(?:投递岗位|应聘岗位|申请岗位|申请职位|应聘职位|职位名称|岗位名称|招聘职位|投递职位|职位|岗位)$/,
    location: /^(?:工作地点|工作城市|职位地点|岗位地点|应聘地点|工作地|地点|城市)$/,
    appliedAt: /^(?:投递时间|申请时间|报名时间|投递日期|申请日期|创建时间|日期)$/,
    status: /^(?:职位进展|投递进展|申请进展|投递状态|申请状态|当前状态|状态|进展)$/,
    organizationUnit: /^(?:招聘单位|应聘单位|用人单位|所属单位|投递单位|招聘分公司|分公司|分公司名称|招聘机构|所属机构|分支机构|分行|支行|招聘部门|用人部门|所属部门|部门|单位)$/,
    preferenceLabel: /^(?:志愿顺序|志愿序号|志愿|优先级)$/
  };

  function metadataElements(root) {
    try { return Array.from((root || document).querySelectorAll(METADATA_TEXT_SELECTOR)); }
    catch (e) { return []; }
  }

  function scopedQueryAll(root, selector) {
    const scope = root || document;
    let elements = [];
    try { elements = Array.from(scope.querySelectorAll(selector)); } catch (e) { return []; }
    if (scope !== document && scope.matches) {
      try { if (scope.matches(selector)) elements.unshift(scope); } catch (e) { /* ignore */ }
    }
    return Array.from(new Set(elements));
  }

  function applicationSectionHeadings() {
    return metadataElements(document).filter(element =>
      APPLICATION_SECTION_HEADING_RE.test(compactMetadataText(element.textContent, 60))
    );
  }

  function applicationSectionHasEvidence(container) {
    if (scopedQueryAll(container, 'table, [role="table"], [role="grid"]').length) return true;
    return metadataElements(container).some(element =>
      /^第\s*\d+\s*志愿$/.test(compactMetadataText(element.textContent, 40)) ||
      APPLICATION_PROGRESS_MARKER_RE.test(compactMetadataText(element.textContent, 40)) ||
      APPLICATION_DATED_DELIVERY_RE.test(compactMetadataText(element.textContent, 100))
    );
  }

  function applicationSectionScopeFromDom(headings) {
    const candidates = Array.isArray(headings) ? headings : applicationSectionHeadings();
    for (const heading of candidates) {
      let container = heading;
      for (let depth = 0; container && depth < 8; depth++, container = container.parentElement) {
        if (!applicationSectionHasEvidence(container)) continue;
        const crossesAnotherSection = metadataElements(container).some(element =>
          element !== heading && OTHER_PERSONAL_SECTION_HEADING_RE.test(
            compactMetadataText(element.textContent, 60)
          )
        );
        if (!crossesAnotherSection) return container;
      }
    }
    return null;
  }

  function metadataTextCandidates(element, maxLength) {
    if (!element) return [];
    const values = [];
    ['title', 'aria-label', 'alt', 'data-original-title', 'data-title', 'data-tooltip'].forEach(attribute => {
      let value = '';
      try { value = element.getAttribute && element.getAttribute(attribute); } catch (e) { /* ignore */ }
      const text = compactMetadataText(value, maxLength || 240);
      if (text) values.push({ text, attribute: true });
    });
    const visible = compactMetadataText(element.textContent, maxLength || 240);
    if (visible) values.push({ text: visible, attribute: false });
    return values.filter((item, index, all) =>
      all.findIndex(other => other.text === item.text) === index
    );
  }

  function preferredMetadataText(element, maxLength) {
    const candidates = metadataTextCandidates(element, maxLength);
    return candidates.length ? candidates[0].text : '';
  }

  function normalizedApplicationHeader(value) {
    return compactMetadataText(value, 80).replace(/[：:()（）\s_-]+/g, '');
  }

  function applicationHeaderField(value) {
    const header = normalizedApplicationHeader(value);
    for (const [field, matcher] of Object.entries(APPLICATION_COLUMN_ALIASES)) {
      if (matcher.test(header)) return field;
    }
    return '';
  }

  function cleanRecruitmentBrand(value) {
    let text = compactMetadataText(value, 100);
    if (!text) return '';
    const segments = text.split(/\s*[|｜·—–]\s*/).filter(Boolean);
    const recruitmentSegment = segments.find(segment => /招聘/.test(segment));
    if (recruitmentSegment) text = recruitmentSegment;
    text = text
      .replace(/^(?:欢迎来到|欢迎访问)/, '')
      .replace(/(?:校园|社会|人才|全球|应届生|实习生)?招聘(?:官网|网站|平台|门户|系统|首页)?$/g, '')
      .replace(/(?:我的志愿|我的申请|投递记录|申请记录)$/g, '')
      .replace(/^[\s|｜·—–_-]+|[\s|｜·—–_-]+$/g, '')
      .trim();
    if (text.length < 2 || text.length > 50) return '';
    if (/^(?:校园|社会|人才|全球|应届生|实习生|招聘|官网|首页|我的志愿|我的申请)$/.test(text)) return '';
    return text;
  }

  function metadataTop(element) {
    try {
      const top = element.getBoundingClientRect().top;
      return Number.isFinite(top) ? Math.max(0, top) : null;
    } catch (e) {
      return null;
    }
  }

  function metadataTopScore(element) {
    const top = metadataTop(element);
    return top == null ? 0 : Math.max(0, 48 - top / 12);
  }

  function companySuffixScore(text) {
    if (COMPANY_FULL_SUFFIX_RE.test(text)) return 150;
    if (/(?:集团|总公司)$/.test(text)) return 125;
    if (/分公司$/.test(text)) return 78;
    if (/(?:银行|证券|保险|公司)$/.test(text)) return 105;
    if (/(?:研究院|研究所)$/.test(text)) return 46;
    return 0;
  }

  function isCompanyNameCandidate(text) {
    return text.length >= 4 && text.length <= 80 &&
      (COMPANY_FULL_SUFFIX_RE.test(text) || COMPANY_OTHER_SUFFIX_RE.test(text)) &&
      !/(?:第\s*\d+\s*志愿|投递成功|已投递|展开|收起)/.test(text);
  }

  function companyNameFromDom() {
    const companyHints = recruitmentCompanyHints();
    const official = companyHints.find(hint => hint.source === 'official-host');
    if (official) return official.name;
    const explicit = [];
    const selectors = [
      '[data-testid*="company" i]', '[class*="company-name" i]', '[class*="company_name" i]',
      '[class*="companyName"]', '[class*="company-title" i]', 'a[href*="/company/"]'
    ];
    for (const selector of selectors) {
      try { explicit.push(...document.querySelectorAll(selector)); } catch (e) { /* ignore */ }
    }
    const explicitSet = new Set(explicit);
    const candidates = Array.from(new Set([...explicit, ...metadataElements(document)]));
    let best = null;

    candidates.forEach(element => {
      const text = compactMetadataText(element.textContent || element.getAttribute && element.getAttribute('content'), 80);
      if (!isCompanyNameCandidate(text)) return;
      const insideApplicationRow = element.closest && element.closest('tr, [role="row"]');
      const score = companySuffixScore(text) + metadataTopScore(element) +
        (explicitSet.has(element) ? 24 : 0) - (insideApplicationRow ? 110 : 0);
      if (!best || score > best.score) best = { text, score };
    });

    const brandCandidates = [];
    const brandSelectors = [
      'header [class*="logo" i]', 'header [class*="brand" i]',
      '[class*="site-title" i]', '[class*="platform-name" i]',
      '[class*="recruit" i] h1', '[class*="recruit" i] h2', 'header h1', 'header h2'
    ];
    for (const selector of brandSelectors) {
      try { brandCandidates.push(...document.querySelectorAll(selector)); } catch (e) { /* ignore */ }
    }
    let brandBest = null;
    brandCandidates.forEach(element => {
      if (element.closest && element.closest('#resume-autofill-actions')) return;
      metadataTextCandidates(element, 100).forEach(candidate => {
        const cleaned = cleanRecruitmentBrand(candidate.text);
        if (!cleaned || APPLICATION_PROGRESS_RE.test(cleaned) || PREFERENCE_RE.test(cleaned)) return;
        const hint = [element.className, element.id].filter(Boolean).join(' ');
        let score = metadataTopScore(element);
        if (/招聘/.test(candidate.text)) score += 80;
        if (/(?:logo|brand|site-title|platform-name)/i.test(hint)) score += 55;
        if (/(?:中国|集团|银行|电信|联通|移动|科技|大学|医院|研究|公司)/.test(cleaned)) score += 30;
        if (!brandBest || score > brandBest.score) brandBest = { text: cleaned, score };
      });
    });

    const titleSegments = String(document.title || '').split(/\s*[|｜·—–-]\s*/).filter(Boolean);
    titleSegments.forEach(segment => {
      const cleaned = cleanRecruitmentBrand(segment);
      if (!cleaned || !/招聘/.test(segment)) return;
      const score = 90 + (/(?:中国|集团|银行|电信|联通|移动|科技|大学|医院|研究|公司)/.test(cleaned) ? 30 : 0);
      if (!brandBest || score > brandBest.score) brandBest = { text: cleaned, score };
    });
    if (best && (!brandBest || best.score >= brandBest.score)) return best.text;
    return brandBest ? brandBest.text : (companyHints[0] || {}).name || '';
  }

  function recruitmentCompanyHints() {
    const hints = [];
    const add = (value, source) => {
      const name = cleanRecruitmentBrand(value);
      if (!name || !isCompanyNameCandidate(name) || /(?:分公司|总行|分行|支行|中心)$/.test(name)) return;
      if (!hints.some(hint => hint.name === name)) hints.push({ name, source });
    };
    // 仅匹配已确认的官方招聘域名，避免把招聘平台或相似域名当作雇主。
    const officialEmployers = { 'career.cmbc.com.cn': '中国民生银行' };
    try { add(officialEmployers[new URL(location.href).hostname], 'official-host'); } catch (e) { /* ignore */ }
    for (const meta of document.querySelectorAll('meta[property="og:site_name"], meta[name="application-name"]')) {
      add(meta.getAttribute('content'), 'site-meta');
    }
    for (const image of document.querySelectorAll('img[alt], img[title], [role="img"][aria-label]')) {
      if (image.closest && image.closest('tr, [role="row"], #resume-autofill-actions')) continue;
      if (image.closest && !image.closest('header, [role="banner"], [class*="logo" i], [id*="logo" i], [class*="brand" i]')) continue;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(image) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
      add(image.getAttribute('alt') || image.getAttribute('aria-label') || image.getAttribute('title'), 'brand-label');
    }
    return hints.slice(0, 8);
  }

  function isJobTitleCandidate(text, contextual) {
    if (text.length < 2 || text.length > 160) return false;
    if (APPLICATION_SUCCESS_RE.test(text) || FIRST_PREFERENCE_RE.test(text)) return false;
    if (APPLICATION_STAGE_LABEL_RE.test(text) || APPLICATION_PROGRESS_MARKER_RE.test(text)) return false;
    if (/^第\s*\d+\s*志愿$|^(?:展开|收起|查看详情|修改志愿顺序|修改申请|撤回)$/.test(text)) return false;
    if (/^项目\s*[：:]\s*[-—－]?$/i.test(text) || /^\d{1,2}:\d{2}$/.test(text)) return false;
    if (applicationHeaderField(text) || /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(text)) return false;
    if (!contextual && (isCompanyNameCandidate(text) || /(?:研究院|研究所|事业部|部门|中心)$/.test(text))) return false;
    return true;
  }

  function cleanJobTitleText(value, contextual) {
    let text = compactMetadataText(value, 240);
    if (!text) return '';
    text = text
      .replace(/第\s*\d+\s*志愿/g, ' ')
      .replace(/(?:投递成功|已投递|申请成功|报名成功|投递完成|申请已提交|已申请)/gi, ' ')
      .replace(/(?:修改志愿顺序|查看详情|展开|收起|撤回)$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return isJobTitleCandidate(text, contextual) ? text : '';
  }

  function jobTitleScore(element, text, explicit, contextual) {
    let score = explicit ? 45 : 0;
    if (contextual) score += 55;
    if (JOB_TITLE_SIGNAL_RE.test(text)) score += 90;
    if (/^[\u4e00-\u9fffA-Za-z0-9+#.·（）()\-\s]+$/.test(text)) score += 8;
    const hint = [
      element && element.className,
      element && element.id,
      element && element.getAttribute && element.getAttribute('data-testid')
    ].filter(Boolean).join(' ');
    if (/(?:job|position|post|岗位|职位|role|name)/i.test(hint)) score += 35;
    return score + metadataTopScore(element) * 0.15;
  }

  function bestJobTitleWithin(root, contextual) {
    const candidates = Array.from(new Set([root, ...metadataElements(root)].filter(Boolean)));
    let best = null;
    candidates.forEach(element => {
      metadataTextCandidates(element, 240).forEach(candidate => {
        const text = cleanJobTitleText(candidate.text, contextual);
        if (!text) return;
        let score = jobTitleScore(element, text, false, contextual);
        if (candidate.attribute) score += 48;
        if (contextual && JOB_TITLE_SIGNAL_RE.test(text) &&
            /(?:有限责任公司|股份有限公司|集团有限公司|有限公司|分公司|研究院|研究所|事业部|部门)\s*$/.test(text)) {
          score -= 100;
        }
        if (!best || score > best.score || (score === best.score && text.length > best.text.length)) {
          best = { text, score };
        }
      });
    });
    return best && best.score >= (contextual ? 45 : 90) ? best.text : '';
  }

  function jobTitleNearMarker(markerElement) {
    let container = markerElement && markerElement.parentElement;
    for (let depth = 0; container && depth < 7; depth++, container = container.parentElement) {
      const containerText = compactMetadataText(container.textContent, 500);
      if (!containerText) continue;
      const title = bestJobTitleWithin(container, false);
      if (title) return title;
    }
    return '';
  }

  function elementWithinApplicationScope(element, scope) {
    if (!scope || scope === document) return true;
    let current = element;
    while (current) {
      if (current === scope) return true;
      current = current.parentElement;
    }
    return false;
  }

  function applicationRowFromMarker(markerElement, scope) {
    if (markerElement && markerElement.closest) {
      const semanticRow = markerElement.closest('tr, [role="row"]');
      if (semanticRow && elementWithinApplicationScope(semanticRow, scope)) {
        const markerCell = markerElement.closest('td, [role="cell"], [role="gridcell"]');
        const jobTitle = bestJobTitleWithin(markerCell || semanticRow, true);
        if (jobTitle) return { container: semanticRow, jobTitle };
      }
    }
    let container = markerElement && markerElement.parentElement;
    for (let depth = 0; container && depth < 7; depth++, container = container.parentElement) {
      if (!elementWithinApplicationScope(container, scope)) break;
      const containerText = compactMetadataText(container.textContent, 500);
      if (!containerText) continue;
      const markerCount = metadataElements(container).filter(element =>
        /^第\s*\d+\s*志愿$/.test(compactMetadataText(element.textContent, 40))
      ).length;
      if (markerCount > 1) continue;
      const jobTitle = bestJobTitleWithin(container, true);
      if (jobTitle) return { container, jobTitle };
    }
    return null;
  }

  function applicationUnitWithin(container, jobTitle) {
    let best = '';
    metadataElements(container).forEach(element => {
      const text = compactMetadataText(element.textContent, 100);
      if (!text || text === jobTitle || APPLICATION_SUCCESS_RE.test(text)) return;
      if (/^第\s*\d+\s*志愿$|^(?:展开|收起|查看详情)$/.test(text)) return;
      if (!(isCompanyNameCandidate(text) || /(?:研究院|研究所|事业部|部门|中心)$/.test(text))) return;
      if (!best || companySuffixScore(text) > companySuffixScore(best)) best = text;
    });
    return best;
  }

  function dateOnlyFromApplicationText(value) {
    const match = String(value || '').match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (!match) return '';
    return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  }

  function applicationStatusFromText(value) {
    const text = compactMetadataText(value, 120);
    if (!text) return '';
    if (/(?:offer|录用|已录取)/i.test(text)) return 'offer';
    if (/面试/.test(text)) return '面试中';
    if (/(?:测评|评测|assessment|evaluation)/i.test(text)) return '已测评';
    if (/(?:笔试|考试)/.test(text)) return '已笔试';
    if (/(?:终止|淘汰|未通过|拒绝|撤回|放弃|关闭)/.test(text)) return '终止';
    if (/(?:投递|申请|报名|已提交|筛选中|处理中)/.test(text)) return '已投递';
    return '';
  }

  function preferenceFromText(value) {
    const match = PREFERENCE_RE.exec(String(value || ''));
    if (!match) return { preferenceOrder: null, preferenceLabel: '' };
    const preferenceOrder = Number(match[1]);
    return { preferenceOrder, preferenceLabel: `第${preferenceOrder}志愿` };
  }

  function directRowCells(row) {
    if (!row || !row.querySelectorAll) return [];
    let candidates = [];
    try { candidates = Array.from(row.querySelectorAll('th, td, [role="columnheader"], [role="cell"], [role="gridcell"]')); }
    catch (e) { return []; }
    return candidates.filter(cell => {
      if (!cell.closest) return true;
      return cell.closest('tr, [role="row"]') === row;
    });
  }

  function applicationHeaderMap(cells) {
    const map = {};
    const headers = cells.map(cell => normalizedApplicationHeader(preferredMetadataText(cell, 100)));
    const branchIndex = headers.findIndex(header => /^(?:招聘分公司|分公司|分公司名称|分支机构|分行|支行)$/.test(header));
    cells.forEach((cell, index) => {
      const field = branchIndex >= 0 && headers[index] === '招聘单位'
        ? 'companyName' : applicationHeaderField(preferredMetadataText(cell, 100));
      if (field && map[field] == null) map[field] = index;
    });
    if (branchIndex >= 0) map.organizationUnit = branchIndex;
    return map;
  }

  function mappedCellText(cells, map, field, maxLength) {
    const index = map[field];
    return Number.isInteger(index) && cells[index]
      ? preferredMetadataText(cells[index], maxLength || 240)
      : '';
  }

  function applicationFromStructuredRow(row, cells, map) {
    const jobCell = cells[map.jobTitle];
    if (!jobCell) return null;
    const jobTitle = bestJobTitleWithin(jobCell, true);
    if (!jobTitle || applicationHeaderField(jobTitle)) return null;
    const rowText = preferredMetadataText(row, 1200) || cells.map(cell => preferredMetadataText(cell, 240)).join(' ');
    const preferenceText = mappedCellText(cells, map, 'preferenceLabel', 100) || rowText;
    const preference = preferenceFromText(preferenceText);
    const statusText = mappedCellText(cells, map, 'status', 160) || rowText;
    return {
      ...preference,
      jobTitle,
      companyName: mappedCellText(cells, map, 'companyName', 120),
      organizationUnit: mappedCellText(cells, map, 'organizationUnit', 180),
      location: mappedCellText(cells, map, 'location', 160),
      appliedAt: dateOnlyFromApplicationText(mappedCellText(cells, map, 'appliedAt', 180)),
      status: applicationStatusFromText(statusText),
      successful: APPLICATION_SUCCESS_RE.test(compactMetadataText(statusText, 80)) || /投递成功|申请成功|报名成功/.test(statusText)
    };
  }

  function applicationContainerRelationDistance(first, second) {
    if (!first || !second) return Infinity;
    const ancestors = new Map();
    let current = first;
    for (let depth = 0; current && depth <= 6; depth++, current = current.parentElement) {
      ancestors.set(current, depth);
    }
    current = second;
    for (let depth = 0; current && depth <= 6; depth++, current = current.parentElement) {
      if (ancestors.has(current)) return ancestors.get(current) + depth;
    }
    return Infinity;
  }

  function compatibleApplicationHeader(details, detail, cellCount) {
    const candidates = details.filter(candidate => {
      if (!candidate.headerMap || !candidate.headerCellCount) return false;
      if (Math.abs(candidate.headerCellCount - cellCount) > 1) return false;
      const relationDistance = applicationContainerRelationDistance(detail.container, candidate.container);
      const indexDistance = Math.abs(detail.index - candidate.index);
      return Number.isFinite(relationDistance) || indexDistance <= 1;
    });
    candidates.sort((a, b) => {
      const score = candidate => {
        const relation = applicationContainerRelationDistance(detail.container, candidate.container);
        const indexDistance = Math.abs(detail.index - candidate.index);
        const cellPenalty = Math.abs(candidate.headerCellCount - cellCount) * 20;
        const followingPenalty = candidate.index > detail.index ? 3 : 0;
        return (Number.isFinite(relation) ? relation : 20) + indexDistance * 4 + cellPenalty + followingPenalty;
      };
      return score(a) - score(b);
    });
    return candidates[0] || null;
  }

  function structuredApplicationRowsFromDom(root) {
    let scope = root;
    if (!scope) {
      const headings = applicationSectionHeadings();
      scope = applicationSectionScopeFromDom(headings);
      if (headings.length && !scope) return [];
      scope = scope || document;
    }
    const containers = scopedQueryAll(scope, 'table, [role="table"], [role="grid"]');
    const applications = [];
    const seenRows = new Set();

    const details = containers.map((container, index) => {
      let rows = [];
      try { rows = Array.from(container.querySelectorAll('tr, [role="row"]')); } catch (e) { /* ignore */ }
      let headerIndex = -1;
      let headerMap = null;
      let headerCellCount = 0;
      rows.some((row, index) => {
        const cells = directRowCells(row);
        const map = applicationHeaderMap(cells);
        if (Number.isInteger(map.jobTitle)) {
          headerIndex = index;
          headerMap = map;
          headerCellCount = cells.length;
          return true;
        }
        return false;
      });
      return { container, index, rows, headerIndex, headerMap, headerCellCount };
    });

    details.forEach(detail => {
      const firstDataCells = detail.rows
        .map(row => directRowCells(row))
        .find(cells => cells.length > 0 && !Number.isInteger(applicationHeaderMap(cells).jobTitle));
      const externalHeader = !detail.headerMap && firstDataCells
        ? compatibleApplicationHeader(details, detail, firstDataCells.length)
        : null;
      const headerMap = detail.headerMap || externalHeader && externalHeader.headerMap;
      if (!headerMap) return;
      const rows = detail.headerMap ? detail.rows.slice(detail.headerIndex + 1) : detail.rows;
      rows.forEach(row => {
        if (seenRows.has(row)) return;
        const cells = directRowCells(row);
        if (Number.isInteger(applicationHeaderMap(cells).jobTitle)) return;
        const application = applicationFromStructuredRow(row, cells, headerMap);
        if (!application) return;
        seenRows.add(row);
        applications.push(application);
      });
    });
    return applications;
  }

  function fallbackApplicationLocation(container) {
    const selectors = [
      '[class*="location" i]', '[class*="address" i]', '[class*="city" i]',
      '[data-testid*="location" i]'
    ];
    for (const selector of selectors) {
      try {
        const element = container.querySelector(selector);
        const text = preferredMetadataText(element, 160);
        if (text) return text;
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function bestProgressCardJobTitleWithin(container, requireTitleEvidence) {
    let best = null;
    metadataElements(container).forEach(element => {
      metadataTextCandidates(element, 240).forEach(candidate => {
        const text = cleanJobTitleText(candidate.text, true);
        if (!text || APPLICATION_STAGE_LABEL_RE.test(text) || APPLICATION_PROGRESS_MARKER_RE.test(text)) return;
        if (/(?:修改申请|修改志愿顺序|查看详情|撤回|投递成功|综合测评|岗位笔试|专业面试|综合面试|终试洽谈|签约)/.test(text)) return;
        let score = jobTitleScore(element, text, false, true);
        const tagName = String(element.tagName || '').toUpperCase();
        const hint = [element.className, element.id].filter(Boolean).join(' ');
        if (requireTitleEvidence) {
          if (/(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|投递|测评|查看\s*[\/／]\s*打印)/.test(text) ||
              /^(?:校园招聘|社会招聘|实习生招聘|编辑|查看|打印|暂无记录|没有更多了[~～]?)$/.test(text)) return;
          if (!JOB_TITLE_SIGNAL_RE.test(text) && !/^H[1-4]$/.test(tagName) &&
              !/(?:job|position|post|岗位|职位|role|name|title)/i.test(hint)) return;
        }
        if (/^H[1-4]$/.test(tagName)) score += 65;
        if (/(?:job|position|post|岗位|职位|role|name|title)/i.test(hint)) score += 55;
        if (candidate.attribute) score += 42;
        if (element.children && element.children.length) score -= 55;
        if (text.length > 80) score -= 70;
        if (!best || score > best.score || (score === best.score && text.length < best.text.length)) {
          best = { text, score };
        }
      });
    });
    return best && best.score >= 45 ? best.text : '';
  }

  function applicationProgressCardFromMarker(markerElement, scope, markers) {
    const markerText = compactMetadataText(markerElement.textContent, 100);
    const datedDelivery = APPLICATION_DATED_DELIVERY_RE.test(markerText);
    let container = markerElement && markerElement.parentElement;
    for (let depth = 0; container && depth < 8; depth++, container = container.parentElement) {
      if (!elementWithinApplicationScope(container, scope)) break;
      // 未找到标题时，不能跨到另一张卡片借用它的职位名称。
      if (datedDelivery && (markers || []).some(other => other !== markerElement &&
          APPLICATION_DATED_DELIVERY_RE.test(compactMetadataText(other.textContent, 100)) &&
          elementWithinApplicationScope(other, container))) break;
      const jobTitle = bestProgressCardJobTitleWithin(container, datedDelivery);
      if (!jobTitle) continue;
      const cardText = preferredMetadataText(container, 1600);
      const preference = preferenceFromText(cardText);
      return {
        container,
        application: {
          ...preference,
          jobTitle,
          organizationUnit: applicationUnitWithin(container, jobTitle),
          location: fallbackApplicationLocation(container),
          appliedAt: dateOnlyFromApplicationText(datedDelivery ? markerText : cardText),
          status: datedDelivery ? '已投递' : applicationStatusFromText(markerText || cardText),
          successful: datedDelivery || APPLICATION_SUCCESS_RE.test(markerText) || /投递成功|申请成功|报名成功/.test(markerText)
        }
      };
    }
    return null;
  }

  // “投递记录”类页面常用卡片和进度轴展示申请，没有表格或“第 N 志愿”标记。
  // 仅在明确存在投递页标题时，以状态节点为锚点向上寻找同一卡片中的岗位名称。
  function progressApplicationRowsFromDom(root, headings) {
    if (!Array.isArray(headings) || headings.length === 0) return [];
    const scanRoot = root || document;
    const isMarker = element => {
      const text = compactMetadataText(element.textContent, 100);
      return APPLICATION_PROGRESS_MARKER_RE.test(text) || APPLICATION_DATED_DELIVERY_RE.test(text);
    };
    // 包装层和内部 span 可能包含相同文字，只保留最内层标记。
    const markers = metadataElements(scanRoot).filter(element =>
      isMarker(element) && !metadataElements(element).some(isMarker)
    );
    const applications = [];
    const seenContainers = new Set();
    const seenIdentities = new Set();
    markers.forEach(marker => {
      const result = applicationProgressCardFromMarker(marker, scanRoot, markers);
      if (!result || seenContainers.has(result.container)) return;
      const identity = [result.application.preferenceLabel, result.application.jobTitle]
        .map(value => String(value || '').trim().toLowerCase()).join('|');
      if (seenIdentities.has(identity)) return;
      seenContainers.add(result.container);
      seenIdentities.add(identity);
      applications.push(result.application);
    });
    return applications;
  }

  function applicationRowsFromDom() {
    const headings = applicationSectionHeadings();
    const scope = applicationSectionScopeFromDom(headings);
    const scanRoot = scope || document;
    const canScanGenericRows = headings.length === 0 || !!scope;
    const structured = canScanGenericRows ? structuredApplicationRowsFromDom(scanRoot) : [];
    const progressCards = structured.length ? [] : progressApplicationRowsFromDom(scanRoot, headings);
    if (!canScanGenericRows && progressCards.length === 0) return [];
    const markers = metadataElements(scanRoot)
      .map(element => ({
        element,
        text: compactMetadataText(element.textContent, 40),
        match: /^第\s*(\d+)\s*志愿$/.exec(compactMetadataText(element.textContent, 40))
      }))
      .filter(item => item.match && canScanGenericRows)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
    const applications = structured.concat(progressCards);
    const seenPreferences = new Set(structured
      .map(item => item.preferenceOrder)
      .filter(Number.isFinite));

    markers.forEach(item => {
      const preferenceOrder = Number(item.match[1]);
      const row = applicationRowFromMarker(item.element, scanRoot);
      if (!row || seenPreferences.has(preferenceOrder)) return;
      seenPreferences.add(preferenceOrder);
      const rowText = preferredMetadataText(row.container, 1200);
      applications.push({
        preferenceOrder,
        preferenceLabel: `第${preferenceOrder}志愿`,
        jobTitle: row.jobTitle,
        organizationUnit: applicationUnitWithin(row.container, row.jobTitle),
        location: fallbackApplicationLocation(row.container),
        appliedAt: dateOnlyFromApplicationText(rowText),
        status: applicationStatusFromText(rowText),
        successful: metadataElements(row.container).some(element =>
          APPLICATION_SUCCESS_RE.test(compactMetadataText(element.textContent, 40))
        )
      });
    });
    const seen = new Set();
    return applications.filter(item => {
      const identity = [item.preferenceLabel, item.jobTitle, item.organizationUnit, item.location]
        .map(value => String(value || '').trim().toLowerCase()).join('|');
      if (!item.jobTitle || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).sort((a, b) => {
      if (Number.isFinite(a.preferenceOrder) && Number.isFinite(b.preferenceOrder)) {
        return a.preferenceOrder - b.preferenceOrder;
      }
      if (Number.isFinite(a.preferenceOrder)) return -1;
      if (Number.isFinite(b.preferenceOrder)) return 1;
      return 0;
    });
  }

  function jobTitleFromApplicationRows() {
    const applications = applicationRowsFromDom();
    const successful = applications.find(item => item.successful);
    return successful && successful.jobTitle || applications[0] && applications[0].jobTitle || '';
  }

  function jobTitleFromDom(applicationRows) {
    const rowTitle = Array.isArray(applicationRows)
      ? ((applicationRows.find(item => item.successful) || applicationRows[0] || {}).jobTitle || '')
      : jobTitleFromApplicationRows();
    if (rowTitle) return rowTitle;

    const selectors = [
      '[data-testid*="job-title" i]', '[class*="job-title" i]', '[class*="job_name" i]',
      '[class*="jobName"]', '[class*="position-title" i]', '[class*="position_name" i]', 'h1', 'h2'
    ];
    const explicit = [];
    for (const selector of selectors) {
      try { explicit.push(...document.querySelectorAll(selector)); } catch (e) { /* ignore */ }
    }
    let best = null;
    Array.from(new Set(explicit)).forEach(element => {
      const text = compactMetadataText(element.textContent, 160);
      if (!isJobTitleCandidate(text)) return;
      const score = jobTitleScore(element, text, true);
      if (!best || score > best.score) best = { text, score };
    });
    return best ? best.text : '';
  }

  function findJobPostingJsonLd(node, depth) {
    if (!node || depth > 6) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findJobPostingJsonLd(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some(type => String(type || '').toLowerCase() === 'jobposting')) return node;
    for (const value of Object.values(node)) {
      const found = findJobPostingJsonLd(value, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function readJobPostingJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const found = findJobPostingJsonLd(JSON.parse(script.textContent || ''), 0);
        if (found) return found;
      } catch (e) { /* 站点可能包含非标准 JSON-LD，继续使用 DOM 兜底 */ }
    }
    return null;
  }

  function jobLocationFromJsonLd(job) {
    const locations = Array.isArray(job && job.jobLocation) ? job.jobLocation : [job && job.jobLocation];
    for (const location of locations) {
      const address = location && location.address || {};
      const text = compactMetadataText([
        address.addressLocality,
        address.addressRegion,
        address.addressCountry && (address.addressCountry.name || address.addressCountry)
      ].filter(Boolean).join(' '), 120);
      if (text) return text;
    }
    return '';
  }

  // 只在用户点击记录时采集正文，避免页面检测和 DOM 观察器重复扫描/发送。
  function getApplicationPageContext() {
    const excluded = 'script, style, noscript, iframe, input, textarea, select, [hidden], [aria-hidden="true"], [contenteditable="true"], [id^="resume-autofill"], [id^="resume-record"], [id^="resume-quick"]';
    function hidden(element) {
      if (element.matches && element.matches(excluded)) return true;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
      return style && (style.display === 'none' || style.visibility === 'hidden');
    }
    function visible(element) {
      for (let parent = element; parent; parent = parent.parentElement) {
        if (hidden(parent)) return false;
      }
      return true;
    }
    function readText(root, limit) {
      let text = '', visited = 0;
      function walk(node) {
        if (!node || text.length >= limit || ++visited > 30000) return;
        if (node.nodeType === 3) {
          text += (node.textContent || '').replace(/\s+/g, ' ').slice(0, limit - text.length);
          return;
        }
        if (node.nodeType !== 1 || hidden(node)) return;
        const block = /^(DIV|P|H[1-6]|TR|LI|SECTION|ARTICLE|BR|TABLE)$/.test(node.tagName);
        if (block) text += '\n';
        for (const child of node.childNodes || []) walk(child);
        // CSS 省略的完整岗位名常保存在 title / data-original-title 中。
        const title = node.getAttribute('title') || node.getAttribute('data-original-title');
        if (title && title.length <= 300 && !(node.textContent || '').includes(title)) text += ` [${title}]`;
        if (/^(TD|TH)$/.test(node.tagName)) text += ' | ';
        if (block) text += '\n';
      }
      walk(root);
      return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, limit);
    }
    const tables = [];
    let remaining = 24000, rowCount = 0;
    for (const table of document.querySelectorAll('table, [role="table"], [role="grid"]')) {
      if (!visible(table) || tables.length >= 15 || remaining <= 0) continue;
      const rows = [];
      for (const row of table.querySelectorAll('tr, [role="row"]')) {
        if (rowCount >= 101 || remaining <= 0) break;
        if (!visible(row)) continue;
        const cells = Array.from(row.querySelectorAll('th, td, [role="columnheader"], [role="cell"], [role="gridcell"]'))
          .slice(0, 16).filter(visible).map(cell => readText(cell, 600));
        if (!cells.some(Boolean)) continue;
        const size = cells.join(' | ').length;
        if (size > remaining) break;
        remaining -= size;
        rowCount++;
        rows.push(cells);
      }
      if (rows.length) tables.push({ rows });
    }
    return {
      pageTitle: document.title.slice(0, 240),
      sourceUrl: location.href,
      companyHints: recruitmentCompanyHints(),
      text: readText(document.body, 18000),
      tables
    };
  }

  function getJobPageMetadata() {
    const job = readJobPostingJsonLd();
    const url = location.href;
    let sourceSite = '';
    try { sourceSite = new URL(url).hostname.replace(/^www\./i, ''); } catch (e) { /* ignore */ }

    const applicationRows = applicationRowsFromDom();
    const jobTitle = compactMetadataText(job && job.title, 160) || jobTitleFromDom(applicationRows);
    const organization = job && job.hiringOrganization;
    const companyName = compactMetadataText(organization && (organization.name || organization.legalName), 140) || companyNameFromDom();
    const jobLocation = jobLocationFromJsonLd(job) || firstMetadataText([
      '[data-testid*="location" i]', '[class*="job-location" i]', '[class*="work-address" i]',
      '[class*="job-address" i]', '[class*="position-location" i]'
    ], 120);
    const applications = applicationRows.length > 0
      ? applicationRows.map(item => ({
        ...item,
        companyName: item.companyName || companyName || item.organizationUnit || '',
        location: item.location || jobLocation
      }))
      : (jobTitle ? [{ jobTitle, companyName, location: jobLocation, successful: true }] : []);

    return {
      companyName,
      jobTitle,
      applications,
      applicationDetailsDetected: applicationRows.length > 0 || Array.from(document.querySelectorAll('h1, h2, h3, h4'))
        .some(element => APPLICATION_SECTION_HEADING_RE.test(compactMetadataText(element.textContent, 80))),
      sourceSite,
      sourceUrl: url,
      location: jobLocation,
      pageTitle: compactMetadataText(document.title, 240)
    };
  }

  async function openQuickRecommendationFromPopup() {
    if (window.top !== window) return { ok: false, error: '请在网页主页面中使用自动推荐' };
    if (isAccountAccessPage() || isConversationPage()) {
      return { ok: false, error: '登录、注册或聊天页面不启用自动推荐' };
    }

    const fields = Array.from(new Set(scanFieldElements().map(resolveQuickField).filter(Boolean)));
    if (!fields.length) return { ok: false, error: '当前页面没有可推荐填写的输入框' };

    quickFillManualEnabled = true;
    quickFillEnabled = true;
    quickAutoFillEnabled = true;
    const button = createFloatingButton();
    initQuickFill();

    const activeField = resolveQuickField(document.activeElement);
    const viewportField = fields.find(field => {
      const rect = field.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    });
    const target = activeField || viewportField;
    if (target) {
      await showQuickPanel(target);
      updateQuickAutoFillToggle();
    }
    if (!qp || !qp.open) {
      showQuickFillTip(button, '自动推荐已开启，请点击输入框', 'success');
    }
    return { ok: true, panelOpened: !!(qp && qp.open) };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || window.top !== window) return false;
      if (message.type === 'GET_JOB_PAGE_METADATA') {
        sendResponse({ metadata: getJobPageMetadata(), pageContext: getApplicationPageContext() });
        return false;
      }
      if (message.type === 'OPEN_QUICK_RECOMMENDATION') {
        openQuickRecommendationFromPopup()
          .then(sendResponse)
          .catch(error => sendResponse({ ok: false, error: error.message || '打开自动推荐失败' }));
        return true;
      }
      return false;
    });
  }

  function startDetection() {
    // iframe 中也需要初始化：检测简历表单并注册 quickFill 点击监听。
    // 浮动按钮的显隐已在 refreshFloatingActions() 中按 isTopFrame 控制，不会重复。
    refreshFloatingActions();
    armObserver();
  }

  async function retryEnhancementField(field) {
    if (running || quickFillRunning) throw new Error('请等待当前填写结束');
    if (!isFieldEmptyForFill(field)) throw new Error('字段已有内容或受保护');
    running = true;
    try {
      const profile = await getProfile();
      await enhancement.begin(profile, [field]);
      const key = fieldScanIdentity(field);
      const local = await runLocalFillPasses([field], profile, null, current => fieldScanIdentity(current) === key);
      enhancement.check();
      let mappings = local.mappings;
      if (local.aiFields.length) {
        const result = await requestAIMappings(local.aiFields, profile);
        enhancement.check(); enhancement.aiResult(local.aiFields, result);
        if (!result?.error && !result?.__commError) {
          const extra = attachFieldIdentities(result?.mappings || [], local.aiFields);
          await executeFill(extra);
          mappings = mergeMappingsPreferLatest(mappings, extra);
        }
      }
      await reviewFilledMappings(mappings);
    } catch (error) {
      if (error.name !== 'ResumeFillStopped') throw error;
    } finally {
      await closeAllPanels(); running = false; enhancement.finish();
    }
  }

  if (globalThis.ResumeContentEnhancements && window.top === window) {
    enhancement = globalThis.ResumeContentEnhancements.create({
      identity: fieldScanIdentity, fields: collectFields, find: findElement, empty: isFieldEmptyForFill,
      choiceElements: getChoiceGroupElements,
      dock: ensureFloatingActionDock, satisfied: isMappingAlreadySatisfied, highlight: highlightField,
      retry: retryEnhancementField, recommend: showQuickPanel
    });
  }

  // ===== 初始化 =====
  startDetection();
  // 悬浮操作组持续跟随 SPA 页面内容变化；推荐可自动识别启用，也可由 popup 手动开启。
})();
