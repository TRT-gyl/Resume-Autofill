(function () {
  'use strict';

  const core = globalThis.ApplicationRecordsCore;
  const STORAGE_KEY = 'applicationRecords';
  const DRAFT_KEY = 'applicationRecordDraft';
  const DRAFTS_KEY = 'applicationRecordDrafts';
  const DRAFTS_PREFIX = 'applicationRecordDrafts:';
  const state = {
    records: [],
    visibleRecords: [],
    pageSize: 10,
    currentPage: 1,
    todoOnly: false,
    todoRecordId: null,
    todoSaving: false,
    renderedDate: null,
    toastTimer: null,
    batchDrafts: [],
    editorDraft: null,
    draggedDraftIndex: null,
    batchDragCleanup: null
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();
    await loadRecords();
    render();

    // 后台标签页恢复、或跨过午夜时更新日历日倒计时。
    setInterval(refreshCountdowns, 60000);
    document.addEventListener('visibilitychange', refreshCountdowns);

    const params = new URLSearchParams(location.search);
    if (params.get('new') === '1') {
      const requestedDraftId = String(params.get('draftId') || '').trim();
      let drafts = [];
      let analysis = null;
      if (requestedDraftId) {
        if (/^[a-zA-Z0-9._-]{1,160}$/.test(requestedDraftId)) {
          const requestKey = `${DRAFTS_PREFIX}${requestedDraftId}`;
          const analysisKey = `${requestKey}:analysis`;
          const stored = await storageGet([requestKey, analysisKey]);
          drafts = Array.isArray(stored[requestKey]) ? stored[requestKey].filter(Boolean) : [];
          analysis = stored[analysisKey];
          await storageRemove([requestKey, analysisKey]);
        }
      } else {
        // 兼容 1.6.1 及更早版本已经暂存、尚未打开的草稿。
        const stored = await storageGet([DRAFT_KEY, DRAFTS_KEY]);
        drafts = Array.isArray(stored[DRAFTS_KEY]) && stored[DRAFTS_KEY].length
          ? stored[DRAFTS_KEY].filter(Boolean)
          : (stored[DRAFT_KEY] ? [stored[DRAFT_KEY]] : []);
        await storageRemove([DRAFT_KEY, DRAFTS_KEY]);
      }
      if (drafts.length) {
        openEditor(analysis || drafts.length > 1 ? drafts : drafts[0], analysis);
      } else {
        showToast('投递草稿已失效，请返回志愿页重新记录');
      }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      state.records = normalizeRecords(changes[STORAGE_KEY].newValue);
      state.currentPage = 1;
      render();
    });
  }

  function bindEvents() {
    // 页面滚动、窗口变化、标签页切走时收起自定义提示框。
    window.addEventListener('scroll', hideCustomTip, true);
    window.addEventListener('resize', hideCustomTip);
    document.addEventListener('visibilitychange', hideCustomTip);
    document.getElementById('btn-todo-filter').addEventListener('click', () => {
      const todoOnly = !state.todoOnly;
      clearFilters();
      state.todoOnly = todoOnly;
      resetPageAndRender();
    });
    // 点击统计卡片（已测评/已笔试/面试中）切换状态筛选
    document.querySelectorAll('.stat-status').forEach(card => {
      card.addEventListener('click', () => {
        const status = card.dataset.status;
        const filterEl = document.getElementById('filter-status');
        // 再次点击同一个卡片则取消筛选
        if (filterEl.value === status) {
          filterEl.value = '';
        } else {
          filterEl.value = status;
        }
        state.todoOnly = false;
        resetPageAndRender();
      });
    });
    document.getElementById('todo-form').addEventListener('submit', saveTodo);
    ['btn-todo-close', 'btn-todo-cancel'].forEach(id => {
      document.getElementById(id).addEventListener('click', closeTodoEditor);
    });
    document.getElementById('todo-dialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeTodoEditor();
    });
    document.getElementById('btn-todo-remove').addEventListener('click', () => persistTodo(null));
    document.getElementById('btn-todo-complete').addEventListener('click', toggleTodoCompleted);
    document.getElementById('todo-mode').addEventListener('change', updateTodoPreview);
    ['todo-title', 'todo-days', 'todo-date'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateTodoPreview);
    });
    document.getElementById('btn-new').addEventListener('click', () => openEditor());
    document.getElementById('btn-empty-new').addEventListener('click', () => {
      if (state.todoOnly) clearFilters();
      else openEditor();
    });
    document.getElementById('btn-import').addEventListener('click', () => {
      document.getElementById('csv-input').click();
    });
    document.getElementById('btn-export').addEventListener('click', exportCSV);
    document.getElementById('csv-input').addEventListener('change', handleCSVImport);
    document.getElementById('btn-clear-filters').addEventListener('click', clearFilters);
    document.getElementById('record-form').addEventListener('submit', saveEditor);
    document.getElementById('btn-add-preference').addEventListener('click', addBatchDraft);
    document.getElementById('btn-dialog-close').addEventListener('click', closeEditor);
    document.getElementById('btn-dialog-cancel').addEventListener('click', closeEditor);
    document.getElementById('page-size').addEventListener('change', event => {
      state.pageSize = Number(event.target.value) || 10;
      state.currentPage = 1;
      render();
    });
    document.getElementById('btn-page-prev').addEventListener('click', () => {
      state.currentPage -= 1;
      render();
    });
    document.getElementById('btn-page-next').addEventListener('click', () => {
      state.currentPage += 1;
      render();
    });

    ['filter-query', 'filter-location', 'filter-from', 'filter-to'].forEach(id => {
      document.getElementById(id).addEventListener('input', resetPageAndRender);
    });
    ['filter-status', 'sort-field', 'sort-direction'].forEach(id => {
      document.getElementById(id).addEventListener('change', resetPageAndRender);
    });
  }

  function resetPageAndRender() {
    state.currentPage = 1;
    render();
  }

  function storageGet(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(value, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function storageRemove(key) {
    return new Promise(resolve => chrome.storage.local.remove(key, resolve));
  }

  function normalizeRecords(records) {
    return (Array.isArray(records) ? records : [])
      .map(record => core.normalizeRecord(record))
      .filter(core.isUsefulRecord);
  }

  async function loadRecords() {
    const stored = await storageGet([STORAGE_KEY]);
    const records = (Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : []).filter(Boolean);
    const repaired = core.repairMissingPreferenceLabels(records);
    state.records = normalizeRecords(repaired);
    if (repaired.some((record, index) => record.preferenceLabel !== records[index].preferenceLabel)) {
      await storageSet({ [STORAGE_KEY]: state.records });
    }
  }

  async function persistRecords(records) {
    await storageSet({ [STORAGE_KEY]: records });
    state.records = records;
    render();
  }

  function readFilters() {
    return {
      query: valueOf('filter-query'),
      status: valueOf('filter-status'),
      location: valueOf('filter-location'),
      from: valueOf('filter-from'),
      to: valueOf('filter-to'),
      todoOnly: state.todoOnly
    };
  }

  function render() {
    hideCustomTip();
    state.renderedDate = today();
    renderStats();
    const filtered = core.filterRecords(state.records, readFilters());
    state.visibleRecords = core.sortRecords(
      filtered,
      valueOf('sort-field'),
      valueOf('sort-direction')
    );
    const pagination = core.paginateRecords(state.visibleRecords, state.pageSize, state.currentPage);
    state.pageSize = pagination.pageSize;
    state.currentPage = pagination.page;
    renderTable(pagination.items, pagination.total);
    renderPagination(pagination);
    const filteredSummary = pagination.total === state.records.length
      ? `共 ${state.records.length} 条`
      : `筛选出 ${pagination.total} 条，共 ${state.records.length} 条`;
    document.getElementById('result-summary').textContent = pagination.total
      ? `显示 ${pagination.start}-${pagination.end} 条，${filteredSummary}`
      : filteredSummary;
    if (state.todoOnly) document.getElementById('result-summary').textContent += ' · 仅看未完成待办';
  }

  function renderPagination(pagination) {
    const container = document.getElementById('pagination');
    container.hidden = pagination.total === 0;
    document.getElementById('page-size').value = String(pagination.pageSize);
    document.getElementById('page-indicator').textContent =
      `第 ${pagination.page} / ${pagination.pageCount} 页`;
    document.getElementById('btn-page-prev').disabled = pagination.page <= 1;
    document.getElementById('btn-page-next').disabled = pagination.page >= pagination.pageCount;
  }

  function renderStats() {
    const count = status => state.records.filter(record => record.status === status).length;
    document.getElementById('stat-total').textContent = String(state.records.length);
    document.getElementById('stat-pending').textContent = String(count('待投递'));
    document.getElementById('stat-assessment').textContent = String(count('已测评'));
    document.getElementById('stat-written').textContent = String(count('已笔试'));
    document.getElementById('stat-interview').textContent = String(count('面试中'));
    document.getElementById('stat-offer').textContent = String(count('offer'));
    const todos = state.records.map(record => core.todoState(record, Date.now()))
      .filter(todo => todo && todo.status !== 'completed');
    const overdue = todos.filter(todo => todo.status === 'overdue').length;
    const due = todos.filter(todo => todo.status === 'due').length;
    const reminder = document.getElementById('btn-todo-filter');
    document.getElementById('stat-todo').textContent = String(todos.length);
    reminder.classList.toggle('has-todos', todos.length > 0);
    reminder.setAttribute('aria-pressed', String(state.todoOnly));
    const summary = `${todos.length} 项未完成待办，${due} 项今天截止，${overdue} 项已逾期`;
    reminder.title = summary;
    reminder.setAttribute('aria-label', `${summary}，点击${state.todoOnly ? '查看全部记录' : '筛选待办'}`);
  }

  function renderTable(records, total) {
    const body = document.getElementById('records-body');
    body.replaceChildren();
    document.querySelector('.table-scroll').hidden = total === 0;
    document.getElementById('empty-state').hidden = total !== 0;
    document.getElementById('empty-title').textContent = state.todoOnly
      ? '没有符合条件的未完成待办' : '还没有符合条件的投递记录';
    document.getElementById('empty-description').textContent = state.todoOnly
      ? '可以查看全部记录，点击待办列设置新事项或重新开启已完成事项。'
      : '可以从插件弹窗记录当前职位，或在这里手动新建。';
    document.getElementById('btn-empty-new').textContent = state.todoOnly ? '查看全部记录' : '新建第一条记录';

    records.forEach(record => {
      const row = document.createElement('tr');
      const companyName = record.companyName || '未填写总公司';
      const organizationUnit = String(record.organizationUnit || '').trim();
      row.appendChild(textCell(companyName, 'company-cell', companyName));
      row.appendChild(textCell(
        organizationUnit && organizationUnit !== String(record.companyName || '').trim()
          ? organizationUnit
          : '—',
        'unit-cell',
        organizationUnit
      ));
      const jobTitle = record.jobTitle || '未填写岗位';
      row.appendChild(textCell(
        jobTitle,
        'title-cell',
        [record.jobTitle, record.notes].filter(Boolean).join('\n')
      ));
      row.appendChild(renderPreferenceCell(record.preferenceLabel));

      const statusCell = document.createElement('td');
      statusCell.className = 'status-cell';
      const statusSelect = document.createElement('select');
      statusSelect.className = 'status-select';
      statusSelect.dataset.status = record.status;
      core.STATUSES.forEach(status => {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = status;
        option.selected = status === record.status;
        statusSelect.appendChild(option);
      });
      statusSelect.addEventListener('change', () => {
        statusSelect.dataset.status = core.normalizeStatus(statusSelect.value);
        updateStatus(record.id, statusSelect.value);
      });
      statusCell.appendChild(statusSelect);
      row.appendChild(statusCell);

      row.appendChild(textCell(record.appliedAt || '—', 'date-cell'));
      row.appendChild(renderTodoCell(record));
      row.appendChild(textCell(record.location || '—', 'location-cell', record.location));
      row.appendChild(renderSourceCell(record));
      row.appendChild(renderActionsCell(record));
      body.appendChild(row);
    });
  }

  function refreshCountdowns() {
    if (state.renderedDate !== today()) {
      render();
      if (state.todoRecordId) updateTodoPreview();
      return;
    }
    // 24 小时内的小时/分钟倒计时每分钟刷新，跨天由上一分支处理。
    const ticking = state.records.some(record => {
      const todo = core.todoState(record, Date.now());
      return todo && todo.remainingMs != null && todo.remainingMs < 86400000;
    });
    if (ticking) render();
  }

  function renderTodoCell(record) {
    const cell = document.createElement('td');
    cell.className = 'todo-cell';
    const button = document.createElement('button');
    const todo = core.todoState(record, Date.now());
    button.type = 'button';
    button.className = 'todo-countdown';
    button.dataset.state = todo ? todo.level : 'empty';
    if (todo) {
      const title = document.createElement('span');
      title.className = 'todo-name';
      title.textContent = record.todo.title;
      const remaining = document.createElement('strong');
      remaining.textContent = todo.text;
      button.append(title, remaining);
      button.dataset.tipTitle = record.todo.title;
      button.dataset.tipDetail = `${todo.text}${todo.dueDate ? ` · 截止 ${displayDeadline(todo.dueDate)}` : ''} · 点击设置`;
    } else {
      button.textContent = '＋ 设置待办';
      button.dataset.tipTitle = '设置待办事项';
      button.dataset.tipDetail = '点击设置待办事项与截止时间';
    }
    const tipText = `${button.dataset.tipTitle} · ${button.dataset.tipDetail}`;
    button.setAttribute('aria-label', `${record.jobTitle || record.companyName}：${tipText}`);
    button.addEventListener('click', () => { hideCustomTip(); openTodoEditor(record.id); });
    button.addEventListener('mouseenter', () => showCustomTip(button));
    button.addEventListener('mouseleave', hideCustomTip);
    button.addEventListener('focus', () => showCustomTip(button));
    button.addEventListener('blur', hideCustomTip);
    cell.appendChild(button);
    return cell;
  }

  // ===== 自定义提示框（替代原生 title；body 级定位，避免被表格滚动容器裁剪） =====
  let customTip = null;
  let customTipTarget = null;
  function ensureCustomTip() {
    if (customTip) return customTip;
    customTip = document.createElement('div');
    customTip.className = 'custom-tip';
    customTip.setAttribute('role', 'tooltip');
    document.body.appendChild(customTip);
    return customTip;
  }
  function showCustomTip(button) {
    if (customTipTarget === button) return;
    const tip = ensureCustomTip();
    customTipTarget = button;
    tip.classList.remove('show');
    tip.replaceChildren();
    const titleText = button.dataset.tipTitle || '';
    const detailText = button.dataset.tipDetail || '';
    if (titleText) {
      const titleEl = document.createElement('strong');
      titleEl.className = 'custom-tip-title';
      titleEl.textContent = titleText;
      tip.appendChild(titleEl);
    }
    if (detailText) {
      const detailEl = document.createElement('span');
      detailEl.className = 'custom-tip-detail';
      detailEl.textContent = detailText;
      tip.appendChild(detailEl);
    }
    const rect = button.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    let top = rect.top - tipRect.height - 10;
    if (top < 8) {
      top = rect.bottom + 10;
      tip.classList.add('below');
    } else {
      tip.classList.remove('below');
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.classList.add('show');
  }
  function hideCustomTip() {
    if (!customTip) return;
    customTip.classList.remove('show');
    customTipTarget = null;
  }

  function openTodoEditor(id) {
    const record = state.records.find(item => item.id === id);
    if (!record) return;
    state.todoRecordId = id;
    const todo = record.todo;
    document.getElementById('todo-record-label').textContent =
      [record.companyName, record.organizationUnit, record.jobTitle, record.preferenceLabel].filter(Boolean).join(' · ');
    setValue('todo-title', todo ? todo.title : '完成测评');
    setValue('todo-mode', todo ? todo.mode : 'afterApplication');
    setValue('todo-days', todo && todo.days != null ? todo.days : 10);
    setValue('todo-date', toDatetimeLocal(todo && todo.dueDate));
    const completeButton = document.getElementById('btn-todo-complete');
    completeButton.hidden = !todo;
    completeButton.setAttribute('aria-pressed', String(!!(todo && todo.completed)));
    completeButton.textContent = todo && todo.completed ? '已完成 · 点击恢复' : '已完成此待办';
    completeButton.title = todo && todo.completed ? '点击恢复为未完成' : '点击标记为已完成';
    document.getElementById('btn-todo-remove').hidden = !todo;
    document.getElementById('todo-error').textContent = '';
    updateTodoPreview();
    document.getElementById('todo-dialog').showModal();
  }

  function closeTodoEditor() {
    if (state.todoSaving) return;
    document.getElementById('todo-dialog').close();
    state.todoRecordId = null;
  }

  function readTodo() {
    const record = state.records.find(item => item.id === state.todoRecordId);
    return core.normalizeTodo({
      ...(record && record.todo),
      title: valueOf('todo-title'), mode: valueOf('todo-mode'),
      days: valueOf('todo-days'), dueDate: valueOf('todo-date'),
      completed: !!(record && record.todo && record.todo.completed)
    });
  }

  // 完成状态与申请状态一次保存；成功前不切换按钮，失败后可直接重试。
  async function toggleTodoCompleted() {
    if (state.todoSaving) return;
    const todo = readTodo();
    if (!validateTodo(todo)) return;
    const record = state.records.find(item => item.id === state.todoRecordId);
    const completed = !todo.completed;
    const next = core.setTodoCompleted(record, todo, completed);
    const message = `${completed ? '待办已完成' : '待办已恢复'}${next.status !== record.status
      ? `，状态已${completed ? '同步' : '回退'}为“${next.status}”` : ''}`;
    await persistTodo(next.todo, { status: next.status, message });
  }

  function updateTodoPreview() {
    const relative = valueOf('todo-mode') === 'afterApplication';
    document.getElementById('todo-days-control').hidden = !relative;
    document.getElementById('todo-date-control').hidden = relative;
    document.getElementById('todo-days').disabled = !relative;
    document.getElementById('todo-days').required = relative;
    document.getElementById('todo-date').disabled = relative;
    document.getElementById('todo-date').required = !relative;
    const record = state.records.find(item => item.id === state.todoRecordId);
    const todo = core.normalizeTodo({ title: '预览', mode: valueOf('todo-mode'),
      days: valueOf('todo-days'), dueDate: valueOf('todo-date') });
    const deadline = record && core.todoDeadline({ ...record, todo });
    const preview = document.getElementById('todo-deadline-preview');
    preview.textContent = !record ? '该投递记录已删除，请关闭窗口。'
      : !todo ? '请填写有效的天数（1–3650）或截止时间。'
      : !deadline ? '请先在记录中补充投递日期，或改用指定截止时间。'
      : `${relative ? `投递日期 ${record.appliedAt} + ${todo.days} 天，` : ''}截止 ${displayDeadline(deadline)}${deadline.includes('T') ? '。' : '（当天结束前）。'}`;
    const input = readTodo();
    const next = record && input && core.setTodoCompleted(record, input, !input.completed);
    const statusPreview = document.getElementById('todo-status-preview');
    statusPreview.textContent = !next ? '' : input.completed
      ? next.status !== record.status ? `点击恢复后，状态将回退为“${next.status}”。` : '点击恢复后，待办重新计时，当前申请状态保留。'
      : next.status !== record.status ? `完成此待办后，状态将同步为“${next.status}”；恢复时回到完成前的状态。`
        : '完成此待办后，当前申请状态保留。';
    statusPreview.hidden = !next;
  }

  function validateTodo(todo) {
    const error = document.getElementById('todo-error');
    error.textContent = '';
    const record = state.records.find(item => item.id === state.todoRecordId);
    if (!record) {
      error.textContent = '该投递记录已删除，无法保存待办。';
      return false;
    }
    if (!todo) {
      error.textContent = '请填写待办事项及有效的天数（1–3650）或截止时间。';
      return false;
    }
    if (!core.todoDeadline({ ...record, todo })) {
      error.textContent = '请先补充投递日期，或指定截止时间。';
      return false;
    }
    return true;
  }

  async function saveTodo(event) {
    event.preventDefault();
    if (state.todoSaving) return;
    const todo = readTodo();
    if (!validateTodo(todo)) return;
    await persistTodo(todo);
  }

  async function persistTodo(todo, options) {
    if (state.todoSaving) return;
    const id = state.todoRecordId;
    if (!state.records.some(record => record.id === id)) {
      document.getElementById('todo-error').textContent = '该投递记录已删除，无法保存待办。';
      return;
    }
    state.todoSaving = true;
    const buttons = ['btn-todo-save', 'btn-todo-remove', 'btn-todo-complete', 'btn-todo-close', 'btn-todo-cancel'];
    buttons.forEach(button => { document.getElementById(button).disabled = true; });
    const opts = options || {};
    try {
      // 可选同步记录状态：options.status 非空时与待办一次性落盘，保证待办与状态同步一致。
      const next = state.records.map(record => record.id === id
        ? core.normalizeRecord({
            ...record,
            todo,
            status: opts.status ? core.normalizeStatus(opts.status) : record.status,
            updatedAt: new Date().toISOString()
          })
        : record);
      await persistRecords(next);
      state.records = next;
      state.todoSaving = false;
      closeTodoEditor();
      showToast(opts.message || (!todo ? '待办已移除'
        : todo.completed ? '待办已完成' : '待办倒计时已保存'));
    } catch (error) {
      document.getElementById('todo-error').textContent = `保存失败：${error.message}`;
    } finally {
      state.todoSaving = false;
      buttons.forEach(button => { document.getElementById(button).disabled = false; });
    }
  }

  function renderPreferenceCell(preferenceLabel) {
    const cell = document.createElement('td');
    cell.className = 'preference-cell';
    if (!preferenceLabel) {
      cell.textContent = '—';
      return cell;
    }
    const preference = document.createElement('span');
    preference.className = 'preference-badge';
    preference.textContent = preferenceLabel;
    cell.appendChild(preference);
    return cell;
  }

  function renderSourceCell(record) {
    const cell = document.createElement('td');
    if (record.sourceUrl) {
      const link = document.createElement('a');
      link.className = 'source-link';
      link.href = record.sourceUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = record.sourceSite || '打开职位';
      cell.appendChild(link);
    } else {
      cell.textContent = record.sourceSite || '—';
    }
    return cell;
  }

  function renderActionsCell(record) {
    const cell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const edit = rowButton('编辑');
    edit.addEventListener('click', () => openEditor(record));
    const remove = rowButton('删除', true);
    remove.addEventListener('click', () => deleteRecord(record));
    actions.append(edit, remove);
    cell.appendChild(actions);
    return cell;
  }

  function textCell(value, className, title) {
    const cell = document.createElement('td');
    cell.textContent = value;
    if (className) cell.className = className;
    if (title) cell.title = title;
    return cell;
  }

  function rowButton(label, danger) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `row-button${danger ? ' row-button-danger' : ''}`;
    button.textContent = label;
    return button;
  }

  function openEditor(record, analysis) {
    state.reviewApplications = Array.isArray(record) || !record?.id;
    const batch = Array.isArray(record) ? prepareBatchDrafts(record.filter(Boolean)) : [];
    const source = batch[0] || record || {};
    const editing = batch.length === 0 && !!source.id;
    state.batchDrafts = batch;
    state.editorDraft = batch.length === 0 ? { ...source } : null;
    const notice = document.getElementById('record-analysis-status');
    notice.textContent = analysis && typeof analysis.message === 'string' ? analysis.message : '';
    notice.hidden = !notice.textContent;
    document.getElementById('batch-reorder-status').textContent = '';
    document.getElementById('dialog-title').textContent = batch.length
      ? (batch.length > 1 ? '保存多个投递志愿' : '保存投递志愿')
      : (editing ? '编辑投递记录' : '新建投递记录');
    setValue('record-id', source.id);
    setValue('record-company', source.companyName);
    setValue('record-job', source.jobTitle);
    setValue('record-source-site', source.sourceSite);
    setValue('record-url', source.sourceUrl);
    setValue('record-status', source.status || '已投递');
    setValue('record-date', source.appliedAt === '' ? '' : source.appliedAt || today());
    document.getElementById('record-date').dataset.initialValue = valueOf('record-date');
    setValue('record-location', source.location);
    setValue('record-notes', batch.length ? '' : source.notes);
    renderBatchDrafts(batch);
    document.getElementById('form-error').textContent = '';
    document.getElementById('record-dialog').showModal();
    setTimeout(() => document.getElementById('record-company').focus(), 0);
  }

  function closeEditor() {
    if (state.batchDragCleanup) state.batchDragCleanup();
    state.batchDrafts = [];
    state.editorDraft = null;
    state.draggedDraftIndex = null;
    document.getElementById('record-dialog').close();
  }

  function renderBatchDrafts(drafts) {
    if (state.batchDragCleanup) state.batchDragCleanup();
    state.draggedDraftIndex = null;
    const section = document.getElementById('batch-section');
    const jobs = document.getElementById('batch-jobs');
    const isBatch = Array.isArray(drafts) && drafts.length > 0;
    document.getElementById('record-form').classList.toggle('batch-mode', isBatch);
    document.getElementById('record-company-label').textContent = isBatch ? '总公司名称' : '公司名称';
    section.hidden = !isBatch;
    document.getElementById('record-job-control').hidden = isBatch;
    document.getElementById('record-location-control').hidden = isBatch;
    jobs.replaceChildren();
    if (!isBatch) return;
    document.getElementById('batch-title').textContent = `待保存 ${drafts.length} 个志愿`;

    drafts.forEach((draft, index) => {
      const row = document.createElement('div');
      row.className = 'batch-job-row';
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'batch-job-label';
      label.textContent = draft.preferenceLabel;
      label.title = '拖动调整志愿顺序，也可聚焦后按上下方向键';
      label.setAttribute('aria-label', `调整${label.textContent}顺序`);
      label.addEventListener('pointerdown', event => startBatchDrag(event, index, label));
      label.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        moveBatchDraft(index, index + (event.key === 'ArrowUp' ? -1 : 1));
      });
      const unitInput = document.createElement('input');
      unitInput.type = 'text';
      unitInput.maxLength = 180;
      unitInput.className = 'batch-unit-input';
      unitInput.dataset.draftIndex = String(index);
      unitInput.value = draft.organizationUnit || '';
      unitInput.placeholder = '分公司 / 所属单位';
      unitInput.setAttribute('aria-label', `${label.textContent}分公司或所属单位`);
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 160;
      input.className = 'batch-job-input';
      input.dataset.draftIndex = String(index);
      input.value = draft.jobTitle || '';
      input.setAttribute('aria-label', `${label.textContent}岗位名称`);
      const locationInput = document.createElement('input');
      locationInput.type = 'text';
      locationInput.maxLength = 120;
      locationInput.className = 'batch-location-input';
      locationInput.dataset.draftIndex = String(index);
      locationInput.value = draft.location || '';
      locationInput.placeholder = '工作地点';
      locationInput.setAttribute('aria-label', `${label.textContent}工作地点`);
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'batch-remove-button';
      removeButton.textContent = '删除';
      removeButton.setAttribute('aria-label', `删除${label.textContent}`);
      removeButton.addEventListener('click', () => removeBatchDraft(index));
      row.append(label, unitInput, input, locationInput, removeButton);
      const detail = document.createElement('div');
      detail.className = 'batch-job-detail';
      detail.textContent = [draft.appliedAt || '日期待补充', draft.status, draft.notes].filter(Boolean).join(' · ');
      row.appendChild(detail);
      jobs.appendChild(row);
    });
  }

  function batchDraftsFromInputs() {
    return Array.from(document.querySelectorAll('.batch-job-row')).map(row => {
      const input = row.querySelector('.batch-job-input');
      const unitInput = row.querySelector('.batch-unit-input');
      const locationInput = row.querySelector('.batch-location-input');
      const index = Number(input.dataset.draftIndex);
      return {
        ...(state.batchDrafts[index] || {}),
        jobTitle: String(input.value || '').trim(),
        organizationUnit: String(unitInput.value || '').trim(),
        location: String(locationInput.value || '').trim()
      };
    });
  }

  function prepareBatchDrafts(drafts) {
    const linked = new Set();
    return core.fillMissingPreferenceLabels(drafts).map(draft => {
      // 再次识别同一投递页面后排序，应更新原记录，不能因序号变化再插入一份。
      if (draft.id) { linked.add(draft.id); return draft; }
      const identityWithoutPreference = record => core.recordIdentity({ ...record, preferenceLabel: '', notes: '' });
      const candidates = state.records.filter(record => !linked.has(record.id) &&
        identityWithoutPreference(record) === identityWithoutPreference(draft));
      const match = candidates.length === 1 ? candidates[0]
        : candidates.find(record => record.preferenceLabel === draft.preferenceLabel);
      if (!match) return draft;
      linked.add(match.id);
      return { ...draft, id: match.id };
    });
  }

  function startBatchDrag(event, from, handle) {
    if (event.button !== 0 || state.batchDrafts.length < 2) return;
    if (state.batchDragCleanup) state.batchDragCleanup();
    event.preventDefault();
    handle.focus({ preventScroll: true });
    const pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY;
    const rows = Array.from(document.querySelectorAll('.batch-job-row'));
    let moved = false;
    let to = null;
    if (handle.setPointerCapture) handle.setPointerCapture(pointerId);

    const onMove = moveEvent => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
      moved = true;
      state.draggedDraftIndex = from;
      rows[from].classList.add('is-dragging');
      const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const target = hit && hit.closest('.batch-job-row');
      const index = rows.indexOf(target);
      to = index >= 0 ? index : null;
      rows.forEach((row, rowIndex) => row.classList.toggle('is-drop-target', rowIndex === to && rowIndex !== from));
      const dialog = document.getElementById('record-dialog');
      const bounds = dialog.getBoundingClientRect();
      if (moveEvent.clientY > bounds.bottom - 50) dialog.scrollTop += 24;
      else if (moveEvent.clientY < bounds.top + 50) dialog.scrollTop -= 24;
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey);
      if (handle.hasPointerCapture && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      rows.forEach(row => row.classList.remove('is-dragging', 'is-drop-target'));
      state.draggedDraftIndex = null;
      state.batchDragCleanup = null;
    };
    const onUp = upEvent => {
      if (upEvent.pointerId !== pointerId) return;
      // 最后一个指针位置可能没有单独触发 move，松开时再命中一次目标行。
      onMove(upEvent);
      cleanup();
      if (moved && to !== null) moveBatchDraft(from, to);
    };
    const onCancel = cancelEvent => { if (cancelEvent.pointerId === pointerId) cleanup(); };
    const onKey = keyEvent => {
      if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); cleanup(); }
    };
    state.batchDragCleanup = cleanup;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  }

  function moveBatchDraft(from, to) {
    const drafts = batchDraftsFromInputs();
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 ||
        from >= drafts.length || to >= drafts.length || from === to) return;
    // 部分志愿编辑时只交换当前列表的序号，避免占用列表外已保存志愿的序号。
    const labels = drafts.map(draft => draft.preferenceLabel)
      .sort((a, b) => core.preferenceOrder(a) - core.preferenceOrder(b));
    const [moved] = drafts.splice(from, 1);
    drafts.splice(to, 0, moved);
    state.batchDrafts = drafts.map((draft, index) => {
      const oldLabel = draft.preferenceLabel;
      const preferenceLabel = labels[index];
      let notes = draft.notes;
      if (notes === oldLabel || (notes && notes.startsWith(oldLabel + ' · '))) {
        notes = preferenceLabel + notes.slice(oldLabel.length);
      }
      return { ...draft, preferenceLabel, notes };
    });
    renderBatchDrafts(state.batchDrafts);
    document.querySelectorAll('.batch-job-row')[to].querySelector('.batch-job-label').focus({ preventScroll: true });
    document.getElementById('batch-reorder-status').textContent = `已移至${state.batchDrafts[to].preferenceLabel}`;
  }

  function addBatchDraft() {
    // 先读取正在编辑的输入值，避免新增一行时重绘丢失尚未保存的修改。
    const drafts = state.batchDrafts.length > 0 ? batchDraftsFromInputs() : [{
      ...(state.editorDraft || {}),
      id: valueOf('record-id'),
      preferenceLabel: (state.editorDraft && state.editorDraft.preferenceLabel) || '第1志愿',
      jobTitle: valueOf('record-job'),
      location: valueOf('record-location'),
      // 单条表单的状态、日期和备注继续从公共输入读取。
      status: '',
      appliedAt: '',
      notes: ''
    }];
    // 编辑已有记录时，也避开同次投递中其他已保存志愿的序号。
    const related = valueOf('record-id') ? state.records.filter(record =>
      record.companyName === valueOf('record-company') &&
      record.sourceUrl === valueOf('record-url') &&
      record.appliedAt === valueOf('record-date')
    ) : [];
    const nextOrder = drafts.concat(related).reduce((highest, draft, index) => {
      const match = String(draft.preferenceLabel || '').match(/\d+/);
      return Math.max(highest, match ? Number(match[0]) : index < drafts.length ? index + 1 : 0);
    }, 0) + 1;
    drafts.push({ preferenceLabel: `第${nextOrder}志愿`, organizationUnit: '', jobTitle: '', location: '' });
    state.batchDrafts = drafts;
    document.getElementById('dialog-title').textContent = '保存多个投递志愿';
    document.getElementById('form-error').textContent = '';
    renderBatchDrafts(drafts);
    const rows = document.querySelectorAll('.batch-job-row');
    rows[rows.length - 1].querySelector('.batch-unit-input').focus();
  }

  function removeBatchDraft(index) {
    if (state.batchDrafts.length <= 1) {
      document.getElementById('form-error').textContent = '至少保留一个志愿。';
      return;
    }
    state.batchDrafts = batchDraftsFromInputs().filter((draft, draftIndex) => draftIndex !== index);
    document.getElementById('dialog-title').textContent = state.batchDrafts.length > 1
      ? '保存多个投递志愿'
      : '保存投递志愿';
    document.getElementById('form-error').textContent = '';
    renderBatchDrafts(state.batchDrafts);
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (state.batchDrafts.length > 0) {
      await saveBatchEditor();
      return;
    }
    const id = valueOf('record-id');
    const current = state.records.find(record => record.id === id);
    const sourceDraft = state.editorDraft || {};
    const now = new Date().toISOString();
    let record = core.normalizeRecord({
      id,
      companyName: valueOf('record-company'),
      jobTitle: valueOf('record-job'),
      sourceSite: valueOf('record-source-site'),
      sourceUrl: valueOf('record-url'),
      status: valueOf('record-status'),
      appliedAt: valueOf('record-date'),
      location: valueOf('record-location'),
      preferenceLabel: (current ? current.preferenceLabel : sourceDraft.preferenceLabel) || '第1志愿',
      organizationUnit: current ? current.organizationUnit : sourceDraft.organizationUnit,
      notes: valueOf('record-notes'),
      todo: current ? current.todo : sourceDraft.todo,
      createdAt: current && current.createdAt,
      updatedAt: now
    }, { now });

    if (!core.isUsefulRecord(record)) {
      document.getElementById('form-error').textContent = '公司名称和岗位名称至少填写一个。';
      return;
    }

    if (state.reviewApplications && globalThis.ResumeRecordsEnhancements) {
      const result = await ResumeRecordsEnhancements.review([record], state.records);
      if (!result) return;
      record = result.records[0];
    }
    const existingRecord = state.records.find(item => item.id === record.id);
    const next = existingRecord
      ? state.records.map(item => item.id === existingRecord.id ? record : item)
      : [record, ...state.records];

    try {
      await persistRecords(next);
      closeEditor();
      showToast(current ? '投递记录已更新' : '投递记录已保存');
    } catch (error) {
      document.getElementById('form-error').textContent = `保存失败：${error.message}`;
    }
  }

  async function saveBatchEditor() {
    const now = new Date().toISOString();
    const companyName = valueOf('record-company');
    const commonNotes = valueOf('record-notes');
    const rows = Array.from(document.querySelectorAll('.batch-job-row'));
    if (rows.some(row => !String(row.querySelector('.batch-job-input').value || '').trim())) {
      document.getElementById('form-error').textContent = '请补全所有志愿的岗位名称。';
      return;
    }
    let batchRecords = rows.map(row => {
      const input = row.querySelector('.batch-job-input');
      const unitInput = row.querySelector('.batch-unit-input');
      const locationInput = row.querySelector('.batch-location-input');
      const index = Number(input.dataset.draftIndex);
      const draft = state.batchDrafts[index] || {};
      const current = state.records.find(record => record.id === draft.id);
      const notes = [draft.notes, commonNotes].filter((value, noteIndex, all) =>
        value && all.indexOf(value) === noteIndex
      ).join('；');
      return core.normalizeRecord({
        id: current && current.id,
        companyName,
        jobTitle: input.value,
        sourceSite: valueOf('record-source-site'),
        sourceUrl: valueOf('record-url'),
        status: rows.length === 1 ? valueOf('record-status') : draft.status || valueOf('record-status'),
        appliedAt: rows.length === 1 ? valueOf('record-date') : draft.appliedAt ||
          (draft.appliedAt === '' && valueOf('record-date') === document.getElementById('record-date').dataset.initialValue
            ? '' : valueOf('record-date')),
        location: String(locationInput.value || '').trim(),
        preferenceLabel: draft.preferenceLabel,
        organizationUnit: String(unitInput.value || '').trim(),
        notes,
        todo: current ? current.todo : draft.todo,
        createdAt: current ? current.createdAt : now,
        updatedAt: now
      }, { now });
    }).filter(core.isUsefulRecord);

    if (!companyName && batchRecords.every(record => !record.jobTitle)) {
      document.getElementById('form-error').textContent = '公司名称和岗位名称至少填写一个。';
      return;
    }
    if (batchRecords.length !== rows.length) {
      document.getElementById('form-error').textContent = '请补全所有志愿的岗位名称。';
      return;
    }

    try {
      let separateIds = new Set();
      if (state.reviewApplications && globalThis.ResumeRecordsEnhancements) {
        const result = await ResumeRecordsEnhancements.review(batchRecords, state.records);
        if (!result) return;
        batchRecords = result.records; separateIds = result.separateIds;
      }
      // 从“编辑记录”追加志愿时更新原记录，只为新志愿创建记录。
      const existingIds = new Set(state.records.map(record => record.id));
      const updates = new Map(batchRecords.filter(record => existingIds.has(record.id)).map(record => [record.id, record]));
      const existing = state.records.map(record => updates.get(record.id) || record);
      const incoming = batchRecords.filter(record => !existingIds.has(record.id));
      const merged = core.mergeUniqueRecords(existing, incoming.filter(record => !separateIds.has(record.id)));
      const separate = incoming.filter(record => separateIds.has(record.id));
      merged.records.push(...separate); merged.added += separate.length;
      // 同批记录采用确认窗口的顺序落盘，拖动后列表和 CSV 也保持相同顺序。
      const savedIds = new Set(merged.records.map(record => record.id));
      const orderedBatch = batchRecords.filter(record => savedIds.has(record.id));
      const batchIds = new Set(orderedBatch.map(record => record.id));
      let batchIndex = 0;
      merged.records = merged.records.map(record => batchIds.has(record.id) ? orderedBatch[batchIndex++] : record);
      await persistRecords(merged.records);
      closeEditor();
      const skipped = merged.skipped ? `，跳过重复 ${merged.skipped} 条` : '';
      const updated = updates.size ? `，更新 ${updates.size} 条原记录` : '';
      showToast(`已保存 ${merged.added} 个投递志愿${updated}${skipped}`);
    } catch (error) {
      document.getElementById('form-error').textContent = `保存失败：${error.message}`;
    }
  }

  async function updateStatus(id, status) {
    const now = new Date().toISOString();
    const next = state.records.map(record => record.id === id
      ? core.normalizeRecord({ ...record, status, updatedAt: now })
      : record
    );
    try {
      await persistRecords(next);
      state.records = next;
      render();
      showToast(`状态已更新为“${status}”`);
    } catch (error) {
      showToast(`状态保存失败：${error.message}`, true);
      await loadRecords();
      render();
    }
  }

  async function deleteRecord(record) {
    const label = [record.companyName, record.jobTitle].filter(Boolean).join(' · ');
    if (!confirm(`确定删除“${label || '这条记录'}”吗？`)) return;
    try {
      await persistRecords(state.records.filter(item => item.id !== record.id));
      showToast('投递记录已删除');
    } catch (error) {
      showToast(`删除失败：${error.message}`, true);
    }
  }

  function clearFilters() {
    state.todoOnly = false;
    ['filter-query', 'filter-status', 'filter-location', 'filter-from', 'filter-to'].forEach(id => {
      setValue(id, '');
    });
    setValue('sort-field', 'updatedAt');
    setValue('sort-direction', 'desc');
    resetPageAndRender();
  }

  function exportCSV() {
    if (state.records.length === 0) {
      showToast('暂无可导出的投递记录', true);
      return;
    }
    const csv = `\uFEFF${core.recordsToCSV(state.records)}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `投递记录-${today()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${state.records.length} 条记录`);
  }

  async function handleCSVImport(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast('CSV 文件不能超过 5 MiB', true);
      return;
    }

    try {
      const parsed = core.recordsFromCSV(await file.text());
      if (parsed.records.length === 0) {
        throw new Error(parsed.errors[0] || '没有可导入的有效记录');
      }
      const merged = core.mergeUniqueRecords(state.records, parsed.records);
      await persistRecords(merged.records);
      const details = [
        `新增 ${merged.added} 条`,
        merged.skipped ? `跳过重复 ${merged.skipped} 条` : '',
        parsed.errors.length ? `忽略无效 ${parsed.errors.length} 行` : ''
      ].filter(Boolean).join('，');
      showToast(`CSV 导入完成：${details}`);
    } catch (error) {
      showToast(`CSV 导入失败：${error.message}`, true);
    }
  }

  function showToast(message, isError) {
    const toast = document.getElementById('toast');
    clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.className = `toast show${isError ? ' error' : ''}`;
    state.toastTimer = setTimeout(() => {
      toast.className = 'toast';
    }, 3200);
  }

  function valueOf(id) {
    return String(document.getElementById(id).value || '').trim();
  }

  function setValue(id, value) {
    document.getElementById(id).value = value == null ? '' : String(value);
  }

  function today() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  // 截止时间输入框只接受 YYYY-MM-DDTHH:mm；旧版纯日期默认补当天 23:59。
  function toDatetimeLocal(value) {
    const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(String(value || ''));
    return match ? (match[2] ? `${match[1]}T${match[2]}` : `${match[1]}T23:59`) : `${today()}T23:59`;
  }

  // 展示用：YYYY-MM-DDTHH:mm → YYYY-MM-DD HH:mm。
  function displayDeadline(value) {
    return String(value || '').replace('T', ' ');
  }
})();
