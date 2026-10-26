/* =========================================================
 * ai.js —— AI 健康助手：API 配置、周报评估、对话
 * ========================================================= */
(function () {
  'use strict';

  function $(sel) { return document.querySelector(sel); }
  function toast(msg) { if (window.BPApp) window.BPApp.toast(msg); }

  var DISCLAIMER = '（AI 建议仅供参考，不能替代医生诊断。）';

  // 常见 OpenAI 兼容服务商，选中后自动填入接口地址与常用模型
  var PROVIDERS = [
    { id: 'deepseek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'kimi', base: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview' },
    { id: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'qwen', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' }
  ];

  function normUrl(u) {
    return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  }

  var busy = false;

  /* ---------------- 数据上下文 ---------------- */
  function buildContext(db) {
    var p = db.settings.profile || {};
    var keys = BP.recentKeys(db, 7).reverse();
    var lines = [];

    if (!keys.length) {
      return '用户最近 7 天没有任何血压记录。\n';
    }

    lines.push('以下是用户最近 7 天的血压记录（每天早晚各测两次，取平均值为最终数据）：');
    keys.forEach(function (k) {
      var day = db.records[k];
      var parts = [];
      ['morning', 'evening'].forEach(function (slot) {
        var rec = day[slot];
        if (!rec || !rec.avg) return;
        var raw = rec.readings.map(function (r) {
          return r.sys + '/' + r.dia + (r.pulse ? '(脉' + r.pulse + ')' : '');
        }).join('、');
        parts.push((slot === 'morning' ? '早' : '晚') + '：' + rec.avg.sys + '/' + rec.avg.dia + ' mmHg' +
          (rec.avg.pulse ? '，心率 ' + rec.avg.pulse : '') + '（原始：' + raw + '）');
      });
      if (parts.length) lines.push(k + '（' + BP.weekday(k) + '）' + parts.join('；'));
    });

    var s = BP.stats(db, 7);
    if (s.days) {
      lines.push('');
      lines.push('近 7 天统计：平均 ' + s.sys + '/' + s.dia + ' mmHg，平均心率 ' + (s.pulse || '--') +
        '，正常天数占比 ' + s.okRate + '%（正常标准：低于 120/80 mmHg）。');
    }

    var info = [];
    if (p.age) info.push('年龄 ' + p.age + ' 岁');
    if (p.gender) info.push('性别 ' + p.gender);
    if (info.length) lines.push('个人信息：' + info.join('，') + '。');

    return lines.join('\n');
  }

  function systemPrompt(db) {
    return [
      '你是一位耐心、专业的家庭血压管理健康助手。',
      '请基于用户提供的血压记录，用简体中文回答，要求：',
      '1. 先给出总体判断（是否稳定、有无异常波动、是否处于正常血压范围，即低于 120/80 mmHg）；',
      '2. 指出需要关注的具体数据和时间段；',
      '3. 给出可执行的饮食、运动、作息、测量习惯建议；',
      '4. 如果出现明显高危数值（如收缩压 ≥180 或舒张压 ≥110，或伴随异常症状），明确提示尽快就医；',
      '5. 语言通俗、分点陈述、简洁，不要长篇大论，不要编造记录中不存在的数据；',
      '6. 结尾提醒 AI 建议不能替代医生诊断。'
    ].join('\n');
  }

  /* ---------------- 本地规则兜底 ---------------- */
  function localAnalysis(db) {
    var s = BP.stats(db, 7);
    if (!s.days) {
      return '最近 7 天还没有血压记录。建议先连续记录几天早晚血压，再来做评估。\n\n记录方法：早晚各测两次，间隔 1~2 分钟，取平均值作为当次结果。';
    }

    var keys = BP.recentKeys(db, 7);
    var maxRec = null;
    keys.forEach(function (k) {
      var day = db.records[k];
      ['morning', 'evening'].forEach(function (slot) {
        var a = day[slot] && day[slot].avg;
        if (!a) return;
        if (!maxRec || a.sys > maxRec.avg.sys) maxRec = { key: k, slot: slot, avg: a };
      });
    });

    var out = [];
    out.push('【近 7 天概况】');
    out.push('共记录 ' + s.days + ' 天，平均血压 ' + s.sys + '/' + s.dia + ' mmHg，平均心率 ' + (s.pulse || '--') + ' 次/分，正常天数占比 ' + s.okRate + '%。');

    out.push('');
    out.push('【整体判断】');
    if (s.sys < 120 && s.dia < 80) {
      out.push('整体处于正常范围，控制得不错，继续保持当前的作息与测量习惯。');
    } else if (s.sys < 140 && s.dia < 90) {
      out.push('整体处于正常高值（偏高）区间，虽然还不算高血压，但已经需要重视，建议从饮食和运动入手干预。');
    } else {
      out.push('平均值已达到高血压范围，建议规律监测并尽早咨询医生，评估是否需要进一步检查或用药。');
    }

    if (maxRec) {
      out.push('');
      out.push('【需要关注】');
      out.push('最高一次出现在 ' + BP.humanDate(maxRec.key) + ' ' + (maxRec.slot === 'morning' ? '早间' : '晚间') +
        '，为 ' + maxRec.avg.sys + '/' + maxRec.avg.dia + ' mmHg。' +
        (maxRec.avg.sys >= 180 || maxRec.avg.dia >= 110 ? '该数值属于很高水平，如伴有头痛、胸闷、视物模糊等症状请立即就医。' : '建议回顾当天是否有熬夜、情绪波动、咖啡因或漏服药等情况。'));
    }

    out.push('');
    out.push('【建议】');
    out.push('· 测量：起床后 1 小时内、排尿后、早餐和服药前测早间血压；睡前测晚间血压，每次测 2 遍取平均。');
    out.push('· 饮食：每日食盐控制在 5 克以内，少吃腌制、加工食品，多吃蔬菜、水果和低脂奶制品。');
    out.push('· 运动：每周 5 天、每次 30 分钟左右的中等强度有氧运动，如快走、骑车。');
    out.push('· 作息：保证 7 小时睡眠，戒烟限酒，保持情绪平稳。');

    return out.join('\n');
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var db = BP.load();
    var cfg = db.settings.api;
    var p = db.settings.profile;

    $('#apiBase').value = cfg.baseUrl || '';
    $('#apiKey').value = cfg.apiKey || '';
    $('#apiModel').value = cfg.model || '';

    var curBase = normUrl(cfg.baseUrl);
    var matched = 'custom';
    PROVIDERS.forEach(function (prov) {
      if (normUrl(prov.base) === curBase) matched = prov.id;
    });
    $('#apiProvider').value = matched;
    $('#profileAge').value = p.age || '';
    $('#profileGender').value = p.gender || '';

    var configured = !!(cfg.baseUrl && cfg.apiKey);
    $('#apiStatus').textContent = configured
      ? '已配置：' + (cfg.model || '默认模型') + ' · 密钥仅保存在本机'
      : '尚未配置 API，当前使用本地规则分析';
    $('#btnToggleApi').textContent = configured ? '修改' : '设置';

    renderChat(db);
  }

  function renderChat(db) {
    var box = $('#chatBox');
    var msgs = db.ai.messages || [];
    if (!msgs.length) {
      box.innerHTML = '<div class="chat-empty">配置好 API 后，点上面的「周报评估」，<br>AI 会结合你最近一周的血压记录给出分析。</div>';
      return;
    }
    box.innerHTML = '';
    msgs.forEach(function (m) {
      box.appendChild(bubble(m.role, m.content));
    });
    box.scrollTop = box.scrollHeight;
  }

  function bubble(role, text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
    var b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    wrap.appendChild(b);
    return wrap;
  }

  function appendLoading() {
    var wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.id = 'aiLoading';
    var b = document.createElement('div');
    b.className = 'bubble loading';
    b.textContent = '正在分析你的血压数据…';
    wrap.appendChild(b);
    var box = $('#chatBox');
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function removeLoading() {
    var el = $('#aiLoading');
    if (el) el.remove();
  }

  /* ---------------- 调用接口 ---------------- */
  function callAPI(cfg, messages) {
    var base = (cfg.baseUrl || '').replace(/\/+$/, '');
    var url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model || 'deepseek-chat',
        messages: messages,
        temperature: 0.6,
        max_tokens: 1000
      })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('接口返回 ' + res.status + '：' + String(t).slice(0, 160));
        });
      }
      return res.json();
    }).then(function (data) {
      var msg = data && data.choices && data.choices[0] && data.choices[0].message;
      if (!msg || !msg.content) throw new Error('接口没有返回内容');
      return String(msg.content).trim();
    });
  }

  /* ---------------- 发送 ---------------- */
  function ask(text) {
    if (busy) return;
    text = (text || '').trim();
    if (!text) return;

    var db = BP.load();
    var cfg = db.settings.api;

    db.ai.messages.push({ role: 'user', content: text, ts: Date.now() });
    if (db.ai.messages.length > 60) db.ai.messages = db.ai.messages.slice(-60);
    BP.save(db);
    renderChat(db);
    $('#chatInput').value = '';

    busy = true;
    appendLoading();

    if (!cfg.baseUrl || !cfg.apiKey) {
      setTimeout(function () {
        finish(localAnalysis(BP.load()) +
          '\n\n（当前未配置 AI 接口，以上为本地规则生成的初步分析。配置 API 后可获得更个性化的评估。）\n' + DISCLAIMER);
      }, 450);
      return;
    }

    var history = db.ai.messages.slice(-10).map(function (m) {
      return { role: m.role, content: m.content };
    });

    var messages = [
      { role: 'system', content: systemPrompt(db) },
      { role: 'system', content: buildContext(db) }
    ].concat(history);

    callAPI(cfg, messages).then(function (reply) {
      finish(reply);
    }).catch(function (err) {
      removeLoading();
      busy = false;
      var fallback = localAnalysis(BP.load()) +
        '\n\n---\n接口调用失败：' + err.message + '\n可在「设置」中检查接口地址、密钥和模型是否正确，或稍后再试。\n' + DISCLAIMER;
      finish(fallback);
    });
  }

  function finish(reply) {
    removeLoading();
    var db = BP.load();
    db.ai.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
    if (db.ai.messages.length > 60) db.ai.messages = db.ai.messages.slice(-60);
    BP.save(db);
    renderChat(db);
    busy = false;
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    $('#btnToggleApi').addEventListener('click', function () {
      var form = $('#apiForm');
      form.hidden = !form.hidden;
    });

    $('#apiProvider').addEventListener('change', function () {
      var id = this.value;
      var prov = PROVIDERS.filter(function (x) { return x.id === id; })[0];
      if (!prov) { $('#apiBase').focus(); return; }
      $('#apiBase').value = prov.base;
      $('#apiModel').value = prov.model;
    });

    $('#btnSaveApi').addEventListener('click', function () {
      var base = $('#apiBase').value.trim();
      var key = $('#apiKey').value.trim();
      var model = $('#apiModel').value.trim();
      if (!base || !key) { toast('请填写接口地址和 API Key'); return; }
      if (!/^https?:\/\//i.test(base)) { toast('接口地址需以 http:// 或 https:// 开头'); return; }

      var db = BP.load();
      var firstTime = !(db.ai.messages && db.ai.messages.length);
      db.settings.api = { baseUrl: base, apiKey: key, model: model || 'deepseek-chat' };
      db.settings.profile = {
        name: db.settings.profile.name || '',
        age: $('#profileAge').value.trim(),
        gender: $('#profileGender').value
      };
      BP.save(db);
      $('#apiForm').hidden = true;
      toast('配置已保存');
      render();
      if (firstTime) {
        setTimeout(function () { ask('请根据我最近一周的血压数据，给出整体评估和建议。'); }, 400);
      }
    });

    $('#btnSend').addEventListener('click', function () {
      ask($('#chatInput').value);
    });

    $('#chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') ask(e.target.value);
    });

    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
      c.addEventListener('click', function () { ask(c.dataset.ask); });
    });

    render();
  }

  window.BPAI = { render: render };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
