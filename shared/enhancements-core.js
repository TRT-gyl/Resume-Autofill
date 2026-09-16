(function (root) {
  'use strict';
  const SETTINGS_KEY = 'resumeEnhancementSettings';
  const RULES_KEY = 'resumeWebsiteRules';
  const ARRAY_KEYS = ['education', 'work', 'projects', 'campusDuties', 'computerSkills', 'patents', 'papers', 'awards', 'families'];
  const OBJECT_KEYS = ['basic', 'jobIntention', 'extra'];
  const TEXT_KEYS = ['certificates', 'skills', 'hobbies', 'selfEvaluation'];
  const PROFILE_KEYS = [...ARRAY_KEYS, ...OBJECT_KEYS, ...TEXT_KEYS, 'languages'];
  const SCHEMA_KEYS = ['chinaTelecomDateSchemaVersion', 'educationThesisSchemaVersion', 'resumeItemOrderSchemaVersion', 'popupSimplifiedFieldsSchemaVersion'];
  const forbidden = key => ['__proto__', 'prototype', 'constructor'].includes(key);
  const text = value => String(value == null ? '' : value).trim();
  const normalized = value => text(value).replace(/[\s*＊：:]+/g, '').toLowerCase();
  const clone = value => JSON.parse(JSON.stringify(value));
  function settings(value) {
    return { protectManual: value?.protectManual === true, aiEnhanced: value?.aiEnhanced === true };
  }
  function scalarObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (forbidden(key)) throw new Error('不支持的字段名');
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error(`${label}.${key} 类型不正确`);
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(`${label}.${key} 数字无效`);
      output[key] = item;
    }
    return output;
  }
  function validateImport(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('简历 JSON 顶层必须是对象');
    const allowed = new Set([...PROFILE_KEYS, ...SCHEMA_KEYS, 'llm']);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (!allowed.has(key)) throw new Error(`简历导入不支持字段：${key}`);
      if (ARRAY_KEYS.includes(key) || (key === 'languages' && Array.isArray(item))) {
        if (!Array.isArray(item)) throw new Error(`${key} 必须是经历数组`);
        output[key] = item.map((entry, index) => scalarObject(entry, `${key}[${index}]`));
      } else if (OBJECT_KEYS.includes(key)) output[key] = scalarObject(item, key);
      else if (key === 'llm') {
        output.llm = scalarObject(item, 'llm');
        for (const [name, v] of Object.entries(output.llm)) {
          if (!['baseUrl', 'apiKey', 'model'].includes(name) || typeof v !== 'string') throw new Error('模型配置格式不正确');
        }
      } else if (SCHEMA_KEYS.includes(key)) {
        if (!Number.isInteger(item) || item < 0) throw new Error('数据版本格式不正确');
        output[key] = item;
      } else {
        if (typeof item !== 'string') throw new Error(`${key} 必须是文本`);
        output[key] = item;
      }
    }
    if (!Object.keys(output).some(key => PROFILE_KEYS.includes(key) || key === 'llm')) throw new Error('未找到简历或模型配置');
    return output;
  }
  function profileSnapshot(stored) {
    const output = {};
    for (const key of [...PROFILE_KEYS, ...SCHEMA_KEYS]) {
      if (Object.prototype.hasOwnProperty.call(stored || {}, key)) output[key] = clone(stored[key]);
    }
    return output;
  }
  function ruleKey(url, field) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return ''; }
    const section = normalized(field.section || field.recordGroupKey);
    const label = normalized(field.label);
    if (!host || !section || !label || !field.componentType) return '';
    return JSON.stringify([host, section, label, field.componentType]);
  }
  function makeRule(url, field, source) {
    const key = ruleKey(url, field);
    const group = text(source?.group).split('.')[0];
    const fieldKey = text(source?.fieldKey);
    if (!key || !PROFILE_KEYS.includes(group) || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(fieldKey) || forbidden(fieldKey)) throw new Error('此字段的来源或区块不明确，不能保存规则');
    if (ARRAY_KEYS.includes(group) || group === 'languages') {
      if (field.recordGroupKey !== group || !Number.isInteger(field.recordIndex) || field.recordIndex < 0) throw new Error('重复经历的记录归属不明确，不能保存规则');
    }
    return { key, host: new URL(url).hostname, section: field.section || field.recordGroupKey, label: field.label,
      componentType: field.componentType, group, fieldKey, enabled: true, updatedAt: new Date().toISOString() };
  }
  function ruleMapping(rule, url, field, profile) {
    if (!rule || !rule.enabled || rule.key !== ruleKey(url, field)) return null;
    if (!PROFILE_KEYS.includes(rule.group) || forbidden(rule.fieldKey)) return null;
    let object = profile[rule.group], sourceRef;
    if (ARRAY_KEYS.includes(rule.group) || rule.group === 'languages') {
      if (field.recordGroupKey !== rule.group || !Array.isArray(object) || !Number.isInteger(field.recordIndex) || field.recordIndex < 0) return null;
      object = object[field.recordIndex];
      sourceRef = `${rule.group}.${field.recordIndex}.${rule.fieldKey}`;
    } else sourceRef = OBJECT_KEYS.includes(rule.group) ? `${rule.group}.${rule.fieldKey}` : rule.group;
    const value = OBJECT_KEYS.includes(rule.group) || ARRAY_KEYS.includes(rule.group) || rule.group === 'languages'
      ? object?.[rule.fieldKey] : object;
    if (!['string', 'number', 'boolean'].includes(typeof value) || !text(value)) return null;
    return { selector: field.selector, componentType: field.componentType, value: text(value), fromLocalRule: true,
      sourceRef, label: `网站规则 · ${sourceRef}` };
  }
  function sourceValue(profile, ref) {
    const parts = text(ref).replace(/^profile\./, '').split('.');
    if (!PROFILE_KEYS.includes(parts[0]) || parts.some(forbidden)) return undefined;
    let value = profile;
    for (const part of parts) value = value?.[part];
    return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  }
  function referenceAllowed(field, ref) {
    const parts = text(ref).replace(/^profile\./, '').split('.');
    if (field.recordGroupKey && ARRAY_KEYS.concat('languages').includes(field.recordGroupKey)) {
      if (!Number.isInteger(field.recordIndex) || field.recordIndex < 0) return false;
      const scalarLanguage = field.recordGroupKey === 'languages' && parts.join('.') === 'languages' && field.sourceRefs?.includes('languages');
      if (!scalarLanguage && (parts[0] !== field.recordGroupKey || parts[1] !== String(field.recordIndex))) return false;
    }
    if (field.sourceRefs?.length && !field.sourceRefs.includes(parts.join('.'))) return false;
    return true;
  }
  // 新增枚举归一化只在增强模式调用；旧引擎的语义规则不变。
  function enhancedEnumKey(value) {
    const v = text(value).replace(/[\s_\-/／（）()]/g, '').toLowerCase();
    const groups = [
      ['international', /^(国际级?|世界级)$/], ['national', /^(国家级?|全国级)$/],
      ['province', /^(省部级|省区级|省级|部级|省厅级)$/], ['city', /^(地市级|市级|市厅级)$/],
      ['county', /^(区县级|县级|县处级)$/], ['school', /^(院校级|学校级|校级)$/], ['college', /^(学院级|院系级|院级)$/],
      ['international-national', /^(国际级?国家级?|国家级?国际级?)$/], ['province-city', /^(省级?市级?|市级?省级?)$/],
      ['school-college', /^校内级?$/], ['city-county', /^县市级$/], ['yes', /^(是|有|yes|true|y)$/], ['no', /^(否|无|no|false|n)$/]
    ];
    return groups.find(([, re]) => re.test(v))?.[0] || '';
  }
  function enhancedEquivalent(actual, expected) {
    if (text(actual) === text(expected)) return true;
    const a = enhancedEnumKey(actual), b = enhancedEnumKey(expected);
    if (a && b) return a === b || ({ 'international-national': ['international', 'national'], 'province-city': ['province', 'city'],
      'school-college': ['school', 'college'], 'city-county': ['city', 'county'] }[a] || []).includes(b) ||
      (text(actual) === '院校级' && b === 'college');
    const date = v => text(v).match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?月?$/);
    const ad = date(actual), bd = date(expected);
    return !!(ad && bd && +ad[1] === +bd[1] && +ad[2] === +bd[2] &&
      (!ad[3] || (bd[3] && +ad[3] === +bd[3])));
  }
  function scopedProfile(profile, fields) {
    const groups = new Set(fields.map(field => field.recordGroupKey || field.sourceRefs?.[0]?.split('.')[0]));
    if (groups.has(undefined) || groups.has('') || [...groups].some(key => !PROFILE_KEYS.includes(key))) return profile;
    return Object.fromEntries([...groups].filter(key => profile[key] !== undefined).map(key => [key, profile[key]]));
  }
  function validateAIValue(field, mapping, profile) {
    const ref = text(mapping.sourceRef).replace(/^profile\./, '');
    if (!referenceAllowed(field, ref)) return null;
    const original = sourceValue(profile, ref);
    if (original === undefined || !text(original)) return null;
    const requested = text(mapping.value);
    if (ref === 'languages' && field.recordGroupKey === 'languages') {
      // 旧版语言文本按行转换成记录，只允许当前行明确产生的值，不能回填整段其他语言资料。
      const candidate = (field.sourceCandidates || []).find(candidate => candidate.sourceRef === ref && enhancedEquivalent(requested, candidate.value));
      if (!candidate) return null;
      const option = (field.options || []).find(option => enhancedEquivalent(option, requested));
      return { value: option ? text(option) : requested, sourceRef: ref };
    }
    let value = text(original);
    if (requested !== value) {
      if (enhancedEquivalent(requested, value)) value = requested;
      else if (!(requested.endsWith('…') && value.startsWith(requested.slice(0, -1))) &&
          !(requested.length >= 80 && value.startsWith(requested))) {
        const derived = (field.sourceCandidates || []).find(candidate => candidate.sourceRef === ref && candidate.value === requested);
        if (!derived) return null;
        value = derived.value;
      }
    }
    const option = (field.options || []).find(option => text(option) === value) ||
      (field.options || []).find(option => enhancedEquivalent(option, value));
    return { value: option ? text(option) : value, sourceRef: ref };
  }
  function cleanApplicationUrl(value) {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) if (/^utm_|^(gclid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      return url.href;
    } catch { return text(value); }
  }
  function explicitJobId(record) {
    if (record.jobId || record.positionId) return text(record.jobId || record.positionId);
    try {
      const url = new URL(record.sourceUrl);
      for (const [key, value] of url.searchParams) if (/^(jobid|positionid|postid|requisitionid)$/i.test(key)) return `${key.toLowerCase()}:${value}`;
      return url.pathname.match(/\/(?:jobs?|positions?|jobdetail)\/(\d+)(?:\/|$)/i)?.[1] || '';
    } catch { return ''; }
  }
  function possibleApplicationMatches(draft, records) {
    const norm = value => text(value).replace(/\s+/g, ' ').toLowerCase();
    const url = cleanApplicationUrl(draft.sourceUrl);
    return records.filter(record => {
      if (!draft.companyName || !draft.jobTitle || !draft.appliedAt) return false;
      if (['companyName', 'organizationUnit', 'appliedAt', 'preferenceLabel'].some(key => norm(record[key]) !== norm(draft[key]))) return false;
      const leftId = explicitJobId(record), rightId = explicitJobId(draft);
      if (leftId && rightId && leftId !== rightId) return false;
      if (leftId && rightId) {
        try {
          const a = new URL(cleanApplicationUrl(record.sourceUrl)), b = new URL(url);
          return a.hostname === b.hostname && a.search === b.search;
        } catch { return false; }
      }
      if (norm(record.jobTitle) !== norm(draft.jobTitle)) return false;
      // 保留批次、申请 ID 等业务参数；有差异时不将不同申请合并。
      return !url || !record.sourceUrl || cleanApplicationUrl(record.sourceUrl) === url;
    });
  }
  function applyApplicationUpdate(existing, incoming, fields) {
    const allowed = ['status', 'location', 'notes'];
    const output = { ...existing };
    for (const key of fields || []) if (allowed.includes(key)) output[key] = incoming[key];
    output.updatedAt = new Date().toISOString();
    return output;
  }
  const api = { SETTINGS_KEY, RULES_KEY, PROFILE_KEYS, SCHEMA_KEYS, settings, validateImport, profileSnapshot,
    ruleKey, makeRule, ruleMapping, sourceValue, referenceAllowed, enhancedEnumKey, enhancedEquivalent,
    scopedProfile, validateAIValue, cleanApplicationUrl, explicitJobId, possibleApplicationMatches, applyApplicationUpdate };
  root.ResumeEnhancementsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
