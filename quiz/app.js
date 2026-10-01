/* 业余无线电操作证模拟练习
 *
 * 数据来自 ../data/questions.json（题池）与 ../data/levels.json（级别映射）。
 * 题目内容与级别归属分离：换题库只换数据，本文件不动。
 *
 * v0.3 范围：三类架构 + A 类数据；顺序 / 随机出题；即时判分。
 * 进度与成绩只存在内存中（本地持久化在 v0.4）。
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
    var retry = el('button', 'btn btn-primary', '重试');
    retry.type = 'button';
    retry.addEventListener('click', start);
    card.appendChild(retry);
    mainEl.appendChild(card);
    if (footEl) { footEl.textContent = '题库未载入'; }
  }

  // ---------------------------------------------------------------- 选择模式

  function renderModeSelect() {
    clear(mainEl);
    var pool = questionsForLevel();

    var card = el('section', 'card');
    card.appendChild(el('h1', null, '业余无线电操作证 · 模拟练习'));
    card.appendChild(el('p', 'note',
      '当前为 ' + LEVEL_LABEL[LEVEL] + ' 题库，共 ' + pool.length + ' 题。' +
      '题目内容与级别归属分离，B / C 级数据待 v0.5 开放。'));

    var modes = el('div', 'modes');

    var seqBtn = el('button', 'mode');
    seqBtn.type = 'button';
    seqBtn.appendChild(el('span', 'mode-name', '顺序练习'));
    seqBtn.appendChild(el('span', 'mode-desc', '按题库编号从第 1 题开始，适合系统过一遍。'));
    seqBtn.addEventListener('click', function () { startSession(pool, 'sequential'); });
    modes.appendChild(seqBtn);

    var rndBtn = el('button', 'mode');
    rndBtn.type = 'button';
    rndBtn.appendChild(el('span', 'mode-name', '随机练习'));
    rndBtn.appendChild(el('span', 'mode-desc',
      '每轮把全部 ' + pool.length + ' 题打乱，适合检验掌握程度。'));
    rndBtn.addEventListener('click', function () { startSession(pool, 'random'); });
    modes.appendChild(rndBtn);

    card.appendChild(modes);
    mainEl.appendChild(card);

    if (footEl) {
      footEl.textContent = '题库 ' + pool.length + ' 题 · CRAC 2025 年版';
    }
  }

  // ---------------------------------------------------------------- 练习流程

  function startSession(pool, order) {
    session = {
      order: order,
      list: order === 'random' ? shuffled(pool) : pool.slice(),
      index: 0,
      selected: [],
      submitted: false,
      right: 0,
      wrong: 0
    };
    renderQuestion();
  }

  function currentQuestion() {
    return session.list[session.index];
  }

  function progressText() {
    var done = session.right + session.wrong;
    var tail = done > 0 ? ' · 对 ' + session.right + ' 错 ' + session.wrong : '';
    return (session.index + 1) + ' / ' + session.list.length + tail;
  }

  function renderQuestion() {
    var q = currentQuestion();
    session.selected = [];
    session.submitted = false;

    var card = el('section', 'card');
    // 记录当前题号，便于调试与自动化测试定位（不影响渲染）
    card.setAttribute('data-qid', q.id);
    card.setAttribute('data-type', q.answers.length > 1 ? 'multiple' : 'single');

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

    // 题型
    var isMulti = q.answers.length > 1;
    card.appendChild(el('span', 'qtype',
      isMulti ? '多选题（' + q.answers.length + ' 个答案）' : '单选题'));

    // 题干
    card.appendChild(el('p', 'qtext', q.question));

    if (q.figure) {
      card.appendChild(el('p', 'note',
        '本题附图 ' + q.figure + '（图片待补，v0.3 先留占位）'));
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

    // 判定区与操作区：先建好节点，再挂监听，最后整体挂载
    var verdictSlot = el('div');
    card.appendChild(verdictSlot);

    var actions = el('div', 'actions');
    var submitBtn = el('button', 'btn btn-primary', '提交答案');
    submitBtn.type = 'button';
    submitBtn.disabled = true;
    var nextBtn = el('button', 'btn', '下一题');
    nextBtn.type = 'button';
    nextBtn.hidden = true;
    actions.appendChild(submitBtn);
    actions.appendChild(nextBtn);
    card.appendChild(actions);

    // ---- 事件：选择 ----
    fieldset.addEventListener('change', function () {
      if (session.submitted) { return; }
      session.selected = inputs
        .filter(function (item) { return item.input.checked; })
        .map(function (item) { return item.key; });
      inputs.forEach(function (item) {
        item.label.classList.toggle('is-selected', item.input.checked);
      });
      submitBtn.disabled = session.selected.length === 0;
    });

    // ---- 事件：提交 ----
    submitBtn.addEventListener('click', function () {
      if (session.submitted) { return; }

      var ok = isCorrect(session.selected, q.answers);
      session.submitted = true;
      if (ok) { session.right++; } else { session.wrong++; }

      inputs.forEach(function (item) {
        item.input.disabled = true;
        item.label.classList.add('is-locked');
        item.label.classList.remove('is-selected');
        var isAnswer = q.answers.indexOf(item.key) !== -1;
        var picked = session.selected.indexOf(item.key) !== -1;
        if (isAnswer) {
          item.label.classList.add('is-correct');
        } else if (picked) {
          item.label.classList.add('is-wrong');
        }
      });

      var verdict = el('div', 'verdict ' + (ok ? 'ok' : 'bad'));
      verdict.appendChild(el('span', null, ok ? '回答正确' : '回答错误'));
      var detail = '正确答案：' + q.answers.join('');
      if (session.selected.length > 0) {
        detail += '　你的选择：' + session.selected.slice().sort().join('');
      }
      verdict.appendChild(el('span', 'answer', detail));
      verdictSlot.appendChild(verdict);

      left.textContent = progressText();

      submitBtn.hidden = true;
      nextBtn.hidden = false;
      nextBtn.textContent = (session.index + 1 >= session.list.length)
        ? '查看成绩' : '下一题';
      nextBtn.focus();
    });

    // ---- 事件：下一题 ----
    nextBtn.addEventListener('click', function () {
      if (session.index + 1 >= session.list.length) {
        renderSummary();
        return;
      }
      session.index++;
      renderQuestion();
    });

    clear(mainEl);
    mainEl.appendChild(card);
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- 成绩

  function renderSummary() {
    var done = session.right + session.wrong;
    var total = session.list.length;
    var rate = done > 0 ? Math.round((session.right / done) * 100) : 0;

    clear(mainEl);
    var card = el('section', 'card');
    card.appendChild(el('h1', null, done === 0 ? '本次练习' : '本次成绩'));

    if (done === 0) {
      card.appendChild(el('p', 'note', '还没有作答记录。'));
    } else {
      card.appendChild(el('p', 'note',
        '已答 ' + done + ' / ' + total + ' 题，答对 ' + session.right +
        ' 题，答错 ' + session.wrong + ' 题，正确率 ' + rate + '%。'));
    }

    var actions = el('div', 'actions');

    // 有未作答的题时，从下一题继续
    if (done > 0 && session.index + 1 < total) {
      var resumeBtn = el('button', 'btn btn-primary', '继续未答的题');
      resumeBtn.type = 'button';
      resumeBtn.addEventListener('click', function () {
        session.index++;
        renderQuestion();
      });
      actions.appendChild(resumeBtn);
    }

    var againBtn = el('button', 'btn' + (actions.childNodes.length ? '' : ' btn-primary'), '再练一次');
    againBtn.type = 'button';
    againBtn.addEventListener('click', renderModeSelect);
    actions.appendChild(againBtn);

    card.appendChild(actions);
    card.appendChild(el('p', 'note',
      '错题本与进度持久化在 v0.4 实现，当前刷新页面会清零。'));
    mainEl.appendChild(card);
    window.scrollTo(0, 0);

    if (footEl) {
      footEl.textContent = '本次结果不做保存（v0.4 加入错题本）';
    }
  }

  // ---------------------------------------------------------------- 启动

  function start() {
    renderLoading();
    loadData().then(renderModeSelect).catch(function (err) {
      renderError(err && err.message ? err.message : String(err));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
