/* 业余无线电操作证模拟练习
 *
 * 数据来自 ../data/questions.json（题池）与 ../data/levels.json（级别映射）。
 * 题目内容与级别归属分离：换题库只换数据，本文件不动。
 *
 * 范围：v0.3 出题与判分、前后翻题；v0.4 作答记录与进度本地持久化、错题本、
 *       导出 / 导入；v0.5 开放 B / C 级并支持切换（三级共用同一份题池）。
 *
 * 答题规则：一道题只有第一次提交计入成绩；回看已答的题是只读展示。
 * 重做只发生在错题本里（点「重做这题」会清掉该题记录再作答）。
 *
 * 持久化：localStorage 存「每个级别的整份练习状态」——出题顺序、题目列表、
 * 当前位置、以及按题目 id 记录的作答结果。恢复时按存的 id 顺序重建，
 * 因此随机练习的顺序也能原样恢复。另存当前选中的级别。
 * 若浏览器禁用本地存储，则退化为仅当次会话有效，并在界面上明确提示。
 *
 * 实现注意：整张卡片先在内存里建好，最后一次性 appendChild 挂载。
 * 不能在主内容已挂载后往里面追加会触发 change 的控件——那时后文才声明的
 * 变量仍处于 TDZ，事件回调会抛 ReferenceError。
 */
'use strict';

(function () {
  var LEVEL_LABEL = { A: 'A 类', B: 'B 类', C: 'C 类' };
  var LEVEL_ORDER = ['A', 'B', 'C'];
  var DEFAULT_LEVEL = 'A';

  /**
   * 当前练习的级别。v0.5 起可在 A / B / C 之间切换。
   *
   * 三级共用同一份题池：levels.json 给的是「题目 id 列表」，590 题被三级共有，
   * 所以这里是纯前端的选择，不需要重新生成任何数据。
   * 级别选择会存进本地（store.currentLevel），下次打开还是这一级。
   */
  var currentLevel = DEFAULT_LEVEL;

  var DATA_DIR = '../data/';
  var STORAGE_KEY = 'chirp42.quiz.v1';
  var EXPORT_FORMAT = 'chirp42-quiz-progress';
  var EXPORT_VERSION = 1;

  var mainEl = document.getElementById('main');
  var footEl = document.getElementById('foot-stat');

  var questionsById = null;
  var levels = null;
  var session = null;

  // ---------------------------------------------------------------- 工具

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  /** 洗牌（Fisher–Yates），不改原数组 */
  function shuffled(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /**
   * 练习页需要更宽的容器（题干 + 答题卡双栏），其余页面是单栏。
   * 用 .is-wide 放宽 main 的 max-width；窄屏下这个类没有实际影响
   * （此时 .practice 自然堆叠成一列）。
   */
  function useWideLayout() {
    if (mainEl && mainEl.classList) { mainEl.classList.add('is-wide'); }
  }

  function useNormalLayout() {
    if (mainEl && mainEl.classList) { mainEl.classList.remove('is-wide'); }
  }

  /**
   * 清空容器。顺带把布局恢复成常规宽度——所有渲染函数都以它开头，
   * 因此「单栏页面不会残留练习页的宽布局」。练习页清空后再显式调
   * useWideLayout()。
   */
  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
    if (node === mainEl) { useNormalLayout(); }
  }

  /** 答对判定：所选与答案两个集合完全相等（多选顺序无关） */
  function isCorrect(selected, answers) {
    if (selected.length !== answers.length) { return false; }
    for (var i = 0; i < selected.length; i++) {
      if (answers.indexOf(selected[i]) === -1) { return false; }
    }
    return true;
  }

  function button(label, className, onClick) {
    var b = el('button', 'btn' + (className ? ' ' + className : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * 从自身脚本的 URL 上取版本号（quiz/index.html 里引用的是 app.js?v=x.y.z）。
   * 这样页脚显示的版本一定等于**正在运行的这份代码**的版本：如果浏览器
   * 用了缓存的旧 app.js，页脚也会显示旧版本号，不会出现“界面是旧的、
   * 版本号却是新的”这种误导。
   */
  function scriptVersion() {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute('src') || '';
        var m = /app\.js\?v=([0-9A-Za-z.\-]+)/.exec(src);
        if (m) { return m[1]; }
      }
    } catch (e) { /* 取不到就不显示版本 */ }
    return '';
  }

  var VERSION = scriptVersion();

  function versionSuffix() {
    return VERSION ? ' · v' + VERSION : '';
  }

  // ---------------------------------------------------------------- 本地存储

  var storageOk = true;   // 浏览器是否真的能写本地存储

  function emptyStore() {
    return { version: 1, updatedAt: '', currentLevel: DEFAULT_LEVEL, levels: {} };
  }

  function loadStore() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) { return emptyStore(); }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') { return emptyStore(); }
      if (!parsed.levels || typeof parsed.levels !== 'object') { parsed.levels = {}; }
      // 兼容 v0.4 及更早的数据：那时没有 currentLevel 字段
      if (LEVEL_ORDER.indexOf(parsed.currentLevel) === -1) {
        parsed.currentLevel = DEFAULT_LEVEL;
      }
      return parsed;
    } catch (e) {
      storageOk = false;
      return emptyStore();
    }
  }

  function saveStore(store) {
    try {
      store.updatedAt = new Date().toISOString();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      // 注意：成功时**不**把 storageOk 翻回 true。
      // 一旦本次会话确认过存储不可用，就是事实；否则「读失败→写成功」
      // 会把已经给出的提示抹掉，用户明明存不进去却不再看到警告。
      return true;
    } catch (e) {
      storageOk = false;
      return false;
    }
  }

  function clearStore() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch (e) {
      storageOk = false;
      return false;
    }
  }

  /**
   * 取某级别的作答记录表，**保证返回 store 里的那一份引用**。
   *
   * 不能写成「没有就返回 {}」——那是取值器返回临时对象，调用方
   * `delete recordsOf(currentLevel)[id]` 会删在一个立刻被丢弃的对象上，
   * 记录其实没删掉，界面又因为读的是同一份临时对象而显示为未作答，
   * 结果就是「重做后仍显示已选选项」。所以这里缺什么就补什么，
   * 并让它成为 store 的一部分。
   */
  function recordsOf(level) {
    if (!store.levels) { store.levels = {}; }
    if (!store.levels[level]) {
      store.levels[level] = { order: 'sequential', list: [], index: 0, records: {} };
    }
    if (!store.levels[level].records) { store.levels[level].records = {}; }
    return store.levels[level].records;
  }

  /** 某级别已存在的作答统计 */
  function levelStats(level) {
    var recs = recordsOf(level);
    var right = 0, wrong = 0;
    for (var id in recs) {
      if (!Object.prototype.hasOwnProperty.call(recs, id)) { continue; }
      if (recs[id].correct) { right++; } else { wrong++; }
    }
    return { right: right, wrong: wrong, done: right + wrong };
  }

  /** 某级别的错题 id 列表，按题库顺序 */
  function wrongIdsOf(level) {
    var recs = recordsOf(level);
    var ids = levels[level] || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var r = recs[ids[i]];
      if (r && !r.correct) { out.push(ids[i]); }
    }
    return out;
  }

  var store = null;   // 首次启动时载入

  // ---------------------------------------------------------------- 级别

  /** 数据里实际可用的级别（按 A/B/C 顺序），缺的那级自动跳过 */
  function availableLevels() {
    var out = [];
    for (var i = 0; i < LEVEL_ORDER.length; i++) {
      var lv = LEVEL_ORDER[i];
      if (levels && Array.isArray(levels[lv]) && levels[lv].length > 0) { out.push(lv); }
    }
    return out;
  }

  function levelLabel(level) {
    return LEVEL_LABEL[level] || (level + ' 类');
  }

  /** 切换级别并记住选择。切换后回到该级别的首页。 */
  function setLevel(level) {
    if (availableLevels().indexOf(level) === -1) { return; }
    currentLevel = level;
    store.currentLevel = level;
    saveStore(store);
    session = null;              // 上一级别的会话不再适用
    renderHome();
  }

  // ---------------------------------------------------------------- 数据

  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) {
        throw new Error('读取 ' + url + ' 失败：HTTP ' + res.status);
      }
      return res.json();
    });
  }

  function loadData() {
    return Promise.all([
      fetchJson(DATA_DIR + 'questions.json'),
      fetchJson(DATA_DIR + 'levels.json')
    ]).then(function (results) {
      var allQuestions = results[0];
      levels = results[1];

      if (!Array.isArray(allQuestions) || allQuestions.length === 0) {
        throw new Error('questions.json 内容为空或格式不对');
      }
      if (!levels || typeof levels !== 'object') {
        throw new Error('levels.json 内容为空或格式不对');
      }
      if (availableLevels().length === 0) {
        throw new Error('levels.json 里没有任何可用的级别数据');
      }
      // 数据里没有当前级别时，退回第一个可用级别（而不是直接报错）
      if (availableLevels().indexOf(currentLevel) === -1) {
        currentLevel = availableLevels()[0];
      }

      questionsById = {};
      for (var i = 0; i < allQuestions.length; i++) {
        questionsById[allQuestions[i].id] = allQuestions[i];
      }
    });
  }

  /** 取当前级别的题目，顺序按 levels.json */
  function questionsForLevel() {
    var ids = levels[currentLevel] || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var q = questionsById[ids[i]];
      if (q) { out.push(q); }
    }
    return out;
  }

  // ---------------------------------------------------------------- 载入中 / 出错

  function renderLoading() {
    clear(mainEl);
    var card = el('section', 'card');
    card.appendChild(el('h1', null, '业余无线电操作证 · 模拟练习'));
    card.appendChild(el('p', 'note', '正在载入题库…'));
    mainEl.appendChild(card);
  }

  function renderError(message) {
    clear(mainEl);
    var card = el('section', 'card');
    card.appendChild(el('h1', null, '载入失败'));
    card.appendChild(el('p', 'note error', message));
    card.appendChild(button('重试', 'btn-primary', start));
    mainEl.appendChild(card);
    if (footEl) { footEl.textContent = '题库未载入' + versionSuffix(); }
  }

  function storageWarning() {
    if (storageOk) { return null; }
    return el('p', 'note error',
      '浏览器不允许本地存储（可能开了无痕模式），本次的作答记录与进度不会被保存。');
  }

  // ---------------------------------------------------------------- 首页

  /**
   * 级别选择器。三级共用同一份题池（levels.json 只给题目 id 列表），
   * 所以切换只是换一份 id 列表与一份练习进度，不需要重新取数据。
   */
  function renderLevelPicker() {
    var box = el('div', 'levels');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '选择级别');

    availableLevels().forEach(function (lv) {
      var st = levelStats(lv);
      var total = (levels[lv] || []).length;
      var isCurrent = lv === currentLevel;

      var b = el('button', 'level' + (isCurrent ? ' is-current' : ''));
      b.type = 'button';
      b.setAttribute('data-level', lv);
      b.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      b.appendChild(el('span', 'level-name', levelLabel(lv)));
      b.appendChild(el('span', 'level-meta',
        total + ' 题' + (st.done > 0 ? ' · 已答 ' + st.done : '')));
      if (isCurrent) { b.disabled = true; }
      b.addEventListener('click', function () { setLevel(lv); });
      box.appendChild(b);
    });

    return box;
  }

  function renderHome() {
    clear(mainEl);
    var pool = questionsForLevel();
    var stats = levelStats(currentLevel);
    var wrongCount = wrongIdsOf(currentLevel).length;
    var saved = store.levels[currentLevel];

    var card = el('section', 'card');
    card.appendChild(el('h1', null, '业余无线电操作证 · 模拟练习'));
    card.appendChild(renderLevelPicker());
    card.appendChild(el('p', 'note',
      '当前 ' + levelLabel(currentLevel) + ' 题库共 ' + pool.length + ' 题。' +
      '级别只决定出题范围，题目内容与级别归属分离，切换级别不影响已记录的作答结果。'));

    var warn = storageWarning();
    if (warn) { card.appendChild(warn); }

    if (stats.done > 0) {
      var rate = Math.round((stats.right / stats.done) * 100);
      card.appendChild(el('p', 'note',
        '本地已记录：已答 ' + stats.done + ' / ' + pool.length +
        ' 题，答对 ' + stats.right + ' 题，答错 ' + stats.wrong +
        ' 题，正确率 ' + rate + '%。'));
    }

    var modes = el('div', 'modes');

    // 有未完成进度时，主按钮是「继续练习」
    var resumeIndex = saved ? saved.index : -1;
    var canResume = saved && Array.isArray(saved.list) && saved.list.length > 0 &&
      resumeIndex >= 0 && resumeIndex < saved.list.length;

    if (canResume) {
      var seqLabel = saved.order === 'random' ? '随机' : '顺序';
      var left = saved.list.length - Object.keys(saved.records || {}).length;
      var contBtn = el('button', 'mode');
      contBtn.type = 'button';
      contBtn.appendChild(el('span', 'mode-name', '继续练习'));
      contBtn.appendChild(el('span', 'mode-desc',
        '上次是' + seqLabel + '练习，停在第 ' + (resumeIndex + 1) +
        ' / ' + saved.list.length + ' 题，还剩 ' + left + ' 题未作答。'));
      contBtn.addEventListener('click', function () { resumeSession(); });
      modes.appendChild(contBtn);
    }

    var seqBtn = el('button', 'mode');
    seqBtn.type = 'button';
    seqBtn.appendChild(el('span', 'mode-name', canResume ? '重新顺序练习' : '顺序练习'));
    seqBtn.appendChild(el('span', 'mode-desc',
      '按题库编号从第 1 题开始，适合系统过一遍。' +
      (canResume ? '会从头开始，题目为未作答状态。' : '')));
    seqBtn.addEventListener('click', function () { startSession('sequential'); });
    modes.appendChild(seqBtn);

    var rndBtn = el('button', 'mode');
    rndBtn.type = 'button';
    rndBtn.appendChild(el('span', 'mode-name', canResume ? '重新随机练习' : '随机练习'));
    rndBtn.appendChild(el('span', 'mode-desc',
      '每轮把全部 ' + pool.length + ' 题打乱，适合检验掌握程度。' +
      (canResume ? '会从头开始，题目为未作答状态。' : '')));
    rndBtn.addEventListener('click', function () { startSession('random'); });
    modes.appendChild(rndBtn);

    card.appendChild(modes);

    // 错题本入口与数据管理
    var misc = el('div', 'modes');
    var nbBtn = el('button', 'mode');
    nbBtn.type = 'button';
    nbBtn.appendChild(el('span', 'mode-name', '错题本'));
    nbBtn.appendChild(el('span', 'mode-desc',
      wrongCount > 0 ? '共 ' + wrongCount + ' 道错题，可逐题重做。' : '暂无错题。'));
    nbBtn.addEventListener('click', renderNotebook);
    misc.appendChild(nbBtn);
    card.appendChild(misc);

    card.appendChild(renderDataTools());

    mainEl.appendChild(card);

    if (footEl) {
      footEl.textContent = '题库 ' + pool.length + ' 题 · CRAC 2025 年版' +
        ' · 错题 ' + wrongCount + versionSuffix();
    }
  }

  /** 导出 / 导入 / 清空 三件套 */
  function renderDataTools() {
    var box = el('div', 'datatools');
    box.appendChild(el('p', 'note',
      '导出会下载一个 JSON 文件，包含全部级别的作答记录与练习进度；' +
      '导入会**覆盖**当前本地记录。'));

    var row = el('div', 'actions');
    row.appendChild(button('导出记录', '', exportProgress));

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) {
        importProgressFile(fileInput.files[0]);
      }
      fileInput.value = '';
    });
    row.appendChild(button('导入记录', '', function () { fileInput.click(); }));
    row.appendChild(button('清空记录', '', confirmClear));
    box.appendChild(row);
    box.appendChild(fileInput);
    return box;
  }

  // ---------------------------------------------------------------- 导出 / 导入

  function exportProgress() {
    var payload = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      app: 'chirp42 ' + (VERSION ? 'v' + VERSION : '(unknown)'),
      store: store
    };
    var text = JSON.stringify(payload, null, 2);

    // 文件名带日期，避免多次导出互相覆盖
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = 'chirp42-quiz-' + d.getFullYear() + pad(d.getMonth() + 1) +
      pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';

    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // 稍后回收，太早撤销会让部分浏览器下载失败
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      var box = renderNotice('已导出 ' + name);
      if (box) { box.setAttribute('data-export-ok', '1'); }
    } catch (e) {
      renderImportResult('导出失败：' + (e && e.message ? e.message : e), true);
    }
  }

  function importProgressFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        renderImportResult('导入失败：文件不是合法的 JSON。', true);
        return;
      }

      // 兼容两种形态：带外壳的导出文件，或直接就是 store。
      // 版本号要查对对象：外壳文件的版本在外壳上，裸 store 的版本在自身。
      var incoming = null;
      var declaredVersion = null;
      if (parsed && parsed.format === EXPORT_FORMAT && parsed.store) {
        incoming = parsed.store;
        declaredVersion = parsed.version;
      } else if (parsed && parsed.levels && typeof parsed.levels === 'object') {
        incoming = parsed;
        declaredVersion = parsed.version;
      }
      if (!incoming) {
        renderImportResult(
          '导入失败：这不像是本站导出的记录文件（缺少 levels 字段）。', true);
        return;
      }
      // 只看主版本号：将来 1.1 之类的兼容改动不该被拒
      if (typeof declaredVersion === 'number' && Math.floor(declaredVersion) > EXPORT_VERSION) {
        renderImportResult(
          '导入失败：文件来自更新的版本（version ' + declaredVersion +
          '），请先更新本页。', true);
        return;
      }

      var incomingLevels = Object.keys(incoming.levels);
      if (incomingLevels.length === 0) {
        renderImportResult('导入失败：文件里没有任何级别的记录。', true);
        return;
      }

      var counts = [];
      incomingLevels.forEach(function (lv) {
        var recs = (incoming.levels[lv] && incoming.levels[lv].records) || {};
        counts.push(lv + ' 级 ' + Object.keys(recs).length + ' 条');
      });

      if (!window.confirm(
        '导入将覆盖当前本地记录，无法撤销。\n\n' +
        '文件内包含：' + counts.join('、') + '\n\n确定继续？')) {
        renderImportResult('已取消导入。', false);
        return;
      }

      store = {
        version: 1,
        updatedAt: incoming.updatedAt || new Date().toISOString(),
        levels: incoming.levels
      };
      saveStore(store);
      renderImportResult('导入完成：' + counts.join('、') + '。');
    };
    reader.onerror = function () {
      renderImportResult('导入失败：读取文件出错。', true);
    };
    reader.readAsText(file);
  }

  function confirmClear() {
    if (!window.confirm('将清空本地保存的全部作答记录与练习进度，无法撤销。\n\n确定继续？')) {
      return;
    }
    clearStore();
    store = emptyStore();
    saveStore(store);
    renderNotice('已清空本地记录。');
  }

  function renderNotice(message) {
    var box = mainEl.querySelector ? mainEl.querySelector('.notice') : null;
    if (box) { box.parentNode.removeChild(box); }
    var p = el('p', 'notice', message);
    mainEl.appendChild(p);
    return p;
  }

  function renderImportResult(message, isError) {
    var box = el('p', 'notice' + (isError ? ' error' : ''), message);
    clear(mainEl);
    var card = el('section', 'card');
    card.appendChild(el('h1', null, '数据管理'));
    card.appendChild(box);
    card.appendChild(button('返回首页', 'btn-primary', renderHome));
    mainEl.appendChild(card);
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- 练习流程

  /**
   * 会话模式决定「已有的作答记录要不要显示」：
   *
   * - `resume`：继续上次练习。已答的题显示当时的判定（只读），可前后翻看。
   * - `redo`  ：重做（错题本「全部重做」/「重新顺序练习」/「重新随机练习」）。
   *             题目一律以**未作答**呈现，可以重新选择与提交；
   *             提交后的结果覆盖存储里的旧记录。
   *
   * 之前所有入口都复用同一份记录，导致「全部重做」一进去就是已作答状态、
   * 选项预选且不可改，等于没法重做。
   */
  function buildSession(mode, order, list) {
    return {
      mode: mode,
      order: order,
      list: list,
      index: 0,
      records: recordsOf(currentLevel),
      /**
       * 本轮提交过作答的题目 id。
       *
       * 一个会话记录表里的「本轮进度」由它决定，而不是由 records 决定：
       * - records 是跨轮次的累计结果，错题本读的就是它，所以重新练习时
       *   不能清（清了错题本就空了）；
       * - answered 只属于本轮，清空它就是「从头开始、全部空白」。
       */
      answered: {}
    };
  }

  function saveLevelState() {
    store.levels[currentLevel] = {
      mode: session.mode,
      order: session.order,
      list: session.list.map(function (q) { return q.id; }),
      index: session.index,
      records: session.records
    };
    saveStore(store);
  }

  /** 从头开始一轮练习：本轮答题卡与进度全部清空，题目可正常作答 */
  function startSession(order) {
    var pool = questionsForLevel();
    var list = order === 'random' ? shuffled(pool) : pool.slice();
    session = buildSession('redo', order, list);
    saveLevelState();
    renderQuestion();
  }

  /** 按本地保存的顺序与位置恢复上次的练习（已答题只读回看） */
  function resumeSession() {
    var saved = store.levels[currentLevel];
    var list = [];
    for (var i = 0; i < saved.list.length; i++) {
      var q = questionsById[saved.list[i]];
      if (q) { list.push(q); }
    }
    if (list.length === 0) {
      renderImportResult('本地保存的记录与当前题库对不上（题目 id 全部找不到），已改为重新开始。', true);
      return;
    }
    session = buildSession('resume', saved.order === 'random' ? 'random' : 'sequential', list);
    session.index = Math.max(0, Math.min(saved.index || 0, list.length - 1));

    // 更符合直觉：接着往下练，落到第一道未答题。
    // 存储里的 index 有可能指向已作答的题（例如旧版本保存的位置）。
    var next = -1;
    for (var j = 0; j < list.length; j++) {
      if (!session.records[list[j].id]) { next = j; break; }
    }
    if (next !== -1) { session.index = next; }

    renderQuestion();
  }

  function currentQuestion() {
    return session.list[session.index];
  }

  /** 本轮答对/答错数，只看本轮提交过的题（不受历史记录影响） */
  function sessionStats() {
    var right = 0, wrong = 0;
    for (var id in session.answered) {
      if (!Object.prototype.hasOwnProperty.call(session.answered, id)) { continue; }
      var rec = session.records[id];
      if (!rec) { continue; }
      if (rec.correct) { right++; } else { wrong++; }
    }
    return { right: right, wrong: wrong };
  }

  /** 本轮是否还有未作答的题 */
  function hasUnansweredInSession() {
    var p = sessionProgress();
    return p.done < p.total;
  }

  /** 第一道未作答的题的下标，全部答完则返回 -1 */
  function firstUnanswered() {
    for (var i = 0; i < session.list.length; i++) {
      if (!session.records[session.list[i].id]) { return i; }
    }
    return -1;
  }

  /**
   * 「下一题」是否可用。
   *
   * 允许答题卡自由跳题之后，判断条件不能再是「当前下标是否超过 frontier」：
   * 直接跳到第 500 题作答时，500 远在 frontier 之后，那样会被锁住。
   * 现在的规则是——当前题在本轮已作答，或本轮还有空题（可以先回头补），
   * 就可以往下翻。
   */
  function canGoNext() {
    if (session.index >= session.list.length - 1) { return true; }  // 最后一题是「查看成绩」
    if (isAnsweredThisSession(currentQuestion())) { return true; }
    return hasUnansweredInSession();
  }

  function progressText() {
    var st = sessionStats();
    var p = sessionProgress();
    var tail = p.done > 0 ? ' · 对 ' + st.right + ' 错 ' + st.wrong : '';
    return (session.index + 1) + ' / ' + session.list.length + tail;
  }

  /** redo 模式下不显示已有记录：题目一律当作未作答，可以重新选择与提交 */
  function showsRecords() {
    return session.mode !== 'redo';
  }

  /** 是否处于「重做」模式：允许重新作答并覆盖旧记录 */
  function isRedo() {
    return session.mode === 'redo';
  }

  /** 某道题是否在**本轮**提交过作答 */
  function isAnsweredThisSession(q) {
    return !!session.answered[q.id];
  }

  /**
   * 本轮已作答的题数 / 本轮总题数。
   *
   * 这是唯一的「本轮进度」来源：答题卡的格子标记、进度数字、
   * 「下一题」是否可用，全部看它。刻意不读 session.records——
   * records 是跨轮次的累计（错题本读它），用它会让「重新练习」清不干净。
   */
  function sessionProgress() {
    return { done: Object.keys(session.answered).length, total: session.list.length };
  }

  /**
   * 右面板的累计统计：当前级别全部作答结果（含以前各轮）。
   * 与「练习进度」不同——进度只算本轮，重开一轮会归零，而这个不会。
   */
  function sheetStatText() {
    var st = levelStats(currentLevel);
    return levelLabel(currentLevel) + '累计　对 ' + st.right + ' 错 ' + st.wrong;
  }

  /** 右面板里的一行「名称  值」 */
  function metaRow(name, value) {
    var row = el('div', 'meta-row');
    row.appendChild(el('span', 'meta-name', name));
    row.appendChild(el('span', 'meta-val', value));
    return row;
  }

  /**
   * 答题卡：把本轮题目排成号码格，点任意格跳到该题。
   *
   * 格子按**本轮顺序**编号 1..N。随机练习时题目顺序是打乱的，
   * 但答题卡仍然从 1 排到 N——它表示「本轮第几题」，与题库编号无关。
   * 跳转用 data-index（本轮内的下标），与显示的编号天然一致。
   *
   * 全部格子都可点——随机挑题练是合理用法，不要求按顺序推进。
   * 但「下一题」仍只在当前题作答过、或前面还有空题时才可用，
   * 避免一进来就把整轮翻过去。
   *
   * 题量大时（B 级 1143、C 级 1282）表格可滚动，且只渲染号码与状态，
   * 不渲染题干，开销很小。
   */
  function renderAnswerSheet(q) {
    var box = el('section', 'sheet');
    box.setAttribute('data-sheet', 'grid');

    // 面板标题。与参考图一致：先写模式，再列题目编号与练习进度。
    box.appendChild(el('div', 'sheet-head', '练习模式'));

    box.appendChild(metaRow('题目编号', q.id));
    /*
     * 练习进度 = 本轮**已作答的题数** / 总题数。
     * 不是当前题号：跳着做题时，做第 24 题仍然只做了 1 题，进度必须是 1。
     * 重新开始一轮时 answered 被清空，所以这里会回到 0。
     */
    var progressRow = metaRow('练习进度',
      sessionProgress().done + ' / ' + sessionProgress().total);
    box.appendChild(progressRow);
    var progressVal = progressRow.childNodes[1];

    var stat = el('div', 'sheet-stat', sheetStatText());
    box.appendChild(stat);

    var grid = el('div', 'sheet-grid');
    var cells = {};

    session.list.forEach(function (item, i) {
      // 只认本轮：重开一轮后这里的标记全部消失，进度也同时归零
      var rec = session.answered[item.id] ? session.records[item.id] : null;
      var isCurrent = i === session.index;
      // 编号 = 本轮序位（随机练习下与题库编号无关）
      var no = i + 1;

      var cell = el('button', 'sheet-cell');
      cell.type = 'button';
      cell.setAttribute('data-index', String(i));
      cell.textContent = String(no);

      if (isCurrent) {
        cell.classList.add('is-current');
        cell.setAttribute('aria-current', 'true');
      }
      if (rec) {
        cell.classList.add(rec.correct ? 'is-right' : 'is-wrong');
        cell.setAttribute('data-answered', 'yes');
      }
      // 全部格子都可点：随机挑题练是合理用法，不再要求按顺序推进。

      var label = '本轮第 ' + no + ' 题';
      label += rec ? (rec.correct ? '，已答对' : '，已答错') : '，未作答';
      if (isCurrent) { label += '（当前）'; }
      cell.setAttribute('aria-label', label);

      cells[item.id] = cell;
      grid.appendChild(cell);
    });

    // 事件委托：一个监听器覆盖全部格子
    grid.addEventListener('click', function (ev) {
      var target = ev.target;
      if (!target || !target.getAttribute) { return; }
      var idx = target.getAttribute('data-index');
      if (idx === null || idx === undefined) { return; }
      var i = Number(idx);
      if (!(i >= 0) || i >= session.list.length || i === session.index) { return; }
      session.index = i;
      saveLevelState();
      renderQuestion();
    });

    box.appendChild(grid);

    return {
      node: box,
      /** 作答或翻页后刷新状态，避免整块重绘 */
      update: function () {
        stat.textContent = sheetStatText();
        progressVal.textContent = sessionProgress().done + ' / ' + sessionProgress().total;
        for (var id in cells) {
          if (!Object.prototype.hasOwnProperty.call(cells, id)) { continue; }
          var cell = cells[id];
          // 同样只认本轮
          var rec = session.answered[id] ? session.records[id] : null;
          var i = Number(cell.getAttribute('data-index'));
          cell.classList.remove('is-current', 'is-right', 'is-wrong');
          delete cell.attributes['data-answered'];
          var label = '本轮第 ' + (i + 1) + ' 题';
          if (i === session.index) {
            cell.classList.add('is-current');
            cell.setAttribute('aria-current', 'true');
            label += '（当前）';
          } else {
            delete cell.attributes['aria-current'];
          }
          if (rec) {
            cell.classList.add(rec.correct ? 'is-right' : 'is-wrong');
            cell.setAttribute('data-answered', 'yes');
            label += rec.correct ? '，已答对' : '，已答错';
          } else {
            label += '，未作答';
          }
          cell.setAttribute('aria-label', label);
        }
      }
    };
  }

  function renderQuestion() {
    var q = currentQuestion();
    var record = (showsRecords() ? session.records[q.id] : null) || null;
    var isMulti = q.answers.length > 1;

    // 整个练习区是一张卡片：左侧题干与选项，右侧答题卡区块。
    // 早先做成了两块各带边框的卡片并排，看起来是分离的两块，
    // 与参考图不符（那里右栏只是卡片内部的一个区块）。
    var card = el('section', 'card');
    card.setAttribute('data-qid', q.id);
    card.setAttribute('data-type', isMulti ? 'multiple' : 'single');
    card.setAttribute('data-state', record ? 'answered' : 'fresh');
    card.setAttribute('data-mode', session.mode);
    // 便于诊断「重做后仍显示已选」这类问题：明确标出渲染时是否带着记录
    card.setAttribute('data-record', record ? 'yes' : 'no');

    // 进度行（跨满整张卡片）
    var bar = el('div', 'progress');
    var left = el('span', null, progressText());
    var quit = el('button', 'btn btn-small', '结束');
    quit.type = 'button';
    quit.addEventListener('click', renderSummary);
    bar.appendChild(left);
    bar.appendChild(quit);
    card.appendChild(bar);

    var wrap = el('div', 'practice');
    var qside = el('div', 'q-side');
    wrap.appendChild(qside);

    // 题号与正文分两列：题号列宽度在 CSS 里定，题干与选项文字左对齐
    var qrow = el('div', 'q-row');
    qrow.appendChild(el('span', 'q-num', String(session.index + 1) + '.'));

    var qbody = el('div', 'q-body');

    var tags = el('div', 'qtypes');
    // 只标题型，不透露答案个数（那等于变相给提示）
    tags.appendChild(el('span', 'qtype', isMulti ? '多选题' : '单选题'));
    if (record) {
      tags.appendChild(el('span', 'qtype', '已作答，可前后翻看'));
    }
    qbody.appendChild(tags);

    qbody.appendChild(el('p', 'qtext', q.question));

    if (q.figure) {
      qbody.appendChild(el('p', 'note',
        '本题附图 ' + q.figure + '（图片待补，先留占位）'));
    }

    // 选项
    var fieldset = el('fieldset', 'options');
    var inputs = [];
    q.options.forEach(function (opt) {
      var label = el('label', 'opt');
      var input = document.createElement('input');
      input.type = isMulti ? 'checkbox' : 'radio';
      input.name = 'answer';
      input.value = opt.key;
      label.appendChild(input);
      label.appendChild(el('span', 'opt-key', opt.key));
      label.appendChild(el('span', 'opt-text', opt.text));
      inputs.push({ key: opt.key, input: input, label: label });
      fieldset.appendChild(label);
    });
    qbody.appendChild(fieldset);

    var verdictSlot = el('div', 'verdict-slot');
    qbody.appendChild(verdictSlot);

    var actions = el('div', 'actions');
    var prevBtn = el('button', 'btn', '上一题');
    prevBtn.type = 'button';
    var submitBtn = el('button', 'btn btn-primary', '提交答案');
    submitBtn.type = 'button';
    var nextBtn = el('button', 'btn', '下一题');
    nextBtn.type = 'button';
    actions.appendChild(prevBtn);
    actions.appendChild(submitBtn);
    actions.appendChild(nextBtn);
    qbody.appendChild(actions);

    // 左侧：题号 + 正文；右侧：答题卡区块
    qside.appendChild(qrow);
    qside.appendChild(qbody);

    var sheet = renderAnswerSheet(q);
    wrap.appendChild(sheet.node);
    card.appendChild(wrap);

    var lastIndex = session.list.length - 1;

    /** 把选项标成判定后的样子，并填充反馈 */
    function showVerdict(rec) {
      inputs.forEach(function (item) {
        item.input.disabled = true;
        item.input.checked = rec.selected.indexOf(item.key) !== -1;
        item.label.classList.add('is-locked');
        item.label.classList.remove('is-selected');
        var isAnswer = q.answers.indexOf(item.key) !== -1;
        var picked = rec.selected.indexOf(item.key) !== -1;
        if (isAnswer) {
          item.label.classList.add('is-correct');
        } else if (picked) {
          item.label.classList.add('is-wrong');
        }
      });

      var verdict = el('div', 'verdict ' + (rec.correct ? 'ok' : 'bad'));
      verdict.appendChild(el('span', null, rec.correct ? '回答正确' : '回答错误'));
      var detail = '正确答案：' + q.answers.join('');
      if (rec.selected.length > 0) {
        var pickedKeys = inputs
          .filter(function (item) { return rec.selected.indexOf(item.key) !== -1; })
          .map(function (item) { return item.key; });
        detail += '　你的选择：' + pickedKeys.join('');
      }
      verdict.appendChild(el('span', 'answer', detail));
      verdictSlot.appendChild(verdict);
    }

    /** 刷新翻页按钮（规则见 canGoNext） */
    function refreshNav() {
      prevBtn.disabled = session.index === 0;
      nextBtn.disabled = !canGoNext();
      nextBtn.textContent = session.index === lastIndex ? '查看成绩' : '下一题';
    }

    if (record) {
      showVerdict(record);
      submitBtn.hidden = true;
      left.textContent = progressText();
    } else {
      submitBtn.disabled = true;

      fieldset.addEventListener('change', function () {
        if (session.records[q.id] && !isRedo()) { return; }
        var picked = inputs
          .filter(function (item) { return item.input.checked; })
          .map(function (item) { return item.key; });
        inputs.forEach(function (item) {
          item.label.classList.toggle('is-selected', item.input.checked);
        });
        submitBtn.disabled = picked.length === 0;
      });

      submitBtn.addEventListener('click', function () {
        // 非 redo 模式下，同一题只有第一次提交计入，避免来回改答案刷分
        if (session.records[q.id] && !isRedo()) { return; }

        var picked = inputs
          .filter(function (item) { return item.input.checked; })
          .map(function (item) { return item.key; });
        if (picked.length === 0) { return; }

        session.records[q.id] = {
          selected: picked,
          correct: isCorrect(picked, q.answers)
        };
        session.answered[q.id] = true;   // 记入本轮
        // 作答后立刻落盘，并把当前位置一起记下：
        // 否则「继续练习」会回到上一道未答题，而不是接着往下。
        saveLevelState();

        showVerdict(session.records[q.id]);
        left.textContent = progressText();
        sheet.update();
        submitBtn.hidden = true;
        refreshNav();
        if (!nextBtn.disabled) { nextBtn.focus(); }
      });
    }
    refreshNav();

    prevBtn.addEventListener('click', function () {
      if (session.index === 0) { return; }
      session.index--;
      saveLevelState();
      renderQuestion();
    });

    nextBtn.addEventListener('click', function () {
      if (nextBtn.disabled) { return; }
      if (session.index === lastIndex) {
        saveLevelState();
        renderSummary();
        return;
      }
      session.index++;
      saveLevelState();
      renderQuestion();
    });

    clear(mainEl);
    useWideLayout();
    mainEl.appendChild(card);
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- 成绩

  /** 成绩页的一行：本轮 / 本级累计 */
  function summaryRow(name, right, wrong, done, total, rate) {
    var row = el('div', 'summary-row');
    row.appendChild(el('span', 'summary-name', name));
    var val = el('span', 'summary-val',
      '已答 ' + done + ' / ' + total + ' 题，对 ' + right + ' 错 ' + wrong);
    if (done > 0) { val.textContent += '，正确率 ' + rate + '%'; }
    row.appendChild(val);
    return row;
  }

  function renderSummary() {
    var st = sessionStats();          // 只看本轮提交过的题
    var done = st.right + st.wrong;
    var total = session.list.length;
    var rate = done > 0 ? Math.round((st.right / done) * 100) : 0;

    var lv = levelStats(currentLevel);   // 该级别累计（含以前各轮）
    var lvTotal = questionsForLevel().length;
    var lvRate = lv.done > 0 ? Math.round((lv.right / lv.done) * 100) : 0;

    // 标题看答题卡上有没有已答的题（不是只看本轮）：
    // 进入一个已有记录的级别直接点结束时，虽然本轮一题没答，
    // 但确实有成绩可看，显示「本次练习」会让人以为记录丢了。
    var anyAnswered = false;
    for (var ai = 0; ai < session.list.length; ai++) {
      if (session.records[session.list[ai].id]) { anyAnswered = true; break; }
    }
    clear(mainEl);
    var card = el('section', 'card');
    card.appendChild(el('h1', null, anyAnswered ? '本次成绩' : '本次练习'));

    // 本轮与累计可能不同（例如上一轮答过、这一轮直接点结束），
    // 所以两个数都给出来，避免只看一个造成误解。
    var rows = el('div', 'summary');
    rows.appendChild(summaryRow('本轮', st.right, st.wrong, done, total, rate));
    rows.appendChild(summaryRow(levelLabel(currentLevel) + '累计',
      lv.right, lv.wrong, lv.done, lvTotal, lvRate));
    card.appendChild(rows);

    if (done === 0 && lv.done === 0) {
      card.appendChild(el('p', 'note', '还没有作答记录。'));
    } else {
      card.appendChild(el('p', 'note',
        '记录已保存在本机，刷新或关掉页面都不会丢。'));
    }

    var actions = el('div', 'actions');

    var frontier = firstUnanswered();
    if (frontier !== -1) {
      actions.appendChild(button('继续未答的题', 'btn-primary', function () {
        session.index = frontier;
        saveLevelState();
        renderQuestion();
      }));
    }

    // 这两处的判断用「该级别累计」而不是本轮：
    // 本轮一题没答但以前答过时，仍然应该能回看、并且不必被当成首次练习。
    if (lv.done > 0) {
      actions.appendChild(button('回看已答的题', frontier === -1 ? 'btn-primary' : '',
        function () {
          session.index = 0;
          saveLevelState();
          renderQuestion();
        }));
    }

    var wrongCount = wrongIdsOf(currentLevel).length;
    if (wrongCount > 0) {
      actions.appendChild(button('去错题本（' + wrongCount + '）', '', renderNotebook));
    }

    actions.appendChild(button('回首页', lv.done === 0 ? 'btn-primary' : '', renderHome));

    card.appendChild(actions);
    mainEl.appendChild(card);
    window.scrollTo(0, 0);

    if (footEl) {
      footEl.textContent = '记录已保存在本机 · 错题 ' + wrongCount + versionSuffix();
    }
  }

  // ---------------------------------------------------------------- 错题本

  function renderNotebook() {
    clear(mainEl);
    var wrongIds = wrongIdsOf(currentLevel);

    var card = el('section', 'card');
    card.appendChild(el('h1', null, '错题本'));
    card.appendChild(el('p', 'note',
      LEVEL_LABEL[currentLevel] + '：共 ' + wrongIds.length + ' 道错题。' +
      '重做时会重新判定并更新记录；答对后即从错题本移除。'));

    var warn = storageWarning();
    if (warn) { card.appendChild(warn); }

    if (wrongIds.length === 0) {
      card.appendChild(el('p', 'note', '暂时没有错题。'));
      card.appendChild(button('返回首页', 'btn-primary', renderHome));
      mainEl.appendChild(card);
      if (footEl) { footEl.textContent = '错题 0' + versionSuffix(); }
      return;
    }

    var list = el('div', 'nb-list');
    wrongIds.forEach(function (id) {
      var q = questionsById[id];
      if (!q) { return; }
      var item = el('div', 'nb-item');
      item.setAttribute('data-nb-id', id);
      item.appendChild(el('p', 'nb-text', q.question));
      var meta = el('p', 'note',
        '章节 ' + q.chapter + '　正确答案 ' + q.answers.join('') +
        '　上次选择 ' + (recordsOf(currentLevel)[id].selected || []).join(''));
      item.appendChild(meta);
      item.appendChild(button('重做这题', 'btn-small', function () { redoQuestion(id); }));
      list.appendChild(item);
    });
    card.appendChild(list);

    var actions = el('div', 'actions');
    actions.appendChild(button('全部重做', 'btn-primary', function () {
      startRedoSession(wrongIds);
    }));
    actions.appendChild(button('返回首页', '', renderHome));
    card.appendChild(actions);
    mainEl.appendChild(card);

    if (footEl) {
      footEl.textContent = '错题 ' + wrongIds.length + versionSuffix();
    }
  }

  /** 用错题组成一轮练习（顺序与题库一致），全部以未作答呈现 */
  function startRedoSession(ids) {
    var list = [];
    for (var i = 0; i < ids.length; i++) {
      var q = questionsById[ids[i]];
      if (q) { list.push(q); }
    }
    if (list.length === 0) { renderNotebook(); return; }
    session = buildSession('redo', 'sequential', list);
    saveLevelState();
    renderQuestion();
  }

  /** 重做单题：清掉它的记录，然后立即进入该题 */
  function redoQuestion(id) {
    var q = questionsById[id];
    if (!q) { renderNotebook(); return; }
    delete recordsOf(currentLevel)[id];
    session = buildSession('redo', 'sequential', [q]);
    saveLevelState();
    renderQuestion();
  }

  // ---------------------------------------------------------------- 启动

  /** 从 URL 参数取要打开哪一级，例如 ?level=B 或 #B */
  function levelFromUrl() {
    try {
      var m = /[?&]level=([ABC])/i.exec(window.location.search || '');
      if (!m) { m = /^#([ABC])$/i.exec(window.location.hash || ''); }
      return m ? m[1].toUpperCase() : null;
    } catch (e) { return null; }
  }

  function start() {
    renderLoading();
    store = loadStore();
    if (!store.version) { store.version = 1; }

    // 优先级：URL 参数 > 本地记住的选择 > 默认 A
    // （URL 参数让「把 B 级练习链接发给别人」这种用法成立）
    currentLevel = levelFromUrl() || store.currentLevel || DEFAULT_LEVEL;
    store.currentLevel = currentLevel;

    loadData().then(function () {
      // 数据里没有这一级时，loadData 已把 currentLevel 退回可用级别
      store.currentLevel = currentLevel;
      saveStore(store);
      renderHome();
    }).catch(function (err) {
      renderError(err && err.message ? err.message : String(err));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
