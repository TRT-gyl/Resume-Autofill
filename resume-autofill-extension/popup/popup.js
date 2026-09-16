// Popup Script - 用户信息管理与 PDF / HTML 导入

const applicationRecordsCore = globalThis.ApplicationRecordsCore;
let importInProgress = false;

document.addEventListener('DOMContentLoaded', () => {
  loadData();
  applyPendingPdfProfile();
  bindEvents();
});

// ===== 数据加载 =====
function loadData(onLoaded) {
  chrome.storage.local.get(null, result => {
    if (importInProgress && typeof onLoaded !== 'function') return;
    // 首次使用：若从未保存过任何简历数据（无 basic），初始化空白资料
    if (!result.basic) {
      seedDefaultProfile();
      return;
    }

    result = migrateEducationThesis(result);
    result = migrateRemovedPopupFields(result);

    // LLM 配置
    const llm = result.llm || {};
    setVal('llm-baseUrl', llm.baseUrl);
    setVal('llm-apiKey', llm.apiKey);
    setVal('llm-model', llm.model);

    // 基本信息
    const basic = result.basic || {};
    ['name','gender','englishName','idType','birthday','phone','email','location','hukou','nativePlace','ethnicity','political','marital',
     'joinPartyDate','nationality','hukouType','hasOverseas','workYears','availableDate','jobStatus','currentSalary','address','wechat','idCard',
     'height','weight','emergencyName','emergencyPhone','emergencyRelation','isDomesticMobile','healthDesc','graduationDate','freshGraduate','hasRelativeInCompany','photo'
    ].forEach(k => setVal('basic-' + k, basic[k]));
    setVal('basic-website', basic.website || basic.github || '');

    // 教育经历
    renderEducationList(result.education || []);
    // 实习经历
    renderWorkList(result.work || []);
    // 项目经历
    renderProjectList(result.projects || []);
    // 校内职务 / 计算机技能
    renderCampusList(result.campusDuties || []);
    renderComputerList(result.computerSkills || []);

    // 专利 / 论文 / 奖励 / 家庭
    renderPatentList(result.patents || []);
    renderPaperList(result.papers || []);
    renderAwardList(result.awards || []);
    renderFamilyList(result.families || []);

    // 语言能力与资格证书
    renderLanguageList(result.languages);
    setVal('certificates', result.certificates);

    // 求职意向
    const intention = result.jobIntention || {};
    setVal('intention-position', intention.position);
    setVal('intention-salary', intention.salary);
    setVal('intention-city', intention.city);
    setVal('intention-city2', intention.city2);
    setVal('intention-type', intention.type);
    setVal('intention-industry', intention.industry);
    setVal('intention-interviewCity', intention.interviewCity);
    setVal('intention-adjustCity', intention.adjustCity);
    setVal('intention-minSalary', intention.minSalary);
    setVal('intention-obeyAllocate', intention.obeyAllocate);
    setVal('intention-infoChannel', intention.infoChannel);
    setVal('intention-currentAnnual', intention.currentAnnual);

    // 专业技能 / 爱好
    setVal('skills', result.skills);
    setVal('hobbies', result.hobbies);

    // 其他补充信息
    const extra = result.extra || {};
    setVal('extra-operatorExp', extra.operatorExp);
    setVal('extra-jobTransfer', extra.jobTransfer);
    setVal('extra-schoolCity', extra.schoolCity);
    setVal('extra-jobObjective', extra.jobObjective);
    setVal('extra-careerPlan', extra.careerPlan);

    // 自我评价
    setVal('self-evaluation', result.selfEvaluation);
    // 证件照预览
    refreshPhotoPreview();
    if (typeof onLoaded === 'function') onLoaded();
  });
}

// 首次使用：仅初始化空白数据结构
function seedDefaultProfile() {
  chrome.storage.local.set(DEFAULT_PROFILE, () => {
    loadData();
  });
}

function splitLegacyThesisIntro(value) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return { title: '', summary: '' };
  const titleMatch = /(?:本)?论文题目(?:为|是)?[《“"]([^》”"]+)[》”"]/.exec(text);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const summary = titleMatch
    ? text.replace(titleMatch[0], '').replace(/^[，,：:\s]+/, '').trim()
    : text;
  return { title, summary };
}

// 兼容旧版只有一个全局“毕业论文简介”的数据，将其归入最高学历教育记录。
function attachLegacyThesisToEducation(profile) {
  const legacy = splitLegacyThesisIntro(profile?.extra?.thesisIntro);
  if ((!legacy.title && !legacy.summary) || !Array.isArray(profile?.education) || !profile.education.length) {
    return profile;
  }

  const highestIndex = profile.education.findIndex(item => item?.isHighest === '是');
  const targetIndex = highestIndex >= 0 ? highestIndex : 0;
  const education = profile.education.map((item, index) => {
    if (index !== targetIndex) return item;
    return {
      ...item,
      thesisTitle: item?.thesisTitle || legacy.title,
      thesisSummary: item?.thesisSummary || legacy.summary
    };
  });
  return { ...profile, education };
}

function migrateEducationThesis(result) {
  if (result.educationThesisSchemaVersion >= 1) return result;
  const migrated = attachLegacyThesisToEducation(result);
  const versioned = { ...migrated, educationThesisSchemaVersion: 1 };
  const storagePatch = { educationThesisSchemaVersion: 1 };
  if (Array.isArray(versioned.education)) storagePatch.education = versioned.education;
  chrome.storage.local.set(storagePatch);
  return versioned;
}

function stripRecordFields(list, fieldNames) {
  if (!Array.isArray(list)) return list;
  return list.map(item => {
    if (!item || typeof item !== 'object') return item;
    const cleaned = { ...item };
    fieldNames.forEach(fieldName => delete cleaned[fieldName]);
    return cleaned;
  });
}

// 一次性清理已从 popup 删除的旧字段，避免推荐面板继续读取历史残留值。
function migrateRemovedPopupFields(result) {
  const removedExtraFields = ['gaokaoOrigin', 'health', 'customTitle', 'thesisIntro'];
  const hasRemovedFields =
    (result.work || []).some?.(item => item && ('hrContactName' in item || 'hrContactPhone' in item)) ||
    (result.families || []).some?.(item => item && 'department' in item) ||
    (result.papers || []).some?.(item => item && ('achievement' in item || 'coauthorType' in item || 'situation' in item)) ||
    (Array.isArray(result.languages) && result.languages.some(item => item && 'otherLang' in item)) ||
    (typeof result.languages === 'string' && /^\s*其他(?:外语|语种)\s*[:：]/m.test(result.languages)) ||
    (result.extra && typeof result.extra === 'object' && removedExtraFields.some(fieldName => fieldName in result.extra));
  if (result.popupSimplifiedFieldsSchemaVersion >= 2 && !hasRemovedFields) return result;

  const work = stripRecordFields(result.work, ['hrContactName', 'hrContactPhone']);
  const families = stripRecordFields(result.families, ['department']);
  const papers = stripRecordFields(result.papers, ['achievement', 'coauthorType', 'situation']);
  const languages = Array.isArray(result.languages)
    ? stripRecordFields(result.languages, ['otherLang'])
    : typeof result.languages === 'string'
      ? result.languages.split('\n').filter(line => !/^\s*其他(?:外语|语种)\s*[:：]/.test(line)).join('\n')
      : result.languages;
  const extra = result.extra && typeof result.extra === 'object' ? { ...result.extra } : result.extra;
  if (extra && typeof extra === 'object') {
    removedExtraFields.forEach(fieldName => delete extra[fieldName]);
  }
  const storagePatch = { popupSimplifiedFieldsSchemaVersion: 2 };
  if (Array.isArray(work)) storagePatch.work = work;
  if (Array.isArray(families)) storagePatch.families = families;
  if (Array.isArray(papers)) storagePatch.papers = papers;
  if (languages !== undefined) storagePatch.languages = languages;
  if (extra !== undefined) storagePatch.extra = extra;
  chrome.storage.local.set(storagePatch);
  return { ...result, ...storagePatch };
}

function normalizePoliticalValue(value) {
  const text = String(value || '').trim();
  if (/^(中共预备党员|中国共产党预备党员)$/.test(text)) return '中共预备党员';
  if (/^(中共党员|中国共产党党员|中国共产党正式党员)$/.test(text)) return '中共党员';
  if (/^(共青团员|中国共产主义青年团团员)$/.test(text)) return '共青团员';
  return text;
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  let raw = value == null ? '' : String(value).trim();
  if (id === 'basic-political') raw = normalizePoliticalValue(raw);

  if (el.type !== 'date') {
    el.value = raw;
    return;
  }

  const normalized = normalizeDateInputValue(raw);
  el.value = normalized;
  delete el.dataset.legacyDateValue;
  el.removeAttribute('title');

  // 无法转换的旧值（例如“随时”）不能写入 date，但要保留，避免自动保存时丢失。
  if (raw && raw !== '至今' && !normalized) {
    el.dataset.legacyDateValue = raw;
    el.title = `原值：${raw}；请选择具体年月日后替换`;
  }
}

function getVal(id) {
  const el = document.getElementById(id);
  return getInputValue(el);
}

// 中国电信网申日期统一使用 YYYY-MM-DD。旧 YYYY-MM 按当月 1 日兼容。
function normalizeDateInputValue(value) {
  let text = value == null ? '' : String(value).trim();
  if (!text || text === '至今') return '';

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) text = `${compact[1]}-${compact[2]}-${compact[3]}`;

  text = text
    .replace(/[年\/.]/g, '-')
    .replace(/月/g, '-')
    .replace(/日$/g, '')
    .replace(/-+/g, '-');

  const match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T\s].*)?$/.exec(text);
  if (!match) return '';

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] == null ? 1 : Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return '';

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateInputAttributes(value) {
  const raw = value == null ? '' : String(value).trim();
  const normalized = normalizeDateInputValue(raw);
  const attrs = [`value="${esc(normalized)}"`];
  if (raw && raw !== '至今' && !normalized) {
    attrs.push(`data-legacy-date-value="${esc(raw)}"`);
    attrs.push(`title="${esc(`原值：${raw}；请选择具体年月日后替换`)}"`);
  }
  return attrs.join(' ');
}

function getInputValue(el) {
  if (!el) return '';
  const value = String(el.value || '').trim();
  if (value || el.type !== 'date') return value;
  return String(el.dataset.legacyDateValue || '').trim();
}

// ===== 语言能力列表（大学英语六级/四级等，每条含级别、分数、时间） =====
// 兼容旧数据：字符串（每行一项）→ 数组 [{level, score, date}]
function normalizeLanguages(v) {
  if (Array.isArray(v)) return v.filter(x => x && (x.level || x.score || x.date));
  if (v && String(v).trim()) {
    return String(v).trim().split('\n').filter(Boolean).map(line => ({ level: line.trim(), score: '', date: '' }));
  }
  return [];
}

function renderLanguageList(list) {
  const container = document.getElementById('language-list');
  if (!container) return;
  container.innerHTML = '';
  const arr = normalizeLanguages(list);
  if (!arr.length) arr.push({});
  arr.forEach((lang, index) => container.appendChild(createLanguageCard(lang, index)));
}

function createLanguageCard(data, index) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="entry-header">
      <span class="entry-title">语言能力 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row">
      <div class="field"><label>级别/名称</label><input type="text" data-key="level" value="${esc(data.level || '')}" placeholder="如：大学英语六级(CET-6)"></div>
      <div class="field"><label>分数</label><input type="text" data-key="score" value="${esc(data.score || '')}" placeholder="如：550"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>时间</label><input type="date" data-key="date" ${dateInputAttributes(data.date)}></div>
      <div class="field"><label>是否通过</label>
        <select data-key="passed">
          <option value="">请选择</option>
          <option value="是" ${data.passed === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.passed === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>证书名称</label><input type="text" data-key="certName" value="${esc(data.certName || '')}" placeholder="如：大学英语六级证书"></div>
      <div class="field"><label>掌握程度</label><input type="text" data-key="proficiency" value="${esc(data.proficiency || '')}" placeholder="如：听说-熟练 读写-熟练"></div>
    </div>
  `;
  card.querySelector('.btn-remove').addEventListener('click', () => {
    card.remove();
    reindexCards('language-list', '语言能力');
    scheduleSave();
  });
  return card;
}

// 收集语言能力列表数据（过滤全空条目）
function collectLanguages() {
  const container = document.getElementById('language-list');
  if (!container) return [];
  const out = [];
  container.querySelectorAll('.entry-card').forEach(card => {
    const entry = { level: '', score: '', date: '', passed: '', certName: '', proficiency: '' };
    ['level', 'score', 'date', 'passed', 'certName', 'proficiency'].forEach(k => {
      const el = card.querySelector(`[data-key="${k}"]`);
      if (el) entry[k] = getInputValue(el);
    });
    if (entry.level || entry.score || entry.date || entry.passed || entry.certName || entry.proficiency) out.push(entry);
  });
  return out;
}

// ===== 教育经历列表 =====
function renderEducationList(list) {
  const container = document.getElementById('education-list');
  container.innerHTML = '';
  if (list.length === 0) list = [{}];

  list.forEach((edu, index) => {
    container.appendChild(createEducationCard(edu, index));
  });
}

function createEducationCard(data, index) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="entry-header">
      <span class="entry-title">教育经历 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row">
      <div class="field"><label>学校</label><input type="text" data-key="school" value="${esc(data.school)}"></div>
      <div class="field"><label>专业</label><input type="text" data-key="major" value="${esc(data.major)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>学历</label>
        <select data-key="degree">
          <option value="">请选择</option>
          ${['大专', '本科', '硕士', '博士', 'MBA', '其他'].map(d =>
    `<option value="${d}" ${data.degree === d ? 'selected' : ''}>${d}</option>`
  ).join('')}
        </select>
      </div>
      <div class="field"><label>学位</label><input type="text" data-key="degreeTitle" value="${esc(data.degreeTitle)}" placeholder="如：硕士/学士"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>学制</label><input type="text" data-key="duration" value="${esc(data.duration)}" placeholder="如：4年"></div>
      <div class="field"><label>是否统招</label>
        <select data-key="isRegular">
          <option value="">请选择</option>
          <option value="统招" ${data.isRegular === '统招' ? 'selected' : ''}>统招</option>
          <option value="自考" ${data.isRegular === '自考' ? 'selected' : ''}>自考</option>
          <option value="成考" ${data.isRegular === '成考' ? 'selected' : ''}>成考</option>
          <option value="网教" ${data.isRegular === '网教' ? 'selected' : ''}>网教</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>是否最高学历</label>
        <select data-key="isHighest">
          <option value="">请选择</option>
          <option value="是" ${data.isHighest === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.isHighest === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
      <div class="field"><label>院系</label><input type="text" data-key="department" value="${esc(data.department)}" placeholder="如：计算机学院"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>教育类型</label>
        <select data-key="eduType">
          <option value="">请选择</option>
          ${['统分统招', '非定向', '专升本', '成人教育', '海外留学', '其他'].map(d =>
    `<option value="${d}" ${data.eduType === d ? 'selected' : ''}>${d}</option>`
  ).join('')}
        </select>
      </div>
      <div class="field"><label>院校性质</label>
        <select data-key="schoolNature">
          <option value="">请选择</option>
          ${['国内普通院校', '海外院校', '港澳台院校'].map(d =>
    `<option value="${d}" ${data.schoolNature === d ? 'selected' : ''}>${d}</option>`
  ).join('')}
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>是否全日制</label>
        <select data-key="isFulltime">
          <option value="">请选择</option>
          <option value="是" ${data.isFulltime === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.isFulltime === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
      <div class="field"><label>院校所属国家及地区</label><input type="text" data-key="countryRegion" value="${esc(data.countryRegion)}" placeholder="如：中国"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>是否为全日制最高学历</label>
        <select data-key="isFulltimeHighest">
          <option value="">请选择</option>
          <option value="是" ${data.isFulltimeHighest === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.isFulltimeHighest === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
      <div class="field"><label>是否双学位</label>
        <select data-key="isDoubleDegree">
          <option value="">请选择</option>
          <option value="是" ${data.isDoubleDegree === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.isDoubleDegree === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>是否最高学位</label>
        <select data-key="isHighestDegree">
          <option value="">请选择</option>
          <option value="是" ${data.isHighestDegree === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.isHighestDegree === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
      <div class="field"><label>是否主学习经历</label>
        <select data-key="isMainStudy">
          <option value="">请选择</option>
          <option value="是" ${data.isMainStudy === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.isMainStudy === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>研究方向</label><input type="text" data-key="researchArea" value="${esc(data.researchArea)}" placeholder="如：软件工程、信息系统"></div>
    </div>
    <div class="field"><label>专业描述</label><textarea data-key="majorDesc" rows="2" placeholder="专业简介/主要学习内容...">${esc(data.majorDesc)}</textarea></div>
    <div class="field-row">
      <div class="field"><label>GPA/排名</label><input type="text" data-key="gpa" value="${esc(data.gpa)}" placeholder="如：3.8/4.0 或 Top 10%"></div>
      <div class="field"><label>年级排名</label><input type="text" data-key="rank" value="${esc(data.rank)}" placeholder="如：前10%、其它"></div>
      <div class="field"><label>班级或年级综合排名(排名/总人数)</label><input type="text" data-key="comprehensiveRank" value="${esc(data.comprehensiveRank)}" placeholder="如：3/40"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>必修课平均分</label><input type="text" data-key="avgScore" value="${esc(data.avgScore)}" placeholder="如：89.4"></div>
      <div class="field"><label>专业课程</label><input type="text" data-key="courses" value="${esc(data.courses)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>开始时间</label><input type="date" data-key="startDate" ${dateInputAttributes(data.startDate)}></div>
      <div class="field"><label>结束时间</label>
        <div class="date-with-present">
          <input type="date" data-key="endDate" ${dateInputAttributes(data.endDate)} ${data.endDate === '至今' ? 'disabled' : ''}>
          <label class="present-label"><input type="checkbox" data-key="isPresent" ${data.endDate === '至今' ? 'checked' : ''}> 至今</label>
        </div>
      </div>
    </div>
    <div class="field"><label>在校经历</label><textarea data-key="description" rows="2">${esc(data.description)}</textarea></div>
    <div class="field"><label>毕业论文名称</label><input type="text" data-key="thesisTitle" value="${esc(data.thesisTitle)}" placeholder="请输入该教育经历对应的毕业论文名称"></div>
    <div class="field"><label>毕业论文核心概述</label><textarea data-key="thesisSummary" rows="3" placeholder="概述研究问题、核心方法与主要成果...">${esc(data.thesisSummary)}</textarea></div>
    <div class="field"><label>获奖/荣誉</label><textarea data-key="awards" rows="2" placeholder="奖学金、竞赛获奖等...">${esc(data.awards)}</textarea></div>
    <div class="field"><label>论文/专利</label><textarea data-key="publications" rows="1" placeholder="论文标题、专利号...">${esc(data.publications)}</textarea></div>
  `;

  card.querySelector('.btn-remove').addEventListener('click', () => {
    card.remove();
    reindexCards('education-list', '教育经历');
    scheduleSave();
  });

  return card;
}

// ===== 实习经历列表 =====
function renderWorkList(list) {
  const container = document.getElementById('work-list');
  container.innerHTML = '';
  if (list.length === 0) list = [{}];

  list.forEach((work, index) => {
    container.appendChild(createWorkCard(work, index));
  });
}

function createWorkCard(data, index) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="entry-header">
      <span class="entry-title">实习经历 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row field-row-3">
      <div class="field"><label>公司</label><input type="text" data-key="company" value="${esc(data.company)}"></div>
      <div class="field"><label>部门</label><input type="text" data-key="department" value="${esc(data.department)}"></div>
      <div class="field"><label>职位</label><input type="text" data-key="position" value="${esc(data.position)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>工作类型</label>
        <select data-key="type">
          <option value="">请选择</option>
          <option value="全职" ${data.type === '全职' ? 'selected' : ''}>全职</option>
          <option value="实习" ${data.type === '实习' ? 'selected' : ''}>实习</option>
          <option value="兼职" ${data.type === '兼职' ? 'selected' : ''}>兼职</option>
        </select>
      </div>
      <div class="field"><label>工作城市</label><input type="text" data-key="city" value="${esc(data.city)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>开始时间</label><input type="date" data-key="startDate" ${dateInputAttributes(data.startDate)}></div>
      <div class="field"><label>结束时间</label>
        <div class="date-with-present">
          <input type="date" data-key="endDate" ${dateInputAttributes(data.endDate)} ${data.endDate === '至今' ? 'disabled' : ''}>
          <label class="present-label"><input type="checkbox" data-key="isPresent" ${data.endDate === '至今' ? 'checked' : ''}> 至今</label>
        </div>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>企业性质</label>
        <select data-key="companyNature">
          <option value="">请选择</option>
          ${['国有企业', '事业单位', '国内上市公司', '私营/民营企业', '中外合营（合资/合作）', '外商独资/外企办事处', '政府机关/非营利机构'].map(d =>
    `<option value="${d}" ${data.companyNature === d ? 'selected' : ''}>${d}</option>`
  ).join('')}
        </select>
      </div>
      <div class="field"><label>税前职位月薪(元)</label><input type="text" data-key="monthlySalary" value="${esc(data.monthlySalary)}" placeholder="如：8000"></div>
    </div>
    <div class="field"><label>工作描述</label><textarea data-key="description" rows="3">${esc(data.description)}</textarea></div>
    <div class="field-row">
      <div class="field"><label>证明人姓名</label><input type="text" data-key="certifierName" value="${esc(data.certifierName)}"></div>
      <div class="field"><label>证明人关系</label><input type="text" data-key="certifierRelation" value="${esc(data.certifierRelation)}" placeholder="如：直属领导"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>证明人职务</label><input type="text" data-key="certifierDuty" value="${esc(data.certifierDuty)}"></div>
      <div class="field"><label>证明人单位</label><input type="text" data-key="certifierCompany" value="${esc(data.certifierCompany)}"></div>
    </div>
    <div class="field"><label>证明人联系方式</label><input type="text" data-key="certifierContact" value="${esc(data.certifierContact)}"></div>
  `;

  card.querySelector('.btn-remove').addEventListener('click', () => {
    card.remove();
    reindexCards('work-list', '实习经历');
    scheduleSave();
  });

  return card;
}

// ===== 项目经历列表 =====
function renderProjectList(list) {
  const container = document.getElementById('project-list');
  container.innerHTML = '';
  if (list.length === 0) list = [{}];

  list.forEach((proj, index) => {
    container.appendChild(createProjectCard(proj, index));
  });
}

function createProjectCard(data, index) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="entry-header">
      <span class="entry-title">项目经历 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row">
      <div class="field"><label>项目名称</label><input type="text" data-key="projectName" value="${esc(data.projectName)}"></div>
      <div class="field"><label>担任角色</label><input type="text" data-key="role" value="${esc(data.role)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>所在公司</label><input type="text" data-key="company" value="${esc(data.company)}" placeholder="如：示例大学A"></div>
      <div class="field"><label>技术栈</label><input type="text" data-key="techStack" value="${esc(data.techStack)}" placeholder="React, Node.js, MySQL"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>开始时间</label><input type="date" data-key="startDate" ${dateInputAttributes(data.startDate)}></div>
      <div class="field"><label>结束时间</label>
        <div class="date-with-present">
          <input type="date" data-key="endDate" ${dateInputAttributes(data.endDate)} ${data.endDate === '至今' ? 'disabled' : ''}>
          <label class="present-label"><input type="checkbox" data-key="isPresent" ${data.endDate === '至今' ? 'checked' : ''}> 至今</label>
        </div>
      </div>
    </div>
    <div class="field"><label>项目描述</label><textarea data-key="description" rows="3">${esc(data.description)}</textarea></div>
    <div class="field"><label>项目职责（选填）</label><textarea data-key="responsibilities" rows="3" placeholder="填写本人在项目中负责的具体工作">${esc(data.responsibilities)}</textarea></div>
  `;

  card.querySelector('.btn-remove').addEventListener('click', () => {
    card.remove();
    reindexCards('project-list', '项目经历');
    scheduleSave();
  });

  return card;
}

// ===== 校内职务列表（移动/电信：组织团体、担任职务、干部级别、职责成就） =====
function renderCampusList(list) {
  const container = document.getElementById('campus-list');
  container.innerHTML = '';
  if (!list.length) list = [{}];
  list.forEach((item, index) => container.appendChild(createCampusCard(item, index)));
}

function createCampusCard(data, index) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="entry-header">
      <span class="entry-title">校内职务 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row">
      <div class="field"><label>组织团体名称</label><input type="text" data-key="organization" value="${esc(data.organization)}" placeholder="如：示例大学B"></div>
      <div class="field"><label>担任职务</label><input type="text" data-key="duty" value="${esc(data.duty)}" placeholder="如：班级团支书"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>干部级别</label><input type="text" data-key="cadreLevel" value="${esc(data.cadreLevel)}" placeholder="如：班级/院系/校级"></div>
    </div>
    <div class="field"><label>职责和成就</label><textarea data-key="achievement" rows="2">${esc(data.achievement)}</textarea></div>
  `;
  card.querySelector('.btn-remove').addEventListener('click', () => {
    card.remove();
    reindexCards('campus-list', '校内职务');
    scheduleSave();
  });
  return card;
}

// ===== 计算机技能列表（移动：技能类别 + 技能描述） =====
function renderComputerList(list) {
  const container = document.getElementById('computer-list');
  container.innerHTML = '';
  if (!list.length) list = [{}];
  list.forEach((item, index) => container.appendChild(createComputerCard(item, index)));
}

function createComputerCard(data, index) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="entry-header">
      <span class="entry-title">计算机技能 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row">
      <div class="field"><label>技能类别</label>
        <select data-key="skillType">
          <option value="">请选择</option>
          ${['办公应用软件', '开发编程类', '大数据类', '多媒体设计类', '财务管理类', '其他技能'].map(d =>
    `<option value="${d}" ${data.skillType === d ? 'selected' : ''}>${d}</option>`
  ).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>技能描述</label><textarea data-key="description" rows="2">${esc(data.description)}</textarea></div>
  `;
  card.querySelector('.btn-remove').addEventListener('click', () => {
    card.remove();
    reindexCards('computer-list', '计算机技能');
    scheduleSave();
  });
  return card;
}

function reindexCards(containerId, prefix) {
  const cards = document.querySelectorAll(`#${containerId} .entry-card`);
  cards.forEach((card, i) => {
    card.dataset.index = i;
    card.querySelector('.entry-title').textContent = `${prefix} ${i + 1}`;
  });
}

// ===== 收集表单数据 =====
function collectFormData() {
  const profileLink = getVal('basic-website');
  const data = {
    llm: {
      baseUrl: getVal('llm-baseUrl'),
      apiKey: getVal('llm-apiKey'),
      model: getVal('llm-model')
    },
    basic: {
      name: getVal('basic-name'),
      gender: getVal('basic-gender'),
      englishName: getVal('basic-englishName'),
      idType: getVal('basic-idType'),
      birthday: getVal('basic-birthday'),
      phone: getVal('basic-phone'),
      email: getVal('basic-email'),
      location: getVal('basic-location'),
      hukou: getVal('basic-hukou'),
      nativePlace: getVal('basic-nativePlace'),
      ethnicity: getVal('basic-ethnicity'),
      political: getVal('basic-political'),
      marital: getVal('basic-marital'),
      joinPartyDate: getVal('basic-joinPartyDate'),
      nationality: getVal('basic-nationality'),
      hukouType: getVal('basic-hukouType'),
      hasOverseas: getVal('basic-hasOverseas'),
      workYears: getVal('basic-workYears'),
      availableDate: getVal('basic-availableDate'),
      jobStatus: getVal('basic-jobStatus'),
      currentSalary: getVal('basic-currentSalary'),
      address: getVal('basic-address'),
      website: profileLink,
      github: /^(?:https?:\/\/)?(?:www\.)?github\.com(?:\/|$)/i.test(profileLink) ? profileLink : '',
      wechat: getVal('basic-wechat'),
      idCard: getVal('basic-idCard'),
      height: getVal('basic-height'),
      weight: getVal('basic-weight'),
      emergencyName: getVal('basic-emergencyName'),
      emergencyPhone: getVal('basic-emergencyPhone'),
      emergencyRelation: getVal('basic-emergencyRelation'),
      isDomesticMobile: getVal('basic-isDomesticMobile'),
      healthDesc: getVal('basic-healthDesc'),
      graduationDate: getVal('basic-graduationDate'),
      freshGraduate: getVal('basic-freshGraduate'),
      hasRelativeInCompany: getVal('basic-hasRelativeInCompany'),
      photo: getVal('basic-photo')
    },
    education: collectEntries('education-list', ['school', 'major', 'degree', 'degreeTitle', 'duration', 'isRegular', 'isHighest', 'department', 'gpa', 'rank', 'comprehensiveRank', 'avgScore', 'courses', 'startDate', 'endDate', 'description', 'thesisTitle', 'thesisSummary', 'awards', 'publications', 'eduType', 'schoolNature', 'isFulltime', 'countryRegion', 'isFulltimeHighest', 'isDoubleDegree', 'isHighestDegree', 'isMainStudy', 'researchArea', 'majorDesc']),
    work: collectEntries('work-list', ['company', 'department', 'position', 'type', 'city', 'startDate', 'endDate', 'description', 'companyNature', 'monthlySalary', 'certifierName', 'certifierRelation', 'certifierDuty', 'certifierCompany', 'certifierContact']),
    projects: collectEntries('project-list', ['projectName', 'role', 'company', 'techStack', 'startDate', 'endDate', 'description', 'responsibilities']),
    campusDuties: collectEntries('campus-list', ['organization', 'duty', 'cadreLevel', 'achievement']),
    computerSkills: collectEntries('computer-list', ['skillType', 'description']),
    patents: collectListData('patent-list', {
      type: '.patent-type', name: '.patent-name', stage: '.patent-stage', authorRank: '.patent-rank'
    }),
    papers: collectListData('paper-list', {
      title: '.paper-title', publishDate: '.paper-date', journal: '.paper-journal', level: '.paper-level',
      authorRank: '.paper-rank', status: '.paper-status', impactFactor: '.paper-factor',
      synopsis: '.paper-synopsis', yearIssue: '.paper-year-issue'
    }),
    awards: collectListData('award-list', {
      category: '.award-category', name: '.award-name', level: '.award-level', grade: '.award-grade',
      date: '.award-date', issuer: '.award-issuer', school: '.award-school', isCadre: '.award-cadre',
      cadreDesc: '.award-cadredesc', summary: '.award-summary'
    }),
    families: collectListData('family-list', {
      name: '.family-name', relation: '.family-relation', inTelecom: '.family-telecom',
      workUnit: '.family-work', position: '.family-position', gender: '.family-gender',
      phone: '.family-phone', livePlace: '.family-live', political: '.family-political'
    }),
    languages: collectLanguages(),
    certificates: getVal('certificates'),
    skills: getVal('skills'),
    hobbies: getVal('hobbies'),
    jobIntention: {
      position: getVal('intention-position'),
      salary: getVal('intention-salary'),
      city: getVal('intention-city'),
      city2: getVal('intention-city2'),
      type: getVal('intention-type'),
      industry: getVal('intention-industry'),
      interviewCity: getVal('intention-interviewCity'),
      adjustCity: getVal('intention-adjustCity'),
      minSalary: getVal('intention-minSalary'),
      obeyAllocate: getVal('intention-obeyAllocate'),
      infoChannel: getVal('intention-infoChannel'),
      currentAnnual: getVal('intention-currentAnnual')
    },
    // 仅保存 popup 中仍可编辑的补充字段。
    extra: {
      operatorExp: getVal('extra-operatorExp'),
      jobTransfer: getVal('extra-jobTransfer'),
      schoolCity: getVal('extra-schoolCity'),
      jobObjective: getVal('extra-jobObjective'),
      careerPlan: getVal('extra-careerPlan')
    },
    selfEvaluation: getVal('self-evaluation')
  };

  return data;
}

function collectEntries(containerId, keys) {
  const cards = document.querySelectorAll(`#${containerId} .entry-card`);
  const entries = [];

  cards.forEach(card => {
    const entry = {};
    let hasValue = false;

    keys.forEach(key => {
      const el = card.querySelector(`[data-key="${key}"]`);
      if (el) {
        entry[key] = getInputValue(el);
        if (entry[key]) hasValue = true;
      }
    });

    // 检查"至今"复选框
    const presentCheckbox = card.querySelector('[data-key="isPresent"]');
    if (presentCheckbox && presentCheckbox.checked) {
      entry.endDate = '至今';
      hasValue = true;
    }

    if (hasValue) entries.push(entry);
  });

  return entries;
}

// 通用列表数据收集（专利/论文/奖励/家庭）
function collectListData(listId, selectors) {
  const container = document.getElementById(listId);
  if (!container) return [];
  const cards = container.querySelectorAll('.item-card');
  return Array.from(cards).map(card => {
    const id = parseInt(card.dataset.id) || Date.now() + Math.floor(Math.random() * 1000);
    const item = { id };
    for (const [key, selector] of Object.entries(selectors)) {
      const el = card.querySelector(selector);
      item[key] = getInputValue(el);
    }
    return item;
  });
}

// ===== 自动保存（防抖） =====
let saveTimer = null;
let statusTimer = null;

function saveData() {
  if (importInProgress) return;
  const data = collectFormData();
  chrome.storage.local.set(data, () => {
    showStatus('save-status', '已自动保存 ✓', 'success');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => showStatus('save-status', '', ''), 1500);
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 800);
}

// 弹窗关闭/隐藏前兜底保存，避免防抖窗口内的数据丢失
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(saveTimer);
    saveData();
  }
});

function showStatus(id, text, type) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `status ${type}`;
}

// ===== PDF 导入 =====
async function handlePDFImport(file) {
  showStatus('pdf-status', '正在解析 PDF...', 'loading');

  try {
    const arrayBuffer = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }

    if (!fullText.trim()) {
      showStatus('pdf-status', 'PDF 内容为空或无法提取文本', 'error');
      return;
    }

    showStatus('pdf-status', '正在调用 AI 解析简历...', 'loading');

    const response = await chrome.runtime.sendMessage({
      type: 'PARSE_PDF',
      text: fullText
    });

    if (response.error) {
      showStatus('pdf-status', response.error, 'error');
      return;
    }

    await applyImportedProfile(response.profile, 'PDF 导入前');
    chrome.storage.local.remove('pendingPdfProfile');
    showStatus('pdf-status', '解析成功！已自动保存', 'success');
    setTimeout(() => showStatus('pdf-status', '', ''), 4000);
  } catch (err) {
    showStatus('pdf-status', `解析失败: ${err.message}`, 'error');
    console.error('[PDF 解析]', err);
  }
}

// 弹窗重新打开时，应用上次解析期间被关闭的 PDF 结果
function applyPendingPdfProfile() {
  chrome.storage.local.get('pendingPdfProfile', result => {
    if (!result.pendingPdfProfile) return;
    const modal = document.getElementById('pdf-confirm-modal');
    document.getElementById('pdf-confirm-text').textContent = '检测到上次未完成的 PDF 解析结果，是否应用到表单？';
    modal.style.display = 'flex';
    document.getElementById('pdf-confirm-confirm').onclick = async () => {
      try {
        await applyImportedProfile(result.pendingPdfProfile, 'PDF 结果应用前');
        await chrome.storage.local.remove('pendingPdfProfile');
        modal.style.display = 'none';
        showStatus('save-status', '已应用上次未完成的 PDF 解析结果', 'success');
      } catch (error) { showStatus('save-status', error.message, 'error'); }
    };
    document.getElementById('pdf-confirm-cancel').onclick = () => {
      chrome.storage.local.remove('pendingPdfProfile');
      modal.style.display = 'none';
      showStatus('save-status', '已放弃上次的解析结果', '');
      setTimeout(() => showStatus('save-status', '', ''), 3000);
    };
  });
}

// ===== HTML 简历导入（本地解析，无需 AI） =====
function handleHTMLImport(file) {
  showStatus('pdf-status', '正在解析 HTML 简历...', 'loading');
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const htmlText = e.target.result;
      const lines = extractTextLinesFromHTML(htmlText);
      const profile = parseResumeText(lines);
      if (!profile.basic || !profile.basic.name) {
        showStatus('pdf-status', '未能从 HTML 中识别到简历信息', 'error');
        return;
      }
      await applyImportedProfile(profile, 'HTML 导入前');
      showStatus('pdf-status', 'HTML 简历解析成功！已填充并保存', 'success');
      setTimeout(() => showStatus('pdf-status', '', ''), 4000);
    } catch (err) {
      showStatus('pdf-status', `HTML 解析失败: ${err.message}`, 'error');
      console.error('[HTML 解析]', err);
    }
  };
  reader.readAsText(file, 'utf-8');
}

// 从保存的中国电信招聘简历页 HTML 中提取文本行
function extractTextLinesFromHTML(src) {
  let s = src;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(div|p|li|tr|h[1-6]|section|label|span)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  const decode = str => str
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  s = decode(s);
  return s.split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
}

// HTML 简历解析（标签 -> 插件数据结构）
const HTML_SECTION_HEADERS = ['个人基本信息', '教育经历', '实习经历', '项目经验', '校内职务', '计算机技能', '专利发表', '论文发表', '奖励荣誉', '技能/爱好', '家庭关系', '自我评价', '最高学历学籍在线验证报告'];
const HTML_NOISE = new Set(['收起', '展开更多', '点击放大', '修改简历', '立即投递']);
const HTML_ENTRY_START = {
  '教育经历': '入学时间', '实习经历': '开始时间', '项目经验': '开始时间',
  '校内职务': ['组织团体名称', '组织名称'], '计算机技能': '技能类别',
  '专利发表': '专利类型', '论文发表': '论文名称', '奖励荣誉': '奖项类别', '家庭关系': '姓名'
};
const HTML_MULTILINE = new Set(['工作描述', '项目描述', '专业课程', '其他IT技能水平', '评价内容', '职责和成就', '技能描述', '简要描述', '内容提要', '毕业论文核心概述', '核心概述', '职业规划']);
const isLabelOnlyLine = l => /^[\u4e00-\u9fa5A-Za-z0-9/（）()]{1,20}[：:]$/.test(l.trim());
const stripLabel = l => l.replace(/[：:]$/, '').trim();
const HTML_TOP_LABELS = {
  '期望工作性质': ['jobIntention', 'type'], '期望工作地点': ['jobIntention', 'city'],
  '期望工作地点2': ['jobIntention', 'city2'], '期望薪酬': ['jobIntention', 'salary'],
  '期望面试地点': ['jobIntention', 'interviewCity'], '调剂工作城市': ['jobIntention', 'adjustCity'],
  '税前月薪最低要求': ['jobIntention', 'minSalary'], '是否服从公司调剂': ['jobIntention', 'obeyAllocate'],
  '到岗时间': ['basic', 'availableDate'], '信息渠道': ['jobIntention', 'infoChannel']
};
const HTML_LABEL_MAP = {
  top: {
    '期望工作性质': ['jobIntention', 'type'], '期望工作地点': ['jobIntention', 'city'],
    '期望工作地点2': ['jobIntention', 'city2'], '期望薪酬': ['jobIntention', 'salary'],
    '期望面试地点': ['jobIntention', 'interviewCity'], '调剂工作城市': ['jobIntention', 'adjustCity'],
    '税前月薪最低要求': ['jobIntention', 'minSalary'], '是否服从公司调剂': ['jobIntention', 'obeyAllocate'],
    '到岗时间': ['basic', 'availableDate'], '信息渠道': ['jobIntention', 'infoChannel']
  },
  '个人基本信息': {
    '证件号码': ['basic', 'idCard'], '证件类型': ['basic', 'idType'], '出生日期': ['basic', 'birthday'],
    '民族': ['basic', 'ethnicity'], '英文名': ['basic', 'englishName'], '国籍': ['basic', 'nationality'],
    '户口类型': ['basic', 'hukouType'], '入党团时间': ['basic', 'joinPartyDate'],
    '籍贯': ['basic', 'nativePlace'], '健康说明': ['basic', 'healthDesc'],
    '户口所在地': ['basic', 'hukou'],
    '现居住城市': ['basic', 'location'], '就读院校所在城市': ['extra', 'schoolCity'],
    '是否为应届毕业生': ['basic', 'freshGraduate'], '毕业时间': ['basic', 'graduationDate'],
    '是否有运营商实习经验': ['extra', 'operatorExp'], '是否接受岗位调剂': ['extra', 'jobTransfer'],
    '通信地址': ['basic', 'address'], '紧急联系人姓名': ['basic', 'emergencyName'],
    '紧急联系方式': ['basic', 'emergencyPhone'], '紧急联系人关系': ['basic', 'emergencyRelation'],
    '是否为国内号码': ['basic', 'isDomesticMobile'], '有无海外留学经历': ['basic', 'hasOverseas'],
    '是否有亲属在中国电信集团（系统）从业': ['basic', 'hasRelativeInCompany'],
    '是否有亲属受雇于本公司': ['basic', 'hasRelativeInCompany'],
    '政治面貌': ['basic', 'political']
  },
  '教育经历': {
    '入学时间': 'startDate', '毕业时间': 'endDate', '学校名称': 'school', '是否最高学历': 'isHighest',
    '学历': 'degree', '学位': 'degreeTitle', '学制': 'duration', '受教育类型': 'isRegular',
    '教育类型': 'eduType', '院校性质': 'schoolNature', '是否全日制': 'isFulltime',
    '院校所属国家及地区': 'countryRegion', '是否为全日制最高学历': 'isFulltimeHighest',
    '是否双学位': 'isDoubleDegree', '是否最高学位': 'isHighestDegree', '是否主学习经历': 'isMainStudy',
    '院系': 'department', '专业名称': 'major', '研究方向': 'researchArea', '年级排名': 'rank',
    '班级或年级综合排名(排名/总人数)': 'comprehensiveRank',
    '班级或年级综合排名（排名/总人数）': 'comprehensiveRank', '综合排名': 'comprehensiveRank',
    '必修课平均分': 'avgScore', '专业课程': 'courses', '专业描述': 'majorDesc',
    '毕业论文名称': 'thesisTitle', '毕业论文题目': 'thesisTitle',
    '毕业论文核心概述': 'thesisSummary', '核心概述': 'thesisSummary'
  },
  '实习经历': {
    '开始时间': 'startDate', '结束时间': 'endDate', '企业名称': 'company', '企业性质': 'companyNature',
    '职位名称': 'position', '工作描述': 'description', '税前职位月薪': 'monthlySalary',
    '证明人姓名': 'certifierName', '证明人关系': 'certifierRelation', '证明人职务': 'certifierDuty',
    '证明人单位': 'certifierCompany', '证明人联系方式': 'certifierContact'
  },
  '项目经验': {
    '开始时间': 'startDate', '结束时间': 'endDate', '项目名称': 'projectName', '项目职务': 'role',
    '所在公司': 'company', '项目描述': 'description', '项目职责': 'responsibilities'
  },
  '校内职务': { '组织团体名称': 'organization', '组织名称': 'organization', '担任职务': 'duty', '干部级别': 'cadreLevel', '职责和成就': 'achievement' },
  '计算机技能': { '技能类别': 'skillType', '技能描述': 'description' },
  '专利发表': { '专利类型': 'type', '专利名称': 'name', '发表阶段': 'stage', '作者排序': 'authorRank' },
  '论文发表': {
    '论文名称': 'title', '接收/发表日期': 'publishDate', '期刊或会议名称': 'journal',
    '期刊或会议水平': 'level', '作者排序': 'authorRank', '论文发表状态': 'status', '影响因子': 'impactFactor',
    '内容提要': 'synopsis', '年度/期次': 'yearIssue'
  },
  '奖励荣誉': { '奖项类别': 'category', '奖励名称': 'name', '奖励级别': 'level', '奖励等级': 'grade', '获奖时间': 'date', '颁发单位': 'issuer', '所在学校': 'school', '是否学生干部': 'isCadre', '简要描述': 'summary' },
  '家庭关系': { '姓名': 'name', '关系': 'relation', '性别': 'gender', '是否在电信集团及下属单位工作': 'inTelecom', '是否移动系统内任职': 'inTelecom', '工作单位': 'workUnit', '亲属职务/岗位（含层级）': 'position', '联系电话': 'phone', '现居住地址': 'livePlace', '政治面貌': 'political' },
  '技能/爱好': {
    '英语水平': 'englishLevel', '英语成绩得分': 'englishScore',
    'IT技能': 'itSkill', 'IT技能掌握程度': 'itSkillLevel', '其他IT技能水平': 'itSkillDetail', '个人爱好': 'hobbies'
  },
  '自我评价': { '评价内容': 'selfEvaluation', '职业目标': ['extra', 'jobObjective'], '职业规划': ['extra', 'careerPlan'] }
};
const HTML_SECTION_ARRAYS = { '教育经历': 'education', '实习经历': 'work', '项目经验': 'projects', '校内职务': 'campusDuties', '计算机技能': 'computerSkills', '专利发表': 'patents', '论文发表': 'papers', '奖励荣誉': 'awards', '家庭关系': 'families' };

function parseResumeText(lines) {
  const profile = {
    basic: {}, education: [], work: [], projects: [],
    patents: [], papers: [], awards: [], families: [],
    languages: '', certificates: '', skills: '', hobbies: '',
    jobIntention: {}, extra: {}, selfEvaluation: ''
  };
  const setAt = (target, path, value) => {
    if (Array.isArray(path)) target[path[0]][path[1]] = value;
    else target[path] = value;
  };

  let section = null, cur = null, skTemp = null, topCount = 0;
  let last = null, lastIsMulti = false;

  const flushLast = () => {
    if (!last) return;
    if (lastIsMulti && last.buf) setAt(last.target, last.path, last.buf.join('\n'));
    else if (!lastIsMulti && last.value != null) setAt(last.target, last.path, last.value);
    last = null; lastIsMulti = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (HTML_NOISE.has(l)) continue;
    if (/^中国电信招聘/.test(l)) continue;

    if (HTML_SECTION_HEADERS.includes(l)) {
      flushLast();
      section = l;
      if (l === '最高学历学籍在线验证报告') break;
      if (HTML_SECTION_ARRAYS[l]) cur = null;
      else if (l === '个人基本信息') cur = profile.basic;
      else if (l === '技能/爱好') { cur = skTemp = {}; }
      else if (l === '自我评价') cur = profile;
      continue;
    }

    const inline = l.match(/^(电话|邮箱|学校|学历)[：:](.+)$/);
    if (inline) {
      flushLast();
      if (inline[1] === '电话') profile.basic.phone = inline[2].trim();
      if (inline[1] === '邮箱') profile.basic.email = inline[2].trim();
      continue;
    }

    if (isLabelOnlyLine(l)) {
      flushLast();
      const label = stripLabel(l);
      const map = section === null ? HTML_LABEL_MAP.top : (HTML_LABEL_MAP[section] || {});
      const path = map[label];
      if (!path) { last = null; lastIsMulti = false; continue; }

      const entryStart = HTML_ENTRY_START[section];
      if (HTML_SECTION_ARRAYS[section] && (entryStart === label || (Array.isArray(entryStart) && entryStart.includes(label)))) {
        cur = {};
        profile[HTML_SECTION_ARRAYS[section]].push(cur);
      }

      let target;
      if (HTML_SECTION_ARRAYS[section]) target = cur;
      else if (section === '技能/爱好') target = skTemp;
      else target = profile;

      if (HTML_MULTILINE.has(label)) { last = { target, path, buf: [] }; lastIsMulti = true; }
      else { last = { target, path, value: null }; lastIsMulti = false; }
      continue;
    }

    // 顶部摘要区无冒号标签
    if (section === null && HTML_TOP_LABELS[l]) {
      flushLast();
      last = { target: profile, path: HTML_TOP_LABELS[l], value: null };
      lastIsMulti = false;
      continue;
    }

    // 值行
    if (lastIsMulti && last.buf) { last.buf.push(l); continue; }
    if (last && !lastIsMulti && last.value === null) { last.value = l; continue; }

    // 顶部裸行：姓名 / 政治面貌
    if (section === null) {
      if (topCount === 0) { profile.basic.name = l; topCount++; }
      else if (topCount === 1) { if (/(党员|团员|群众|预备)/.test(l)) profile.basic.political = l; topCount++; }
      else topCount++;
    }
  }
  flushLast();

  // ---- 后处理 ----
  const pol = profile.basic.political || '';
  if (pol.includes('预备党员')) profile.basic.political = '中共预备党员';
  else if (pol.includes('党员')) profile.basic.political = '中共党员';
  else if (pol.includes('团员')) profile.basic.political = '共青团员';

  profile.work.forEach(w => { if (!w.type) w.type = '实习'; });

  profile.education.forEach(e => {
    const v = e.isRegular || '';
    if (v.includes('统招')) e.isRegular = '统招';
    else if (v.includes('自考')) e.isRegular = '自考';
    else if (v.includes('成考')) e.isRegular = '成考';
    else if (v.includes('网教')) e.isRegular = '网教';
    else e.isRegular = e.isRegular || '';
    // 学历归一化：硕士研究生 -> 硕士
    if (e.degree && e.degree.includes('研究生')) e.degree = '硕士';
  });

  if (skTemp) {
    const langs = [];
    if (skTemp.englishLevel) langs.push(skTemp.englishLevel + (skTemp.englishScore ? ' ' + skTemp.englishScore + '分' : ''));
    if (langs.length) profile.languages = langs.join('\n');
    const skillParts = [];
    if (skTemp.itSkill) skillParts.push(`${skTemp.itSkill} - ${skTemp.itSkillLevel || ''}`.replace(/\s*-\s*$/, ''));
    if (skTemp.itSkillDetail) skillParts.push(skTemp.itSkillDetail);
    if (skillParts.length) profile.skills = skillParts.join('\n');
    if (skTemp.hobbies) profile.hobbies = skTemp.hobbies;
  }

  return profile;
}

// ===== 用 profile 填充表单 =====
function fillFormFromProfile(profile) {
  if (!profile) return;
  profile = attachLegacyThesisToEducation(profile);

  // 基本信息
  if (profile.basic) {
    ['name','gender','englishName','idType','birthday','phone','email','location','hukou','nativePlace','ethnicity','political','marital',
     'joinPartyDate','nationality','hukouType','hasOverseas','workYears','availableDate','jobStatus','currentSalary','address','wechat','idCard',
     'height','weight','emergencyName','emergencyPhone','emergencyRelation','isDomesticMobile','healthDesc','graduationDate','freshGraduate','hasRelativeInCompany'
    ].forEach(k => setVal('basic-' + k, profile.basic[k]));
    setVal('basic-website', profile.basic.website || profile.basic.github || '');
    // 证件照：仅当导入内容携带照片时才覆盖（HTML/PDF 解析结果不含照片，保留已上传照片）
    if (profile.basic.photo) setVal('basic-photo', profile.basic.photo);
  }

  // 教育经历
  if (Array.isArray(profile.education)) renderEducationList(profile.education);
  // 实习经历
  if (Array.isArray(profile.work)) renderWorkList(profile.work);
  // 项目经历
  if (Array.isArray(profile.projects)) renderProjectList(profile.projects);
  // 校内职务 / 计算机技能
  if (Array.isArray(profile.campusDuties)) renderCampusList(profile.campusDuties);
  if (Array.isArray(profile.computerSkills)) renderComputerList(profile.computerSkills);

  // 专利 / 论文 / 奖励 / 家庭
  if (Array.isArray(profile.patents)) renderPatentList(profile.patents);
  if (Array.isArray(profile.papers)) renderPaperList(profile.papers);
  if (Array.isArray(profile.awards)) renderAwardList(profile.awards);
  if (Array.isArray(profile.families)) renderFamilyList(profile.families);

  // 专业技能 / 爱好
  if (profile.skills) {
    const skillsText = Array.isArray(profile.skills) ? profile.skills.join('\n') : profile.skills;
    setVal('skills', skillsText);
  }
  if (profile.hobbies) setVal('hobbies', profile.hobbies);

  // 语言能力与资格证书
  renderLanguageList(profile.languages);
  if (profile.certificates) {
    const certText = Array.isArray(profile.certificates) ? profile.certificates.join('\n') : profile.certificates;
    setVal('certificates', certText);
  }

  // 求职意向
  if (profile.jobIntention) {
    setVal('intention-position', profile.jobIntention.position);
    setVal('intention-salary', profile.jobIntention.salary);
    setVal('intention-city', profile.jobIntention.city);
    setVal('intention-city2', profile.jobIntention.city2);
    setVal('intention-type', profile.jobIntention.type);
    setVal('intention-industry', profile.jobIntention.industry);
    setVal('intention-interviewCity', profile.jobIntention.interviewCity);
    setVal('intention-adjustCity', profile.jobIntention.adjustCity);
    setVal('intention-minSalary', profile.jobIntention.minSalary);
    setVal('intention-obeyAllocate', profile.jobIntention.obeyAllocate);
    setVal('intention-infoChannel', profile.jobIntention.infoChannel);
    setVal('intention-currentAnnual', profile.jobIntention.currentAnnual);
  }

  // 其他补充信息
  if (profile.extra) {
    setVal('extra-operatorExp', profile.extra.operatorExp);
    setVal('extra-jobTransfer', profile.extra.jobTransfer);
    setVal('extra-schoolCity', profile.extra.schoolCity);
    setVal('extra-jobObjective', profile.extra.jobObjective);
    setVal('extra-careerPlan', profile.extra.careerPlan);
  }

  // 自我评价
  if (profile.selfEvaluation) {
    setVal('self-evaluation', profile.selfEvaluation);
  }

  // 证件照预览
  refreshPhotoPreview();
}

// ===== 证件照 =====
function refreshPhotoPreview() {
  const preview = document.getElementById('photo-preview');
  if (!preview) return;
  const dataUrl = getVal('basic-photo');
  preview.querySelectorAll('img').forEach(img => img.remove());
  const icon = preview.querySelector('.photo-icon');
  const hint = preview.querySelector('.photo-hint');
  const removeBtn = document.getElementById('btn-photo-remove');
  if (dataUrl) {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '证件照';
    preview.insertBefore(img, icon);
    icon.style.display = 'none';
    hint.style.display = 'none';
    if (removeBtn) removeBtn.style.display = '';
  } else {
    icon.style.display = '';
    hint.style.display = '';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

// 读取并压缩为 base64（证件照最长边压缩到 400px、JPEG 0.85，控制存储体积）
function readAndCompressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 400;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            const scale = MAX / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function handlePhotoUpload(file) {
  readAndCompressPhoto(file).then(dataUrl => {
    setVal('basic-photo', dataUrl);
    refreshPhotoPreview();
    scheduleSave();
  }).catch(err => {
    console.error('[证件照]', err);
    showStatus('save-status', '照片处理失败，请换一张图片', 'error');
    setTimeout(() => showStatus('save-status', '', ''), 3000);
  });
}

// ===== 动态列表（专利/论文/奖励/家庭） =====
// 与「项目经历」一致：卡片用 createElement 创建、删除按钮用 addEventListener 绑定，
// 删除/新增直接操作 DOM 后自动保存，不整表重载（避免丢失未保存编辑、规避内联 onclick 被 CSP 拦截）
const itemTemplates = {
  patent: () => ({ id: Date.now(), type: '发明专利', name: '', stage: '申请阶段', authorRank: '前三作者' }),
  paper: () => ({ id: Date.now(), title: '', publishDate: '', journal: '', level: 'EI', authorRank: '第一作者', status: '已发表', impactFactor: '' }),
  award: () => ({ id: Date.now(), category: '竞赛类', name: '', level: '国家级', grade: '一等', date: '', issuer: '' }),
  family: () => ({ id: Date.now(), name: '', relation: '', inTelecom: '否', workUnit: '', position: '' })
};

// 删除动态卡片：移除 DOM 节点 → 重排序号 → 自动保存
function removeItemCard(card, containerId, prefix) {
  card.remove();
  reindexItemCards(containerId, prefix);
  scheduleSave();
}

// 新增动态卡片：直接追加到列表末尾 → 自动保存（不重载整表）
function appendItemCard(containerId, createFn, item, prefix) {
  const container = document.getElementById(containerId);
  const index = container.children.length;
  container.appendChild(createFn(item, index));
  scheduleSave();
}

// 重排动态列表序号
function reindexItemCards(containerId, prefix) {
  const cards = document.querySelectorAll(`#${containerId} .item-card`);
  cards.forEach((card, i) => {
    const title = card.querySelector('.item-title');
    if (title) title.textContent = `${prefix} ${i + 1}`;
  });
}

function createPatentCard(data, index) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.dataset.id = data.id;
  card.innerHTML = `
    <div class="item-header">
      <span class="item-title">专利 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row">
      <div class="field"><label>专利类型</label>
        <select class="patent-type">
          <option value="发明专利" ${data.type === '发明专利' ? 'selected' : ''}>发明专利</option>
          <option value="实用新型" ${data.type === '实用新型' ? 'selected' : ''}>实用新型</option>
          <option value="外观设计" ${data.type === '外观设计' ? 'selected' : ''}>外观设计</option>
        </select>
      </div>
      <div class="field"><label>发表阶段</label>
        <select class="patent-stage">
          <option value="申请阶段" ${data.stage === '申请阶段' ? 'selected' : ''}>申请阶段</option>
          <option value="公开阶段" ${data.stage === '公开阶段' ? 'selected' : ''}>公开阶段</option>
          <option value="授权阶段" ${data.stage === '授权阶段' ? 'selected' : ''}>授权阶段</option>
        </select>
      </div>
    </div>
    <div class="field"><label>专利名称</label><input type="text" class="patent-name" value="${esc(data.name)}"></div>
    <div class="field"><label>作者排序</label><input type="text" class="patent-rank" value="${esc(data.authorRank)}" placeholder="如：前三作者、第一作者"></div>
  `;
  card.querySelector('.btn-remove').addEventListener('click', () => removeItemCard(card, 'patent-list', '专利'));
  return card;
}

function createPaperCard(data, index) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.dataset.id = data.id;
  card.innerHTML = `
    <div class="item-header">
      <span class="item-title">论文 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field"><label>论文名称</label><input type="text" class="paper-title" value="${esc(data.title)}"></div>
    <div class="field-row">
      <div class="field"><label>期刊/会议</label><input type="text" class="paper-journal" value="${esc(data.journal)}"></div>
      <div class="field"><label>水平</label>
        <select class="paper-level">
          <option value="SCI" ${data.level === 'SCI' ? 'selected' : ''}>SCI</option>
          <option value="EI" ${data.level === 'EI' ? 'selected' : ''}>EI</option>
          <option value="核心期刊" ${data.level === '核心期刊' ? 'selected' : ''}>核心期刊</option>
          <option value="CCF-A" ${data.level === 'CCF-A' ? 'selected' : ''}>CCF-A</option>
          <option value="CCF-B" ${data.level === 'CCF-B' ? 'selected' : ''}>CCF-B</option>
          <option value="CCF-C" ${data.level === 'CCF-C' ? 'selected' : ''}>CCF-C</option>
          <option value="国际会议" ${data.level === '国际会议' ? 'selected' : ''}>国际会议</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>发表日期</label><input type="date" class="paper-date" ${dateInputAttributes(data.publishDate)}></div>
      <div class="field"><label>作者排序</label><input type="text" class="paper-rank" value="${esc(data.authorRank)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>发表状态</label>
        <select class="paper-status">
          <option value="已发表" ${data.status === '已发表' ? 'selected' : ''}>已发表</option>
          <option value="在审" ${data.status === '在审' ? 'selected' : ''}>在审</option>
          <option value="已接收" ${data.status === '已接收' ? 'selected' : ''}>已接收</option>
        </select>
      </div>
      <div class="field"><label>影响因子</label><input type="text" class="paper-factor" value="${esc(data.impactFactor)}"></div>
    </div>
    <div class="field"><label>年度/期次</label><input type="text" class="paper-year-issue" value="${esc(data.yearIssue || data.issue || data.volumeIssue)}" placeholder="可选，如 2026 / 第3期；留空时填报使用发表年份"></div>
    <div class="field"><label>内容提要</label><textarea class="paper-synopsis" rows="2">${esc(data.synopsis)}</textarea></div>
  `;
  card.querySelector('.btn-remove').addEventListener('click', () => removeItemCard(card, 'paper-list', '论文'));
  return card;
}

function createAwardCard(data, index) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.dataset.id = data.id;
  card.innerHTML = `
    <div class="item-header">
      <span class="item-title">奖励 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field"><label>奖励名称</label><input type="text" class="award-name" value="${esc(data.name)}"></div>
    <div class="field-row">
      <div class="field"><label>奖项类别</label>
        <select class="award-category">
          <option value="竞赛类" ${data.category === '竞赛类' ? 'selected' : ''}>竞赛类</option>
          <option value="奖学金" ${data.category === '奖学金' ? 'selected' : ''}>奖学金</option>
          <option value="荣誉称号" ${data.category === '荣誉称号' ? 'selected' : ''}>荣誉称号</option>
          <option value="其它" ${data.category === '其它' ? 'selected' : ''}>其它</option>
        </select>
      </div>
      <div class="field"><label>奖励级别</label>
        <select class="award-level">
          <option value="国家级" ${data.level === '国家级' ? 'selected' : ''}>国家级</option>
          <option value="省部级" ${data.level === '省部级' ? 'selected' : ''}>省部级</option>
          <option value="市级" ${data.level === '市级' ? 'selected' : ''}>市级</option>
          <option value="校级" ${data.level === '校级' ? 'selected' : ''}>校级</option>
          <option value="院级" ${data.level === '院级' ? 'selected' : ''}>院级</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>奖励等级</label>
        <select class="award-grade">
          <option value="特等" ${data.grade === '特等' ? 'selected' : ''}>特等</option>
          <option value="一等" ${data.grade === '一等' ? 'selected' : ''}>一等</option>
          <option value="二等" ${data.grade === '二等' ? 'selected' : ''}>二等</option>
          <option value="三等" ${data.grade === '三等' ? 'selected' : ''}>三等</option>
          <option value="其它" ${data.grade === '其它' ? 'selected' : ''}>其它</option>
        </select>
      </div>
      <div class="field"><label>获奖时间</label><input type="date" class="award-date" ${dateInputAttributes(data.date)}></div>
    </div>
    <div class="field-row">
      <div class="field"><label>所在学校</label><input type="text" class="award-school" value="${esc(data.school)}"></div>
      <div class="field"><label>是否学生干部</label>
        <select class="award-cadre">
          <option value="">请选择</option>
          <option value="是" ${data.isCadre === '是' ? 'selected' : ''}>是</option>
          <option value="否" ${data.isCadre === '否' ? 'selected' : ''}>否</option>
        </select>
      </div>
    </div>
    <div class="field"><label>学生干部描述</label><input type="text" class="award-cadredesc" value="${esc(data.cadreDesc)}" placeholder="如：班级团支书"></div>
    <div class="field"><label>颁发单位</label><input type="text" class="award-issuer" value="${esc(data.issuer)}"></div>
    <div class="field"><label>简要描述</label><textarea class="award-summary" rows="2">${esc(data.summary)}</textarea></div>
  `;
  card.querySelector('.btn-remove').addEventListener('click', () => removeItemCard(card, 'award-list', '奖励'));
  return card;
}

function createFamilyCard(data, index) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.dataset.id = data.id;
  card.innerHTML = `
    <div class="item-header">
      <span class="item-title">家庭成员 ${index + 1}</span>
      <button class="btn-remove" title="删除">×</button>
    </div>
    <div class="field-row">
      <div class="field"><label>姓名</label><input type="text" class="family-name" value="${esc(data.name)}"></div>
      <div class="field"><label>关系</label><input type="text" class="family-relation" value="${esc(data.relation)}" placeholder="如：父子、母子"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>性别</label><input type="text" class="family-gender" value="${esc(data.gender)}" placeholder="男/女"></div>
      <div class="field"><label>是否在运营商/系统内任职</label>
        <select class="family-telecom">
          <option value="否" ${(data.inTelecom || '否') === '否' ? 'selected' : ''}>否</option>
          <option value="是" ${data.inTelecom === '是' ? 'selected' : ''}>是</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>工作单位</label><input type="text" class="family-work" value="${esc(data.workUnit)}"></div>
      <div class="field"><label>职务/岗位</label><input type="text" class="family-position" value="${esc(data.position)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>联系电话</label><input type="text" class="family-phone" value="${esc(data.phone)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>现居住地址</label><input type="text" class="family-live" value="${esc(data.livePlace)}" placeholder="如：省-市-区"></div>
      <div class="field"><label>政治面貌</label><input type="text" class="family-political" value="${esc(data.political)}" placeholder="如：群众"></div>
    </div>
  `;
  card.querySelector('.btn-remove').addEventListener('click', () => removeItemCard(card, 'family-list', '家庭成员'));
  return card;
}

function renderPatentList(patents = []) {
  const container = document.getElementById('patent-list');
  container.innerHTML = '';
  patents.forEach((p, i) => container.appendChild(createPatentCard(p, i)));
}

function renderPaperList(papers = []) {
  const container = document.getElementById('paper-list');
  container.innerHTML = '';
  papers.forEach((p, i) => container.appendChild(createPaperCard(p, i)));
}

function renderAwardList(awards = []) {
  const container = document.getElementById('award-list');
  container.innerHTML = '';
  awards.forEach((a, i) => container.appendChild(createAwardCard(a, i)));
}

function renderFamilyList(families = []) {
  const container = document.getElementById('family-list');
  container.innerHTML = '';
  families.forEach((f, i) => container.appendChild(createFamilyCard(f, i)));
}

// ===== JSON 导入/导出 =====
function exportJSON() {
  const data = collectFormData();
  delete data.llm.apiKey;   // 导出文件不含 API Key，避免文件分享泄露密钥
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resume-autofill-data.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 导出 HTML（仿中国电信招聘简历预览版式） =====
function exportHTML() {
  const data = collectFormData();
  const html = buildResumeHtml(data);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.basic.name || '我的'}-个人简历.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// 生成仿中国电信招聘简历预览版式的独立 HTML
function buildResumeHtml(data) {
  const e = esc;
  const basic = data.basic || {};
  const intention = data.jobIntention || {};
  const extra = data.extra || {};

  // 学历名称映射：与电信页面一致（硕士研究生/大学本科…）
  const DEGREE_MAP = { '硕士': '硕士研究生', '博士': '博士研究生', '本科': '大学本科', '大专': '大学专科' };
  const highestEdu = (data.education || []).find(x => x.isHighest === '是') || (data.education || [])[0] || {};
  const degreeName = DEGREE_MAP[highestEdu.degree] || highestEdu.degree || '';

  // 仅保留非空字段的行
  function li(label, value) {
    if (value == null || String(value).trim() === '') return '';
    return `<li class="col-2"><div><label>${label}：</label><span>${e(String(value))}</span></div></li>`;
  }
  // 一段经历/一条记录（左侧虚线时间轴样式，同电信 xueli）
  function recordUl(rows) {
    const inner = rows.filter(Boolean).join('');
    if (!inner) return '';
    return `<ul class="xueli"><p class="round"></p>${inner}</ul>`;
  }
  // 区块（info-list 里的一项，标题 + 内容）
  function section(title, inner) {
    if (!inner) return '';
    return `<li><h1><span> ${title}</span></h1><div>${inner}</div></li>`;
  }

  // ---- 头部期望信息列表 ----
  const headIntention = [
    ['期望工作性质', intention.type],
    ['期望工作地点', intention.city],
    ['期望工作地点2', intention.city2],
    ['到岗时间', basic.availableDate],
    ['期望薪酬', intention.salary]
  ].filter(x => x[1] && String(x[1]).trim()).map(x => `<li><span>${e(x[0])}</span><p>${e(x[1])}</p></li>`).join('');

  // ---- 个人基本信息 ----
  const basicRows = [
    li('姓名', basic.name), li('性别', basic.gender), li('英文名', basic.englishName),
    li('证件类型', basic.idType), li('证件号码', basic.idCard), li('出生日期', basic.birthday),
    li('民族', basic.ethnicity), li('政治面貌', basic.political), li('入党团时间', basic.joinPartyDate),
    li('籍贯', basic.nativePlace), li('国籍', basic.nationality), li('户籍所在地', basic.hukou),
    li('户口类型', basic.hukouType), li('现居住城市', basic.location),
    li('就读院校所在城市', extra.schoolCity),
    li('健康说明', basic.healthDesc), li('婚姻状况', basic.marital),
    li('身高(cm)', basic.height), li('体重(kg)', basic.weight),
    li('是否为应届毕业生', basic.freshGraduate), li('毕业时间', basic.graduationDate),
    li('是否有运营商实习经验', extra.operatorExp), li('是否接受岗位调剂', extra.jobTransfer),
    li('有无海外留学经历', basic.hasOverseas), li('是否为国内号码', basic.isDomesticMobile),
    li('通信地址', basic.address), li('紧急联系人姓名', basic.emergencyName),
    li('紧急联系方式', basic.emergencyPhone), li('紧急联系人关系', basic.emergencyRelation)
  ].join('');

  // ---- 教育经历 ----
  const eduRows = (data.education || []).map(x => recordUl([
    li('入学时间', x.startDate), li('毕业时间', x.endDate), li('学校名称', x.school),
    li('是否最高学历', x.isHighest), li('学历', x.degree), li('学位', x.degreeTitle),
    li('学制', x.duration), li('受教育类型', x.isRegular), li('教育类型', x.eduType),
    li('院校性质', x.schoolNature), li('是否全日制', x.isFulltime), li('院校所属国家及地区', x.countryRegion),
    li('是否为全日制最高学历', x.isFulltimeHighest), li('是否双学位', x.isDoubleDegree),
    li('是否最高学位', x.isHighestDegree), li('是否主学习经历', x.isMainStudy),
    li('院系', x.department), li('专业名称', x.major), li('研究方向', x.researchArea),
    li('GPA', x.gpa), li('年级排名', x.rank),
    li('班级或年级综合排名(排名/总人数)', x.comprehensiveRank), li('必修课平均分', x.avgScore),
    li('专业课程', x.courses), li('专业描述', x.majorDesc), li('在校经历', x.description),
    li('毕业论文名称', x.thesisTitle), li('毕业论文核心概述', x.thesisSummary)
  ])).join('');

  // ---- 求职意向 ----
  const intentionRows = [
    li('期望职位', intention.position), li('期望薪资', intention.salary),
    li('期望城市', intention.city), li('期望城市2', intention.city2),
    li('期望面试地点', intention.interviewCity), li('调剂工作城市', intention.adjustCity),
    li('工作类型', intention.type), li('期望行业', intention.industry),
    li('税前月薪最低要求', intention.minSalary), li('是否服从公司调剂', intention.obeyAllocate),
    li('目前年薪', intention.currentAnnual), li('信息渠道', intention.infoChannel)
  ].join('');

  // ---- 实习经历 ----
  const workRows = (data.work || []).map(x => recordUl([
    li('企业名称', x.company), li('开始时间', x.startDate), li('结束时间', x.endDate),
    li('企业性质', x.companyNature), li('工作类型', x.type), li('所在部门', x.department),
    li('职位名称', x.position), li('工作城市', x.city), li('税前职位月薪(元)', x.monthlySalary),
    li('工作描述', x.description), li('证明人姓名', x.certifierName), li('证明人关系', x.certifierRelation),
    li('证明人职务', x.certifierDuty), li('证明人单位', x.certifierCompany),
    li('证明人联系方式', x.certifierContact)
  ])).join('');

  // ---- 项目经验 ----
  const projRows = (data.projects || []).map(x => recordUl([
    li('项目名称', x.projectName), li('所在公司', x.company), li('项目职务', x.role),
    li('技术栈', x.techStack), li('开始时间', x.startDate), li('结束时间', x.endDate),
    li('项目描述', x.description), li('项目职责', x.responsibilities)
  ])).join('');

  // ---- 校内职务 ----
  const campusRows = (data.campusDuties || []).map(x => recordUl([
    li('组织团体名称', x.organization), li('担任职务', x.duty), li('干部级别', x.cadreLevel),
    li('职责和成就', x.achievement)
  ])).join('');

  // ---- 专利发表 ----
  const patentRows = (data.patents || []).map(x => recordUl([
    li('专利类型', x.type), li('专利名称', x.name), li('发表阶段', x.stage), li('作者排序', x.authorRank)
  ])).join('');

  // ---- 论文发表 ----
  const paperRows = (data.papers || []).map(x => recordUl([
    li('论文名称', x.title), li('接收/发表日期', x.publishDate), li('期刊或会议名称', x.journal),
    li('期刊或会议水平', x.level), li('作者排序', x.authorRank), li('论文发表状态', x.status),
    li('影响因子', x.impactFactor), li('年度/期次', x.yearIssue), li('内容提要', x.synopsis)
  ])).join('');

  // ---- 奖励荣誉 ----
  const awardRows = (data.awards || []).map(x => recordUl([
    li('奖励名称', x.name), li('奖项类别', x.category), li('奖励级别', x.level), li('奖励等级', x.grade),
    li('获奖时间', x.date), li('所在学校', x.school), li('是否学生干部', x.isCadre),
    li('学生干部描述', x.cadreDesc), li('颁发单位', x.issuer), li('简要描述', x.summary)
  ])).join('');

  // ---- 语言能力与资格证书 ----
  const langUl = (data.languages || []).map(x => recordUl([
    li('级别/名称', x.level), li('分数', x.score), li('时间', x.date), li('是否通过', x.passed),
    li('证书名称', x.certName), li('掌握程度', x.proficiency)
  ])).join('');
  const certRows = li('资格证书', data.certificates);
  const langRows = langUl + (certRows ? `<ul class="xueli"><p class="round"></p>${certRows}</ul>` : '');

  // ---- 计算机技能 ----
  const compRows = (data.computerSkills || []).map(x => recordUl([
    li('技能类别', x.skillType), li('技能描述', x.description)
  ])).join('');

  // ---- 家庭关系 ----
  const familyRows = (data.families || []).map(x => recordUl([
    li('姓名', x.name), li('关系', x.relation), li('性别', x.gender),
    li('是否在运营商/系统内任职', x.inTelecom), li('工作单位', x.workUnit), li('职务/岗位', x.position),
    li('联系电话', x.phone), li('现居住地址', x.livePlace),
    li('政治面貌', x.political)
  ])).join('');

  // ---- 技能/爱好 ----
  const skillRows = [li('专业技能', data.skills), li('个人爱好', data.hobbies)].join('');

  // ---- 其他补充信息 / 自我评价 ----
  const extraRows = [
    li('是否有亲属在单位、集团内任职', basic.hasRelativeInCompany),
    li('职业目标', extra.jobObjective), li('职业规划', extra.careerPlan)
  ].join('');
  const selfRows = li('评价内容', data.selfEvaluation);

  const infoList = [
    section('个人基本信息', `<ul>${basicRows}</ul>`),
    section('教育经历', eduRows),
    section('求职意向', `<ul>${intentionRows}</ul>`),
    section('实习经历', workRows),
    section('项目经验', projRows),
    section('专利发表', patentRows),
    section('论文发表', paperRows),
    section('奖励荣誉', awardRows),
    section('语言能力与资格证书', langRows),
    section('校内职务', campusRows),
    section('计算机技能', compRows),
    section('家庭关系', familyRows),
    section('技能/爱好', `<ul>${skillRows}</ul>`),
    section('其他补充信息', `<ul>${extraRows}</ul>`),
    section('自我评价', `<ul>${selfRows}</ul>`)
  ].join('');

  const photo = basic.photo || '';
  const photoBlock = photo
    ? `<div class="user-pic"><img src="${photo}" alt="证件照"></div>`
    : `<div class="user-pic not-user-pic">暂无照片</div>`;

  const headInfoBottom = [
    ['电话', basic.phone], ['邮箱', basic.email], ['学校', highestEdu.school], ['学历', degreeName]
  ].filter(x => x[1] && String(x[1]).trim()).map(x => `<span>${e(x[0])}：${e(x[1])}</span>`).join('');

  const politicalBadge = basic.political ? `<span> ${e(basic.political)} </span>` : '';
  const genderBadge = basic.gender ? `<img src="data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><rect width='24' height='24' fill='${basic.gender === '女' ? '#ff7eb3' : '#5b8def'}' rx='4'/><text x='12' y='16' font-size='13' text-anchor='middle' fill='#fff' font-family='sans-serif'>${basic.gender === '女' ? '女' : '男'}</text></svg>`)}" alt="性别">` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(basic.name || '个人')} - 个人简历</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",Arial,sans-serif;background:#f2f4f8;color:#3d485d}
.resume-preview{padding:32px 0;background:#f2f4f8}
.resume-box{border-radius:8px;overflow:hidden;width:1200px;max-width:96%;margin:0 auto;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.resume-box header{display:flex;align-items:center;background:linear-gradient(135deg,#eef3fb,#e7eef7);padding:20px;border-bottom:8px solid #eee;color:#3d485d}
.resume-box header .user-pic{position:relative;margin-right:20px;height:128px;border-radius:6px;text-align:center;overflow:hidden;flex-shrink:0;min-width:68px;border:1px solid #fff}
.resume-box header .user-pic img{height:100%;width:auto;display:block}
.resume-box header .user-pic.not-user-pic{width:98px;background-color:#eee;font-size:12px;line-height:128px;color:#999}
.resume-box header .header-right{width:100%}
.resume-box header .header-right>div{display:flex;justify-content:space-between;align-items:flex-start}
.resume-box header .header-right .head-info-top{display:flex;align-items:center}
.resume-box header .header-right .head-info-top .name{font-size:32px;font-weight:500;color:#000;margin-right:8px}
.resume-box header .header-right .head-info-top>img{width:24px;height:24px;margin-right:6px}
.resume-box header .header-right .head-info-top>span{display:inline-block;background:hsla(18,91%,77%,.35);border-radius:4px;padding:0 8px;text-align:center;color:#f94f17;height:24px;line-height:24px;margin-left:8px;font-size:14px}
.resume-box header .header-right .head-info-bottom{font-size:14px;margin:10px 0 6px}
.resume-box header .header-right .head-info-bottom>span{display:inline-block;padding:0 10px;border-right:1px solid #ccc}
.resume-box header .header-right .head-info-bottom>span:first-of-type{padding-left:0}
.resume-box header .header-right .head-info-bottom>span:last-of-type{border-right:0}
.resume-box header .header-right ul{display:flex;flex-wrap:wrap;padding-top:6px;border-top:1px dashed #ccc}
.resume-box header .header-right ul li{margin:4px 30px 0 0}
.resume-box header .header-right ul li span{font-size:14px;color:#3d485d}
.resume-box header .header-right ul li p{font-size:15px;color:#000}
.resume-box .info-list{padding:0 20px}
.resume-box .info-list>li{border-bottom:1px solid #e5e5e5;padding:20px 0}
.resume-box .info-list>li:last-of-type{border:none}
.resume-box .info-list>li h1{width:100%;font-size:17px;font-weight:500;margin-bottom:8px;color:#000;display:flex;align-items:center}
.resume-box .info-list>li h1::before{content:"";width:4px;height:18px;background:#2468f1;border-radius:2px;margin-right:12px}
.resume-box .info-list>li>div ul{padding-top:10px}
.resume-box .info-list>li>div ul:after{content:"";display:table;clear:both}
.resume-box .info-list>li>div ul.xueli{border-left:1px dashed #ccc;padding:0 0 16px 28px;position:relative;margin-left:9px}
.resume-box .info-list>li>div ul.xueli:first-of-type{margin-top:20px}
.resume-box .info-list>li>div ul.xueli .round{position:absolute;width:14px;height:14px;border:3px solid #2468f1;border-radius:50%;left:-7px;top:0;box-sizing:border-box;background-color:#fff}
.resume-box .info-list>li>div ul li{float:left;width:100%;font-size:14px;padding:2px 0;line-height:26px;word-break:break-all;display:flex;margin:2px 0}
.resume-box .info-list>li>div ul li.col-2{width:50%}
.resume-box .info-list>li>div ul li>div{display:flex}
.resume-box .info-list>li>div ul li>div>label{color:#3d485d;flex-shrink:0}
.resume-box .info-list>li>div ul li>div>span{white-space:pre-wrap;word-break:break-all;color:#000}
@media print{.resume-preview{padding:0;background:#fff}.resume-box{max-width:100%;box-shadow:none}}
</style>
</head>
<body>
<div class="resume-preview">
  <div class="resume-box">
    <header>
      ${photoBlock}
      <div class="header-right">
        <div>
          <p class="head-info-top"><label class="name"> ${e(basic.name || '')} </label>${genderBadge}${politicalBadge}</p>
        </div>
        <p class="head-info-bottom">${headInfoBottom}</p>
        ${headIntention ? `<ul>${headIntention}</ul>` : ''}
      </div>
    </header>
    <ul class="info-list">${infoList}</ul>
  </div>
</div>
</body>
</html>`;
}

async function importJSON(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    await doImport(data);
  } catch (e) {
    showStatus('save-status', `导入失败：${e.message}`, 'error');
  }
}

async function commitImportedProfile(data, reason) {
  const result = await chrome.runtime.sendMessage({ type: 'ENHANCEMENT_IMPORT', data, reason });
  if (!result?.ok) throw new Error(result?.error || '备份或保存失败，未完成导入');
  await new Promise(resolve => loadData(resolve));
}

async function doImport(data) {
  data = ResumeEnhancementsCore.validateImport(data);
  if (importInProgress) throw new Error('正在导入，请稍候');
  importInProgress = true; clearTimeout(saveTimer);
  const wasInert = document.body.inert; document.body.inert = true;
  try {
    // 先保存用户刚编辑、尚在防抖窗口内的原始资料，确保备份包含这些编辑。
    await chrome.storage.local.set(collectFormData());
    await commitImportedProfile(data, 'JSON 导入前');
    showStatus('save-status', '导入成功，原简历已备份', 'success');
  } finally { importInProgress = false; document.body.inert = wasInert; }
}

async function applyImportedProfile(profile, reason) {
  // PDF 的列表型技能/证书兼容已有文本展示格式。
  const normalized = { ...profile };
  for (const key of ['skills', 'certificates']) if (Array.isArray(normalized[key])) normalized[key] = normalized[key].join('\n');
  ResumeEnhancementsCore.validateImport(normalized);
  if (importInProgress) throw new Error('正在导入，请稍候');
  importInProgress = true; clearTimeout(saveTimer);
  const wasInert = document.body.inert; document.body.inert = true;
  const before = collectFormData();
  try {
    await chrome.storage.local.set(before);
    fillFormFromProfile(normalized);
    await commitImportedProfile(collectFormData(), reason);
  } catch (error) {
    fillFormFromProfile(before);
    throw error;
  } finally { importInProgress = false; document.body.inert = wasInert; }
}

// ===== 投递记录入口 =====
function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function requestOpenQuickRecommendation(tabId) {
  return new Promise((resolve, reject) => {
    if (tabId == null) {
      reject(new Error('未找到当前网页'));
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: 'OPEN_QUICK_RECOMMENDATION' }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error('当前网页暂时无法启用自动推荐，请刷新网页后重试'));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error(response && response.error || '当前网页没有可推荐填写的输入框'));
        return;
      }
      resolve(response);
    });
  });
}

async function openQuickRecommendation() {
  try {
    const tab = await getActiveTab();
    if (!tab || !/^https?:/i.test(tab.url || '')) {
      throw new Error('请在普通网页表单中使用自动推荐');
    }
    await requestOpenQuickRecommendation(tab.id);
    window.close();
  } catch (error) {
    showStatus('save-status', `打开自动推荐失败：${error.message}`, 'error');
  }
}

function requestJobPageMetadata(tabId) {
  return new Promise(resolve => {
    if (tabId == null) {
      resolve(null);
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: 'GET_JOB_PAGE_METADATA' }, response => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response && response.metadata ? response : null);
    });
  });
}

async function buildApplicationRecordDrafts() {
  const tab = await getActiveTab();
  const page = tab && /^https?:/i.test(tab.url || '')
    ? await requestJobPageMetadata(tab.id)
    : null;
  return {
    drafts: applicationRecordsCore.draftsFromJobMetadata(page && page.metadata, tab),
    pageContext: page && page.pageContext
  };
}

function requestOpenApplicationRecords(createNew, drafts, pageContext) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'OPEN_APPLICATION_RECORDS',
      createNew: !!createNew,
      drafts: Array.isArray(drafts) ? drafts : [],
      pageContext
    }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.error) {
        reject(new Error(response && response.error || '后台未能打开投递记录'));
        return;
      }
      resolve(response);
    });
  });
}

async function openApplicationRecords(createNew) {
  const button = document.getElementById(createNew ? 'btn-record-current' : 'btn-records');
  if (button && button.disabled) return;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  try {
    if (createNew) showStatus('save-status', '正在读取页面并用 AI 分析投递志愿…', '');
    const page = createNew ? await buildApplicationRecordDrafts() : { drafts: [] };
    await requestOpenApplicationRecords(createNew, page.drafts, page.pageContext);
    window.close();
  } catch (error) {
    showStatus('save-status', `打开投递记录失败：${error.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.setAttribute('aria-busy', 'false'); }
  }
}

// ===== 事件绑定 =====
function bindEvents() {
  document.getElementById('btn-enhancements')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
  });
  // 用户选定具体日期后，清除旧格式的兼容值，以新 YYYY-MM-DD 为准。
  document.addEventListener('input', (e) => {
    if (e.target?.type === 'date') {
      delete e.target.dataset.legacyDateValue;
      e.target.removeAttribute('title');
    }
  });

  // 输入/变更自动保存
  document.addEventListener('input', scheduleSave);
  document.addEventListener('change', scheduleSave);

  // 测试 LLM 连接
  document.getElementById('btn-test-llm').addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-llm');
    const statusEl = document.getElementById('llm-test-status');

    const config = {
      baseUrl: getVal('llm-baseUrl'),
      apiKey: getVal('llm-apiKey'),
      model: getVal('llm-model')
    };

    if (!config.baseUrl || !config.apiKey || !config.model) {
      statusEl.textContent = '请先填写 Base URL、API Key 和模型名称';
      statusEl.className = 'status error';
      return;
    }

    btn.disabled = true;
    document.getElementById('btn-test-llm-label').textContent = '测试中...';
    statusEl.textContent = '';
    statusEl.className = 'status';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_LLM',
        config: config
      });

      if (chrome.runtime.lastError) {
        throw new Error(chrome.runtime.lastError.message);
      }

      if (response.error) {
        statusEl.textContent = `❌ ${response.error}`;
        statusEl.className = 'status error';
      } else {
        statusEl.textContent = `✅ 连接成功！模型回复: ${response.reply}`;
        statusEl.className = 'status success';
      }
    } catch (err) {
      statusEl.textContent = `❌ 请求失败: ${err.message}`;
      statusEl.className = 'status error';
    } finally {
      btn.disabled = false;
      document.getElementById('btn-test-llm-label').textContent = '测试连接';
    }
  });

  // PDF 导入
  document.getElementById('btn-pdf').addEventListener('click', () => {
    document.getElementById('pdf-input').click();
  });
  document.getElementById('pdf-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handlePDFImport(file);
    e.target.value = '';
  });

  // HTML 导入
  document.getElementById('btn-html').addEventListener('click', () => {
    document.getElementById('html-input').click();
  });
  document.getElementById('html-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleHTMLImport(file);
    e.target.value = '';
  });

  // 证件照上传 / 移除
  document.getElementById('btn-photo-upload').addEventListener('click', () => {
    document.getElementById('photo-input').click();
  });
  document.getElementById('photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handlePhotoUpload(file);
    e.target.value = '';
  });
  document.getElementById('btn-photo-remove').addEventListener('click', () => {
    setVal('basic-photo', '');
    refreshPhotoPreview();
    scheduleSave();
  });

  // 添加教育经历
  document.getElementById('btn-add-edu').addEventListener('click', () => {
    const container = document.getElementById('education-list');
    container.appendChild(createEducationCard({}, container.children.length));
    scheduleSave();
  });

  // 添加语言能力
  document.getElementById('btn-add-language')?.addEventListener('click', () => {
    const container = document.getElementById('language-list');
    container.appendChild(createLanguageCard({}, container.children.length));
    scheduleSave();
  });

  // 添加实习经历
  document.getElementById('btn-add-work').addEventListener('click', () => {
    const container = document.getElementById('work-list');
    container.appendChild(createWorkCard({}, container.children.length));
    scheduleSave();
  });

  // 添加项目经历
  document.getElementById('btn-add-project').addEventListener('click', () => {
    const container = document.getElementById('project-list');
    container.appendChild(createProjectCard({}, container.children.length));
    scheduleSave();
  });

  // 添加校内职务 / 计算机技能
  document.getElementById('btn-add-campus').addEventListener('click', () => {
    const container = document.getElementById('campus-list');
    container.appendChild(createCampusCard({}, container.children.length));
    scheduleSave();
  });
  document.getElementById('btn-add-computer').addEventListener('click', () => {
    const container = document.getElementById('computer-list');
    container.appendChild(createComputerCard({}, container.children.length));
    scheduleSave();
  });

  // 添加专利/论文/奖励/家庭（直接追加卡片到 DOM，同项目经历逻辑）
  document.getElementById('btn-add-patent')?.addEventListener('click', () => appendItemCard('patent-list', createPatentCard, itemTemplates.patent(), '专利'));
  document.getElementById('btn-add-paper')?.addEventListener('click', () => appendItemCard('paper-list', createPaperCard, itemTemplates.paper(), '论文'));
  document.getElementById('btn-add-award')?.addEventListener('click', () => appendItemCard('award-list', createAwardCard, itemTemplates.award(), '奖励'));
  document.getElementById('btn-add-family')?.addEventListener('click', () => appendItemCard('family-list', createFamilyCard, itemTemplates.family(), '家庭成员'));

  // JSON 导出
  document.getElementById('btn-export-json').addEventListener('click', exportJSON);

  // 在当前网页启用输入框自动推荐，并立即打开推荐面板。
  document.getElementById('btn-open-recommend').addEventListener('click', openQuickRecommendation);

  // 投递记录：从当前职位页新建，或直接打开管理页面
  document.getElementById('btn-record-current').addEventListener('click', () => openApplicationRecords(true));
  document.getElementById('btn-records').addEventListener('click', () => openApplicationRecords(false));

  // HTML 导出（仿中国电信招聘简历预览版式）
  document.getElementById('btn-export-html').addEventListener('click', exportHTML);

  // AI 模型设置：点按钮展开/收起面板
  const llmBtn = document.getElementById('btn-llm');
  const llmPanel = document.getElementById('llm-panel');
  llmBtn.addEventListener('click', () => {
    const open = llmPanel.style.display !== 'none';
    llmPanel.style.display = open ? 'none' : 'grid';
    llmBtn.classList.toggle('active', !open);
  });

  // JSON 导入弹窗
  document.getElementById('btn-import-json').addEventListener('click', () => {
    document.getElementById('json-modal').style.display = 'flex';
    document.getElementById('json-input').value = '';
  });
  document.getElementById('btn-json-cancel').addEventListener('click', () => {
    document.getElementById('json-modal').style.display = 'none';
  });
  document.getElementById('btn-json-confirm').addEventListener('click', () => {
    const json = document.getElementById('json-input').value.trim();
    if (json) {
      importJSON(json);
      document.getElementById('json-modal').style.display = 'none';
    }
  });

  // 「至今」复选框事件代理
  document.addEventListener('change', (e) => {
    if (e.target.dataset.key === 'isPresent') {
      const card = e.target.closest('.entry-card');
      const endDateInput = card.querySelector('[data-key="endDate"]');
      if (e.target.checked) {
        endDateInput.value = '';
        endDateInput.disabled = true;
      } else {
        endDateInput.disabled = false;
      }
    }
  });
}

// ===== 工具函数 =====
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== 首次使用为空白资料；演示数据只能由用户主动导入 =====
const DEFAULT_PROFILE = {
  basic: {}, education: [], work: [], projects: [], campusDuties: [],
  computerSkills: [], patents: [], papers: [], awards: [], families: [],
  languages: "", certificates: "", skills: "", hobbies: "",
  jobIntention: {}, extra: {}, selfEvaluation: ""
};
