/* 业余无线电操作证模拟练习
 *
 * 数据来自 ../data/questions.json（题池）与 ../data/levels.json（级别映射）。
 * 题目内容与级别归属分离：换题库只换数据，本文件不动。
 *
 * 范围：v0.3 三类架构 + A 类数据、顺序/随机出题、即时判分、前后翻题；
 *       v0.4 作答记录与练习进度本地持久化、错题本、导出 / 导入。
 *
 * 答题规则：一道题只有第一次提交计入成绩；回看已答的题是只读展示。
 * 重做只发生在错题本里（点「重做这题」会清掉该题记录再作答）。
 *
 * 持久化：localStorage 存「每个级别的整份练习状态」——出题顺序、题目列表、
 * 当前位置、以及按题目 id 记录的作答结果。恢复时按存的 id 顺序重建，
 * 因此随机练习的顺序也能原样恢复。
 * 若浏览器禁用本地存储，则退化为仅当次会话有效，并在界面上明确提示。
 *
 * 实现注意：整张卡片先在内存里建好，最后一次性 appendChild 挂载。
 * 不能在主内容已挂载后往里面追加会触发 change 的控件——那时后文才声明的
 * 变量仍处于 TDZ，事件回调会抛 ReferenceError。
 */
'use strict';

(function () {
  // 当前开放练习的级别。B / C 的数据与切换在 v0.5 开放。
  var LEVEL = 'A';
  var LEVEL_LABEL = { A: 'A 类', B: 'B 类', C: 'C 类' };

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

  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
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
    return { version: 1, updatedAt: '', levels: {} };
  }

  function loadStore() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) { return emptyStore(); }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') { return emptyStore(); }
      if (!parsed.levels || typeof parsed.levels !== 'object') { parsed.levels = {}; }
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
      storageOk = true;
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

  function recordsOf(level) {
    var lv = store.levels[level];
    return (lv && lv.records) ? lv.records : {};
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
      if (!levels || !Array.isArray(levels[LEVEL])) {
        throw new Error('levels.json 缺少 ' + LEVEL + ' 级数据');
      }

      questionsById = {};
      for (var i = 0; i < allQuestions.length; i++) {
        questionsById[allQuestions[i].id] = allQuestions[i];
      }
    });
  }

  /** 取当前级别的题目，顺序按 levels.json */
  function questionsForLevel() {
    var ids = levels[LEVEL] || [];
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

  function renderHome() {
    clear(mainEl);
    var pool = questionsForLevel();
    var stats = levelStats(LEVEL);
    var wrongCount = wrongIdsOf(LEVEL).length;
    var saved = store.levels[LEVEL];

    var card = el('section', 'card');
    card.appendChild(el('h1', null, '业余无线电操作证 · 模拟练习'));
    card.appendChild(el('p', 'note',
      LEVEL_LABEL[LEVEL] + ' 题库共 ' + pool.length + ' 题。' +
      '题目内容与级别归属分离，B / C 级数据待 v0.5 开放。'));

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
      (canResume ? '会清空当前进度，已记录的作答结果保留。' : '')));
    seqBtn.addEventListener('click', function () { startSession('sequential'); });
    modes.appendChild(seqBtn);

    var rndBtn = el('button', 'mode');
    rndBtn.type = 'button';
    rndBtn.appendChild(el('span', 'mode-name', canResume ? '重新随机练习' : '随机练习'));
    rndBtn.appendChild(el('span', 'mode-desc',
      '每轮把全部 ' + pool.length + ' 题打乱，适合检验掌握程度。' +
      (canResume ? '会清空当前进度，已记录的作答结果保留。' : '')));
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

  function saveLevelState() {
    store.levels[LEVEL] = {
      order: session.order,
      list: session.list.map(function (q) { return q.id; }),
      index: session.index,
      records: session.records
    };
    saveStore(store);
  }

  function startSession(order) {
    var pool = questionsForLevel();
    var list = order === 'random' ? shuffled(pool) : pool.slice();
    var prev = recordsOf(LEVEL);   // 已答题的结果跨轮次保留
    session = {
      order: order,
      list: list,
      index: 0,
      records: prev
    };
    saveLevelState();
    renderQuestion();
  }

  /** 按本地保存的顺序与位置恢复上次的练习 */
  function resumeSession() {
    var saved = store.levels[LEVEL];
    var list = [];
    for (var i = 0; i < saved.list.length; i++) {
      var q = questionsById[saved.list[i]];
      if (q) { list.push(q); }
    }
    if (list.length === 0) {
      renderImportResult('本地保存的记录与当前题库对不上（题目 id 全部找不到），已改为重新开始。', true);
      return;
    }
    session = {
      order: saved.order === 'random' ? 'random' : 'sequential',
      list: list,
      index: Math.max(0, Math.min(saved.index || 0, list.length - 1)),
      records: saved.records || {}
    };
    renderQuestion();
  }

  function currentQuestion() {
    return session.list[session.index];
  }

  function answeredCount() {
    return Object.keys(session.records).length;
  }

  function sessionStats() {
    var right = 0, wrong = 0;
    for (var id in session.records) {
      if (!Object.prototype.hasOwnProperty.call(session.records, id)) { continue; }
      if (session.records[id].correct) { right++; } else { wrong++; }
    }
    return { right: right, wrong: wrong };
  }

  /** 第一道未作答的题的下标，全部答完则返回 -1 */
  function firstUnanswered() {
    for (var i = 0; i < session.list.length; i++) {
      if (!session.records[session.list[i].id]) { return i; }
    }
    return -1;
  }

  /** 允许翻到的最远下标：已答过的最后一题，或第一道未答题（取较大者） */
  function maxAllowedIndex() {
    var frontier = firstUnanswered();
    if (frontier === -1) { return session.list.length - 1; }
    // 注意：不能找到就 return —— 那样在「只答了第 1 题、frontier 为 1」时
    // 会返回 0，把刚答完的题锁在原地无法前进。
    var lastAnswered = -1;
    for (var i = frontier - 1; i >= 0; i--) {
      if (session.records[session.list[i].id]) { lastAnswered = i; break; }
    }
    return lastAnswered > frontier ? lastAnswered : frontier;
  }

  function progressText() {
    var st = sessionStats();
    var tail = (st.right + st.wrong) > 0
      ? ' · 对 ' + st.right + ' 错 ' + st.wrong
      : '';
    return (session.index + 1) + ' / ' + session.list.length + tail;
  }

  function renderQuestion() {
    var q = currentQuestion();
    var record = session.records[q.id] || null;
    var isMulti = q.answers.length > 1;

    var card = el('section', 'card');
    card.setAttribute('data-qid', q.id);
    card.setAttribute('data-type', isMulti ? 'multiple' : 'single');
    card.setAttribute('data-state', record ? 'answered' : 'fresh');

    // 进度行
    var bar = el('div', 'progress');
    var left = el('span', null, progressText());
    var mid = el('span', 'chapter', '章节 ' + q.chapter);
    var quit = el('button', 'btn btn-small', '结束');
    quit.type = 'button';
    quit.addEventListener('click', renderSummary);
    bar.appendChild(left);
    bar.appendChild(mid);
    bar.appendChild(quit);
    card.appendChild(bar);

    card.appendChild(el('span', 'qtype',
      isMulti ? '多选题（' + q.answers.length + ' 个答案）' : '单选题'));

    if (record) {
      card.appendChild(el('span', 'qtype', '已作答，可前后翻看'));
    }

    card.appendChild(el('p', 'qtext', q.question));

    if (q.figure) {
      card.appendChild(el('p', 'note',
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
    card.appendChild(fieldset);

    var verdictSlot = el('div');
    card.appendChild(verdictSlot);

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
    card.appendChild(actions);

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

    function refreshNav() {
      prevBtn.disabled = session.index === 0;
      nextBtn.disabled = session.index >= maxAllowedIndex();
      nextBtn.textContent = session.index === lastIndex ? '查看成绩' : '下一题';
    }

    if (record) {
      showVerdict(record);
      submitBtn.hidden = true;
      left.textContent = progressText();
    } else {
      submitBtn.disabled = true;

      fieldset.addEventListener('change', function () {
        if (session.records[q.id]) { return; }
        var picked = inputs
          .filter(function (item) { return item.input.checked; })
          .map(function (item) { return item.key; });
        inputs.forEach(function (item) {
          item.label.classList.toggle('is-selected', item.input.checked);
        });
        submitBtn.disabled = picked.length === 0;
      });

      submitBtn.addEventListener('click', function () {
        if (session.records[q.id]) { return; }

        var picked = inputs
          .filter(function (item) { return item.input.checked; })
          .map(function (item) { return item.key; });
        if (picked.length === 0) { return; }

        session.records[q.id] = {
          selected: picked,
          correct: isCorrect(picked, q.answers)
        };
        saveLevelState();          // 每次作答后立刻落盘

        showVerdict(session.records[q.id]);
        left.textContent = progressText();
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
    mainEl.appendChild(card);
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- 成绩

  function renderSummary() {
    var st = sessionStats();
    var done = st.right + st.wrong;
    var total = session.list.length;
    var rate = done > 0 ? Math.round((st.right / done) * 100) : 0;

    clear(mainEl);
    var card = el('section', 'card');
    card.appendChild(el('h1', null, done === 0 ? '本次练习' : '本次成绩'));

    if (done === 0) {
      card.appendChild(el('p', 'note', '还没有作答记录。'));
    } else {
      card.appendChild(el('p', 'note',
        '已答 ' + done + ' / ' + total + ' 题，答对 ' + st.right +
        ' 题，答错 ' + st.wrong + ' 题，正确率 ' + rate + '%。'));
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

    if (done > 0) {
      actions.appendChild(button('回看已答的题', frontier === -1 ? 'btn-primary' : '',
        function () {
          session.index = 0;
          saveLevelState();
          renderQuestion();
        }));
    }

    var wrongCount = wrongIdsOf(LEVEL).length;
    if (wrongCount > 0) {
      actions.appendChild(button('去错题本（' + wrongCount + '）', '', renderNotebook));
    }

    actions.appendChild(button('回首页', done === 0 ? 'btn-primary' : '', renderHome));

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
    var wrongIds = wrongIdsOf(LEVEL);

    var card = el('section', 'card');
    card.appendChild(el('h1', null, '错题本'));
    card.appendChild(el('p', 'note',
      LEVEL_LABEL[LEVEL] + '：共 ' + wrongIds.length + ' 道错题。' +
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
        '　上次选择 ' + (recordsOf(LEVEL)[id].selected || []).join(''));
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

  /** 用错题组成一轮练习（顺序与题库一致） */
  function startRedoSession(ids) {
    var list = [];
    for (var i = 0; i < ids.length; i++) {
      var q = questionsById[ids[i]];
      if (q) { list.push(q); }
    }
    if (list.length === 0) { renderNotebook(); return; }
    session = {
      order: 'sequential',
      list: list,
      index: 0,
      records: recordsOf(LEVEL)   // 同一份记录，重做会覆盖对应条目
    };
    saveLevelState();
    renderQuestion();
  }

  /** 重做单题：清掉它的记录，然后立即进入该题 */
  function redoQuestion(id) {
    var q = questionsById[id];
    if (!q) { renderNotebook(); return; }
    delete recordsOf(LEVEL)[id];
    session = {
      order: 'sequential',
      list: [q],
      index: 0,
      records: recordsOf(LEVEL)
    };
    saveLevelState();
    renderQuestion();
  }

  // ---------------------------------------------------------------- 启动

  function start() {
    renderLoading();
    store = loadStore();
    if (!store.version) { store.version = 1; }
    loadData().then(renderHome).catch(function (err) {
      renderError(err && err.message ? err.message : String(err));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
