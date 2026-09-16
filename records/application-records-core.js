(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ApplicationRecordsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUSES = ['待投递', '已投递', '已测评', '已笔试', '面试中', 'offer', '终止'];
  const PAGE_SIZES = [10, 20, 50];
  const CSV_HEADERS = [
    '记录ID', '公司名称', '岗位名称', '来源站点', '职位链接',
    '状态', '投递日期', '工作地点', '志愿序号', '所属单位',
    '备注', '创建时间', '更新时间',
    '待办事项', '待办计时方式', '投递后天数', '待办截止日期', '待办已完成',
    '待办完成前状态', '待办同步状态'
  ];

  const HEADER_ALIASES = {
    id: ['记录id', 'id'],
    companyName: ['公司名称', '公司', 'company', 'companyname'],
    jobTitle: ['岗位名称', '岗位', '职位', '职位名称', 'job', 'jobtitle', 'position'],
    sourceSite: ['来源站点', '来源', '网站', 'sourcesite', 'source'],
    sourceUrl: ['职位链接', '链接', '网址', 'url', 'sourceurl'],
    status: ['状态', '投递状态', 'status'],
    appliedAt: ['投递日期', '日期', 'appliedat', 'applydate'],
    location: ['工作地点', '地点', '城市', 'location'],
    preferenceLabel: ['志愿序号', '志愿', '志愿标签', 'preferencelabel', 'preference'],
    organizationUnit: ['所属单位', '用人单位', '部门', 'organizationunit', 'unit'],
    notes: ['备注', '说明', 'notes', 'note'],
    createdAt: ['创建时间', 'createdat'],
    updatedAt: ['更新时间', 'updatedat'],
    todoTitle: ['待办事项', 'todotitle'],
    todoMode: ['待办计时方式', 'todomode'],
    todoDays: ['投递后天数', 'tododays'],
    todoDueDate: ['待办截止日期', 'tododuedate'],
    todoCompleted: ['待办已完成', 'todocompleted'],
    todoPreviousStatus: ['待办完成前状态', 'todopreviousstatus'],
    todoCompletedStatus: ['待办同步状态', 'todocompletedstatus']
  };

  function clean(value) {
    return value == null ? '' : String(value).trim();
  }

  function normalizeHeader(value) {
    return clean(value).replace(/^\uFEFF/, '').toLowerCase().replace(/[\s_-]+/g, '');
  }

  function validDateOnly(value) {
    const text = clean(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? '' : text;
  }

  // 待办截止时间：兼容纯日期（YYYY-MM-DD）与带具体时间（YYYY-MM-DDTHH:mm，T 或空格分隔）。
  function validDateTime(value) {
    const text = clean(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(text);
    if (!match) return '';
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const hour = match[4] === undefined ? 0 : Number(match[4]);
    const minute = match[5] === undefined ? 0 : Number(match[5]);
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (Number.isNaN(date.getTime())) return '';
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
        date.getHours() !== hour || date.getMinutes() !== minute) return '';
    const pad = part => String(part).padStart(2, '0');
    const base = `${year}-${pad(month)}-${pad(day)}`;
    return match[4] === undefined ? base : `${base}T${pad(hour)}:${pad(minute)}`;
  }

  // 截止时刻（本地时间）：纯日期按当天 23:59:59.999 结束，带时间按精确时刻。
  function deadlineMs(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(clean(text));
    if (!match) return null;
    const date = match[4] === undefined
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999)
      : new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }

  // 比较基准时刻：Date/时间戳/ISO 字符串，纯日期按当地 0 点。
  function referenceMs(reference) {
    if (reference == null) return Date.now();
    if (reference instanceof Date) return Number.isNaN(reference.getTime()) ? Date.now() : reference.getTime();
    if (typeof reference === 'number' && Number.isFinite(reference)) return reference;
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(reference));
    if (dateOnly) {
      const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 0, 0, 0, 0);
      return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
    }
    const parsed = Date.parse(reference);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  function sameLocalDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  }

  // 剩余/逾期时长文案：超过 24 小时显示天数，不足 24 小时显示小时和分钟。
  function formatDuration(ms, overdue) {
    const prefix = overdue ? '已逾期' : '剩余';
    if (ms >= 86400000) return `${prefix} ${Math.floor(ms / 86400000)} 天`;
    const totalMinutes = overdue
      ? Math.max(1, Math.floor(ms / 60000))
      : Math.max(0, Math.floor(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${prefix} ${hours} 小时 ${minutes} 分钟`;
    if (hours > 0) return `${prefix} ${hours} 小时`;
    return `${prefix} ${minutes} 分钟`;
  }

  function validIso(value, fallback) {
    const text = clean(value);
    return text && !Number.isNaN(Date.parse(text)) ? text : fallback;
  }

  function normalizeSourceUrl(value) {
    let text = clean(value);
    if (!text) return '';
    if (/^www\./i.test(text)) text = `https://${text}`;
    try {
      const parsed = new URL(text);
      return /^(https?:)$/i.test(parsed.protocol) ? parsed.href : '';
    } catch (e) {
      return '';
    }
  }

  function defaultId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `record-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeStatus(value) {
    const text = clean(value);
    const aliases = {
      pending: '待投递', applied: '已投递', assessment: '已测评', assessed: '已测评',
      evaluation: '已测评', evaluated: '已测评', 测评: '已测评', 测评中: '已测评',
      written: '已笔试', exam: '已笔试',
      interview: '面试中', interviewing: '面试中', offered: 'offer',
      rejected: '终止', closed: '终止', 放弃: '终止', 拒绝: '终止'
    };
    const normalized = aliases[text.toLowerCase()] || text;
    return STATUSES.includes(normalized) ? normalized : '待投递';
  }

  function sourceSiteFromUrl(url) {
    try {
      return new URL(clean(url)).hostname.replace(/^www\./i, '');
    } catch (e) {
      return '';
    }
  }

  function fallbackJobTitle(title) {
    const text = clean(title).replace(/\s+/g, ' ');
    if (!text) return '';
    const parts = text.split(/\s*[|｜·]\s*|\s+[-–—]\s+/).filter(Boolean);
    return (parts[0] || text).slice(0, 160);
  }

  function localDateToday(now) {
    const parsed = now instanceof Date ? now : (now ? new Date(now) : new Date());
    const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function normalizeApplicationStatus(value, fallback) {
    const text = clean(value);
    if (!text) return fallback || '已投递';
    if (/(?:offer|录用|已录取)/i.test(text)) return 'offer';
    if (/(?:面试)/.test(text)) return '面试中';
    if (/(?:测评|评测|assessment|evaluation)/i.test(text)) return '已测评';
    if (/(?:笔试|考试)/.test(text)) return '已笔试';
    if (/(?:终止|淘汰|未通过|拒绝|撤回|放弃|关闭)/.test(text)) return '终止';
    if (/(?:投递|申请|报名|已提交|处理中|筛选中)/.test(text)) return '已投递';
    return STATUSES.includes(text) ? text : (fallback || '已投递');
  }

  // 同时提到多个阶段时，按面试 > 笔试 > 测评同步。
  function todoSyncStatus(title) {
    const text = clean(title);
    if (!text) return '';
    if (/(?:面试|\binterview\b)/i.test(text)) return '面试中';
    if (/(?:笔试|考试|\b(?:exam|written\s+(?:test|exam))\b)/i.test(text)) return '已笔试';
    if (/(?:测评|评测|assessment|evaluation)/i.test(text)) return '已测评';
    return '';
  }

  function setTodoCompleted(record, input, completed) {
    const todo = normalizeTodo(input);
    if (!todo) return null;
    const current = normalizeRecord(record);
    const previousTodo = current.todo;
    let status = current.status;
    const nextTodo = { ...todo, completed: !!completed };
    delete nextTodo.statusSync;
    if (completed) {
      if (previousTodo && previousTodo.completed) {
        // 重复完成不会覆盖最初的回退状态。
        if (previousTodo.statusSync) nextTodo.statusSync = previousTodo.statusSync;
      } else {
        const target = todoSyncStatus(todo.title);
        if (target && STATUSES.indexOf(target) > STATUSES.indexOf(status)) status = target;
        nextTodo.statusSync = { previousStatus: current.status, completedStatus: status };
      }
    } else if (previousTodo && previousTodo.completed) {
      const sync = previousTodo.statusSync;
      if (sync && status === sync.completedStatus) status = sync.previousStatus;
    }
    return { todo: nextTodo, status };
  }

  function preferenceOrder(label) {
    const match = clean(label).match(/^(?:第\s*)?(\d+)\s*志愿$|^志愿\s*(\d+)$/);
    return match ? Number(match[1] || match[2]) : 0;
  }

  function fillMissingPreferenceLabels(records) {
    const used = new Set(records.map(record => preferenceOrder(record.preferenceLabel)).filter(Boolean));
    let next = 1;
    return records.map(record => {
      if (clean(record.preferenceLabel)) return { ...record };
      while (used.has(next)) next += 1;
      used.add(next);
      return { ...record, preferenceLabel: `第${next++}志愿` };
    });
  }

  function repairMissingPreferenceLabels(records) {
    const result = records.slice();
    const groups = new Map();
    records.forEach((record, index) => {
      // 旧版批量保存的各行具有同一创建时间；不按公司强行合并不同批次。
      if (!record.sourceUrl || !record.companyName || !record.appliedAt || !record.createdAt) return;
      const key = JSON.stringify([record.companyName, record.sourceUrl, record.appliedAt, record.createdAt]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    for (const indices of groups.values()) {
      if (indices.length < 2) continue;
      const filled = fillMissingPreferenceLabels(indices.map(index => records[index]));
      indices.forEach((index, position) => { result[index] = filled[position]; });
    }
    return result;
  }

  function draftsFromJobMetadata(metadata, tab, options) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const activeTab = tab && typeof tab === 'object' ? tab : {};
    const opts = options || {};
    const url = clean(source.sourceUrl || activeTab.url);
    const common = {
      companyName: clean(source.companyName),
      sourceSite: clean(source.sourceSite) || sourceSiteFromUrl(url),
      sourceUrl: url,
      location: clean(source.location),
      status: '已投递',
      appliedAt: validDateOnly(opts.today) || localDateToday(opts.now)
    };
    const applications = Array.isArray(source.applications)
      ? source.applications.filter(item => item && clean(item.jobTitle))
      : [];
    const sourceApplications = applications.length > 0 ? applications : [{
      jobTitle: clean(source.jobTitle) || fallbackJobTitle(activeTab.title || source.pageTitle)
    }];
    const seen = new Set();

    const drafts = sourceApplications.reduce((drafts, item) => {
      const jobTitle = clean(item.jobTitle);
      const identity = [item.preferenceLabel, jobTitle, item.organizationUnit]
        .map(value => clean(value).toLowerCase()).join('|');
      if (!jobTitle || seen.has(identity)) return drafts;
      seen.add(identity);
      const companyName = common.companyName || clean(item.companyName);
      const organizationUnit = clean(item.organizationUnit);
      const notes = [
        clean(item.preferenceLabel),
        organizationUnit && organizationUnit !== companyName ? organizationUnit : ''
      ].filter(Boolean).join(' · ');
      drafts.push({
        ...common,
        companyName,
        jobTitle,
        location: clean(item.location) || common.location,
        status: normalizeApplicationStatus(item.status, common.status),
        appliedAt: validDateOnly(item.appliedAt) || common.appliedAt,
        preferenceLabel: clean(item.preferenceLabel),
        organizationUnit,
        notes
      });
      return drafts;
    }, []);
    return fillMissingPreferenceLabels(drafts);
  }

  function normalizeTodo(input) {
    if (!input || typeof input !== 'object' || !clean(input.title)) return null;
    const mode = input.mode === 'fixedDate' ? 'fixedDate' : 'afterApplication';
    const days = Number(input.days);
    const dueDate = validDateTime(input.dueDate);
    if (mode === 'fixedDate' ? !dueDate : !Number.isInteger(days) || days < 1 || days > 3650) return null;
    const todo = {
      title: clean(input.title).slice(0, 120), mode,
      days: mode === 'afterApplication' ? days : null,
      dueDate: mode === 'fixedDate' ? dueDate : '',
      completed: input.completed === true || input.completed === 'true' || input.completed === '是'
    };
    const sync = input.statusSync;
    if (todo.completed && sync && STATUSES.includes(sync.previousStatus) && STATUSES.includes(sync.completedStatus)) {
      todo.statusSync = { previousStatus: sync.previousStatus, completedStatus: sync.completedStatus };
    }
    return todo;
  }

  function todoDeadline(record) {
    const todo = normalizeTodo(record && record.todo);
    if (!todo) return '';
    if (todo.mode === 'fixedDate') return todo.dueDate;
    const appliedAt = validDateOnly(record.appliedAt);
    if (!appliedAt) return '';
    // 按日历日计算；投递日期 + N 天为截止日，当地时间截止日结束后才逾期。
    const date = new Date(`${appliedAt}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + todo.days);
    return validDateOnly(date.toISOString().slice(0, 10));
  }

  function todoDeadlineMs(record) {
    const todo = normalizeTodo(record && record.todo);
    if (!todo) return null;
    if (todo.mode === 'fixedDate') return deadlineMs(todo.dueDate);
    const appliedAt = validDateOnly(record.appliedAt);
    if (!appliedAt) return null;
    const date = new Date(`${appliedAt}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + todo.days);
    return deadlineMs(date.toISOString().slice(0, 10));
  }

  function todoState(record, reference) {
    const todo = normalizeTodo(record && record.todo);
    if (!todo) return null;
    const dueDate = todoDeadline(record);
    if (todo.completed) {
      return { status: 'completed', text: '已完成', dueDate, remainingMs: null, level: 'completed' };
    }
    const deadline = todoDeadlineMs(record);
    if (deadline == null) {
      return { status: 'unscheduled', text: '待补投递日期', dueDate: '', remainingMs: null, level: 'unscheduled' };
    }
    const now = referenceMs(reference);
    const remainingMs = deadline - now;
    const daysRemaining = Math.round(remainingMs / 86400000);
    const status = remainingMs < 0 ? 'overdue' : sameLocalDay(deadline, now) ? 'due' : 'pending';
    // 提醒框颜色：剩余超过 3 天蓝色，1–3 天橙色，不足 24 小时红色，逾期红色。
    const level = remainingMs < 0 ? 'overdue'
      : remainingMs <= 86400000 ? 'urgent'
      : remainingMs <= 3 * 86400000 ? 'warning'
      : 'pending';
    const text = remainingMs < 0 ? formatDuration(-remainingMs, true) : formatDuration(remainingMs, false);
    return { status, text, dueDate, daysRemaining, remainingMs, level };
  }

  function normalizeRecord(input, options) {
    const source = input && typeof input === 'object' ? input : {};
    const opts = options || {};
    const now = opts.now || new Date().toISOString();
    const idFactory = opts.idFactory || defaultId;
    const status = normalizeStatus(source.status);
    const todo = normalizeTodo(source.todo);
    if (todo && todo.completed && !todo.statusSync) {
      // 旧版没有快照：按原标题固定兼容回退值，后续改名也不丢失。
      todo.statusSync = {
        previousStatus: status === todoSyncStatus(todo.title) ? '已投递' : status,
        completedStatus: status
      };
    }
    if (todo && todo.statusSync && status !== todo.statusSync.completedStatus) {
      // 后续手动修改或外部同步状态后，恢复待办不再撤销这次独立修改。
      todo.statusSync = { previousStatus: status, completedStatus: status };
    }
    return {
      id: clean(source.id) || idFactory(),
      companyName: clean(source.companyName),
      jobTitle: clean(source.jobTitle),
      sourceSite: clean(source.sourceSite),
      sourceUrl: normalizeSourceUrl(source.sourceUrl),
      status,
      appliedAt: validDateOnly(source.appliedAt),
      location: clean(source.location),
      preferenceLabel: clean(source.preferenceLabel),
      organizationUnit: clean(source.organizationUnit),
      notes: clean(source.notes),
      todo,
      createdAt: validIso(source.createdAt, now),
      updatedAt: validIso(source.updatedAt, now)
    };
  }

  function isUsefulRecord(record) {
    return !!(clean(record && record.companyName) || clean(record && record.jobTitle));
  }

  function filterRecords(records, filters) {
    const f = filters || {};
    const query = clean(f.query).toLowerCase();
    const location = clean(f.location).toLowerCase();
    const status = clean(f.status);
    const from = validDateOnly(f.from);
    const to = validDateOnly(f.to);

    return (Array.isArray(records) ? records : []).filter(record => {
      const haystack = [
        record.companyName, record.jobTitle, record.sourceSite,
        record.sourceUrl, record.location, record.preferenceLabel,
        record.organizationUnit, record.notes, record.todo && record.todo.title
      ].join(' ').toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (location && !clean(record.location).toLowerCase().includes(location)) return false;
      if (status && record.status !== status) return false;
      if (from && (!record.appliedAt || record.appliedAt < from)) return false;
      if (to && (!record.appliedAt || record.appliedAt > to)) return false;
      if (f.todoOnly) {
        const todo = normalizeTodo(record.todo);
        if (!todo || todo.completed) return false;
      }
      return true;
    });
  }

  function sortRecords(records, field, direction) {
    const allowed = new Set([
      'updatedAt', 'createdAt', 'appliedAt', 'companyName', 'jobTitle',
      'sourceSite', 'status', 'location'
    ]);
    const key = allowed.has(field) ? field : 'updatedAt';
    const factor = direction === 'asc' ? 1 : -1;
    const statusIndex = new Map(STATUSES.map((status, index) => [status, index]));

    return (Array.isArray(records) ? records : [])
      .map((record, index) => ({ record, index }))
      .sort((a, b) => {
        let result;
        if (key === 'status') {
          result = (statusIndex.get(a.record.status) || 0) - (statusIndex.get(b.record.status) || 0);
        } else {
          result = clean(a.record[key]).localeCompare(clean(b.record[key]), 'zh-CN', {
            numeric: true,
            sensitivity: 'base'
          });
        }
        return result === 0 ? a.index - b.index : result * factor;
      })
      .map(item => item.record);
  }

  function paginateRecords(records, pageSize, currentPage) {
    const source = Array.isArray(records) ? records : [];
    const requestedSize = Number(pageSize);
    const normalizedPageSize = PAGE_SIZES.includes(requestedSize) ? requestedSize : PAGE_SIZES[0];
    const pageCount = Math.max(1, Math.ceil(source.length / normalizedPageSize));
    const requestedPage = Number.isFinite(Number(currentPage)) ? Math.floor(Number(currentPage)) : 1;
    const page = Math.min(pageCount, Math.max(1, requestedPage));
    const offset = (page - 1) * normalizedPageSize;
    const items = source.slice(offset, offset + normalizedPageSize);
    return {
      items,
      page,
      pageSize: normalizedPageSize,
      pageCount,
      total: source.length,
      start: source.length ? offset + 1 : 0,
      end: source.length ? offset + items.length : 0
    };
  }

  function spreadsheetSafe(value) {
    const text = value == null ? '' : String(value);
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  }

  function restoreSpreadsheetValue(value) {
    const text = value == null ? '' : String(value);
    return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
  }

  function csvCell(value) {
    const text = spreadsheetSafe(value).replace(/"/g, '""');
    return /[",\r\n]/.test(text) ? `"${text}"` : text;
  }

  function recordsToCSV(records) {
    const rows = [CSV_HEADERS];
    for (const record of Array.isArray(records) ? records : []) {
      const todo = normalizeTodo(record.todo);
      rows.push([
        record.id, record.companyName, record.jobTitle, record.sourceSite,
        record.sourceUrl, record.status, record.appliedAt, record.location,
        record.preferenceLabel, record.organizationUnit, record.notes,
        record.createdAt, record.updatedAt,
        todo ? todo.title : '', todo ? todo.mode : '', todo ? todo.days : '',
        todo ? todo.dueDate : '', todo ? String(todo.completed) : '',
        todo && todo.statusSync ? todo.statusSync.previousStatus : '',
        todo && todo.statusSync ? todo.statusSync.completedStatus : ''
      ]);
    }
    return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  }

  function parseCSV(text) {
    const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        if (row.some(cell => clean(cell))) rows.push(row);
        row = [];
      } else {
        field += char;
      }
    }

    if (field || row.length) {
      row.push(field);
      if (row.some(cell => clean(cell))) rows.push(row);
    }
    return rows;
  }

  function resolveColumns(headerRow) {
    const headers = headerRow.map(normalizeHeader);
    const columns = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const normalizedAliases = aliases.map(normalizeHeader);
      columns[field] = headers.findIndex(header => normalizedAliases.includes(header));
    }
    return columns;
  }

  function recordsFromCSV(text, options) {
    const rows = parseCSV(text);
    if (rows.length === 0) return { records: [], errors: ['CSV 文件为空'] };
    const columns = resolveColumns(rows[0]);
    if (columns.companyName < 0 && columns.jobTitle < 0) {
      return { records: [], errors: ['CSV 缺少“公司名称”或“岗位名称”列'] };
    }

    const opts = options || {};
    const now = opts.now || new Date().toISOString();
    const idFactory = opts.idFactory || defaultId;
    const records = [];
    const errors = [];

    rows.slice(1).forEach((row, index) => {
      const raw = {};
      for (const [field, column] of Object.entries(columns)) {
        if (column >= 0) raw[field] = restoreSpreadsheetValue(row[column] || '');
      }
      raw.todo = { title: raw.todoTitle, mode: raw.todoMode, days: raw.todoDays,
        dueDate: raw.todoDueDate, completed: raw.todoCompleted,
        statusSync: { previousStatus: raw.todoPreviousStatus, completedStatus: raw.todoCompletedStatus } };
      const record = normalizeRecord(raw, { now, idFactory });
      if (!isUsefulRecord(record)) {
        errors.push(`第 ${index + 2} 行缺少公司和岗位，已跳过`);
        return;
      }
      records.push(record);
    });

    return { records, errors };
  }

  function recordIdentity(record) {
    const preferenceFromNotes = (clean(record.notes).match(/第\s*\d+\s*志愿/) || [''])[0];
    return [
      clean(record.companyName).toLowerCase(),
      clean(record.jobTitle).toLowerCase(),
      clean(record.sourceUrl).toLowerCase(),
      clean(record.appliedAt),
      clean(record.preferenceLabel || preferenceFromNotes).replace(/\s+/g, '').toLowerCase(),
      clean(record.organizationUnit).toLowerCase()
    ].join('|');
  }

  function mergeUniqueRecords(existing, incoming) {
    const base = Array.isArray(existing) ? existing.slice() : [];
    const ids = new Set(base.map(record => clean(record.id)).filter(Boolean));
    const identities = new Set(base.map(recordIdentity));
    let added = 0;
    let skipped = 0;

    for (const record of Array.isArray(incoming) ? incoming : []) {
      const id = clean(record.id);
      const identity = recordIdentity(record);
      if ((id && ids.has(id)) || identities.has(identity)) {
        skipped++;
        continue;
      }
      base.push(record);
      if (id) ids.add(id);
      identities.add(identity);
      added++;
    }
    return { records: base, added, skipped };
  }

  return {
    STATUSES,
    PAGE_SIZES,
    CSV_HEADERS,
    normalizeRecord,
    normalizeTodo,
    todoSyncStatus,
    setTodoCompleted,
    todoDeadline,
    todoDeadlineMs,
    todoState,
    validDateTime,
    normalizeStatus,
    normalizeApplicationStatus,
    preferenceOrder,
    fillMissingPreferenceLabels,
    repairMissingPreferenceLabels,
    normalizeSourceUrl,
    draftsFromJobMetadata,
    isUsefulRecord,
    filterRecords,
    sortRecords,
    paginateRecords,
    recordsToCSV,
    parseCSV,
    recordsFromCSV,
    mergeUniqueRecords,
    recordIdentity
  };
});
