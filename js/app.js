/* =========================================================
 * app.js —— 视图切换、血压填写、记录汇总与趋势图
 * ========================================================= */
(function () {
  'use strict';

  var state = { range: 7, view: 'entry', entryKey: null, backfill: false };
  var entryDirty = false;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---------------- 通用工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(name) {
    state.view = name;
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    $('#view-' + name).classList.add('active');
    $$('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === name);
    });
    if (name === 'entry') renderEntry();
    if (name === 'records') renderRecords();
    if (name === 'ai' && window.BPAI) window.BPAI.render();
    window.scrollTo(0, 0);
  }

  /* =========================================================
   * 填写页
   * ========================================================= */
  function renderEntry() {
    var db = BP.load();
    var today = BP.dateKey();
    if (!state.backfill || !state.entryKey) state.entryKey = today;
    if (state.entryKey > today) { state.entryKey = today; state.backfill = false; }
    var key = state.entryKey;
    var isPast = key < today;

    $('#entryDate').textContent = BP.humanDate(key) + (isPast ? ' · 补录' : '');
    $('#entryWeekday').textContent = BP.weekday(key) + ' · ' + key;

    var done = 0;
    if (BP.getSlot(db, key, 'morning')) done++;
    if (BP.getSlot(db, key, 'evening')) done++;
    $('#entryProgress').textContent = done + ' / 2';

    var hint;
    if (isPast) {
      hint = '补录模式：可补填 ' + BP.humanDate(key) + ' 的早晚数据，保存后计入该日记录';
    } else {
      var morningWin = BP.windowState(key, 'morning');
      var eveningWin = BP.windowState(key, 'evening');
      if (morningWin.open) hint = '早间记录中 · 中午 12:00 后早间数据将锁定';
      else if (eveningWin.open) hint = '晚间记录中 · 凌晨 00:00 后晚间数据将锁定';
      else if (done === 2) hint = '今天两次记录已完成，明天见';
      else hint = '今天的填写时间已过，明天记得按时测量';
    }
    $('#entryHint').textContent = hint;

    $('#entryCards').innerHTML = slotCard(db, key, 'morning', isPast) + slotCard(db, key, 'evening', isPast);

    $('#backfillPanel').hidden = !state.backfill;
    $('#btnBackfill').textContent = state.backfill ? '取消补录' : '补录以往数据';
    $('#backfillDate').max = today;
    $('#backfillDate').value = state.backfill ? key : '';
    entryDirty = false;

    $$('.slot-actions .btn[data-save]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        onSaveSlot(key, btn.dataset.save, btn);
      });
    });

    $$('.slot').forEach(function (card) {
      $$('input', card).forEach(function (inp) {
        inp.addEventListener('input', function () {
          entryDirty = true;
          updateAvg(card);
        });
      });
    });
  }

  function slotCard(db, key, slot, isPast) {
    var isMorning = slot === 'morning';
    var rec = BP.getSlot(db, key, slot);
    var win = BP.windowState(key, slot);
    var editable = isPast || win.open;

    var readings = rec ? rec.readings.slice(0, 2) : [];
    while (readings.length < 2) readings.push({ sys: '', dia: '', pulse: '' });

    var badge;
    if (isPast) badge = '<span class="badge done">' + (rec ? '补录 · 可修改' : '可补录') + '</span>';
    else if (!editable) badge = '<span class="badge closed">' + (win.future ? '未开始' : '已锁定') + '</span>';
    else if (rec) badge = '<span class="badge done">已保存 · 可修改</span>';
    else badge = '<span class="badge open">可填写</span>';

    var rows = readings.map(function (r, i) {
      var dis = editable ? '' : ' disabled';
      return '' +
        '<div class="reading">' +
          '<div class="reading-title">第 ' + (i + 1) + ' 次</div>' +
          '<div class="reading-field">' +
            '<label>收缩压</label>' +
            '<input type="number" inputmode="numeric" data-i="' + i + '" data-f="sys" placeholder="—" value="' + val(r.sys) + '"' + dis + '>' +
          '</div>' +
          '<div class="reading-field">' +
            '<label>舒张压</label>' +
            '<input type="number" inputmode="numeric" data-i="' + i + '" data-f="dia" placeholder="—" value="' + val(r.dia) + '"' + dis + '>' +
          '</div>' +
          '<div class="reading-field">' +
            '<label>心率</label>' +
            '<input type="number" inputmode="numeric" data-i="' + i + '" data-f="pulse" placeholder="—" value="' + val(r.pulse) + '"' + dis + '>' +
          '</div>' +
        '</div>';
    }).join('');

    var avg = rec && rec.avg ? rec.avg : null;
    var g = avg ? BP.grade(avg.sys, avg.dia) : { text: '--', color: 'var(--ink-3)' };
    var avgText = avg ? (avg.sys + '/' + avg.dia) : '--/--';
    var unitText = avg && avg.pulse ? 'mmHg · 心率 ' + avg.pulse : 'mmHg';

    return '' +
      '<div class="card slot' + (editable ? '' : ' locked') + '" data-slot="' + slot + '">' +
        '<div class="slot-head">' +
          '<div class="slot-title"><span class="slot-icon">' + (isMorning ? '🌅' : '🌙') + '</span>' + (isMorning ? '早间血压' : '晚间血压') + '</div>' +
          badge +
        '</div>' +
        '<div class="slot-body">' +
          '<div class="reading-grid">' + rows + '</div>' +
          '<div class="avg-box">' +
            '<div>' +
              '<div class="avg-label">平均（最终数据）</div>' +
              '<div class="avg-value">' + avgText + '<span class="unit">' + unitText + '</span></div>' +
            '</div>' +
            (avg ? '<span class="avg-tag" style="color:' + g.color + ';background:' + g.color + '1a">' + g.text + '</span>' : '') +
          '</div>' +
        '</div>' +
        (editable
          ? '<div class="slot-actions"><button class="btn primary" data-save="' + slot + '">' + (rec ? '更新数据' : '保存数据') + '</button></div>' +
            '<div class="slot-note">' +
              (isPast ? '补录不受早晚时间限制，保存后计入 ' + BP.humanDate(key) : '只填一次也可以，平均值按已填的次数计算') +
            '</div>'
          : '<div class="slot-note">' + esc(win.reason) + '</div>') +
      '</div>';
  }

  function val(v) {
    return (v === null || v === undefined) ? '' : v;
  }

  // 输入时实时计算平均值
  function updateAvg(card) {
    var readings = readInputs(card).filter(function (r) {
      return BP.isNum(r.sys) && BP.isNum(r.dia);
    });
    var box = $('.avg-value', card);
    var tagBox = $('.avg-tag', card);
    if (!readings.length) {
      box.innerHTML = '--/--<span class="unit">mmHg</span>';
      if (tagBox) tagBox.remove();
      return;
    }
    var a = BP.average(readings);
    var g = BP.grade(a.sys, a.dia);
    box.innerHTML = a.sys + '/' + a.dia + '<span class="unit">mmHg' + (a.pulse ? ' · 心率 ' + a.pulse : '') + '</span>';
    if (!tagBox) {
      tagBox = document.createElement('span');
      tagBox.className = 'avg-tag';
      $('.avg-box', card).appendChild(tagBox);
    }
    tagBox.textContent = g.text;
    tagBox.style.color = g.color;
    tagBox.style.background = g.color + '1a';
  }

  function readInputs(card) {
    var out = [{ sys: '', dia: '', pulse: '' }, { sys: '', dia: '', pulse: '' }];
    $$('input', card).forEach(function (inp) {
      var i = +inp.dataset.i;
      out[i][inp.dataset.f] = inp.value.trim();
    });
    return out;
  }

  function onSaveSlot(key, slot, btn) {
    var card = btn.closest('.slot');
    var readings = readInputs(card).filter(function (r) {
      return r.sys !== '' || r.dia !== '' || r.pulse !== '';
    });

    if (!readings.length) { toast('请至少填写一次血压'); return; }

    for (var i = 0; i < readings.length; i++) {
      var r = readings[i];
      if (!BP.isNum(r.sys) || !BP.isNum(r.dia)) {
        toast('第 ' + (i + 1) + ' 次请填写收缩压和舒张压');
        return;
      }
      var sys = +r.sys, dia = +r.dia, pulse = r.pulse === '' ? null : +r.pulse;
      if (sys < 60 || sys > 260) { toast('收缩压数值异常（60~260）'); return; }
      if (dia < 30 || dia > 160) { toast('舒张压数值异常（30~160）'); return; }
      if (sys <= dia) { toast('收缩压应高于舒张压'); return; }
      if (pulse !== null && (pulse < 30 || pulse > 200)) { toast('心率数值异常（30~200）'); return; }
    }

    if (key >= BP.dateKey()) {
      var win = BP.windowState(key, slot);
      if (!win.open) { toast(win.reason); renderEntry(); return; }
    }

    var db = BP.load();
    BP.saveSlot(db, key, slot, readings);
    if (!BP.save(db)) { toast('保存失败，存储空间不足'); return; }

    toast('已保存');
    renderEntry();
  }

  /* =========================================================
   * 记录页
   * ========================================================= */
  function renderRecords() {
    var db = BP.load();
    var n = state.range;
    var s = BP.stats(db, n);

    $('#recordStats').innerHTML = '' +
      statCard('平均血压', s.sys ? s.sys + '/' + s.dia : '--', 'mmHg', s.days ? '共 ' + s.days + ' 天' : '暂无数据') +
      statCard('平均心率', s.pulse || '--', '次/分', '静息测量') +
      statCard('正常天数占比', s.okRate === null ? '--' : s.okRate, '%', '低于 120/80') +
      statCard('记录天数', s.days, '天', n ? '统计范围内' : '全部记录');

    var pts = BP.trend(db, n);
    var emptyEl = $('#chartEmpty');
    if (!pts.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = '暂无数据，去「填写」页记录第一条';
    } else {
      emptyEl.hidden = true;
    }
    drawChart(pts);

    renderRecordList(db, n);
    renderStorageInfo(db);
  }

  // 本机数据状况：记录天数、最近保存时间、可恢复的备份
  function renderStorageInfo(db) {
    var el = $('#storageInfo');
    if (!el) return;
    var keys = Object.keys(db.records || {});
    var latest = 0;
    keys.forEach(function (k) {
      ['morning', 'evening'].forEach(function (s) {
        var rec = db.records[k][s];
        if (rec && rec.savedAt) latest = Math.max(latest, rec.savedAt);
      });
    });
    var text = keys.length ? '本机共 ' + keys.length + ' 天记录' : '本机暂无记录';
    if (latest) {
      var t = new Date(latest);
      text += ' · 最近保存 ' + (t.getMonth() + 1) + '月' + t.getDate() + '日 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
    }
    var b = BP.backupInfo();
    text += b
      ? ' · 可恢复到上次保存前（' + b.time + '，' + b.days + ' 天）'
      : ' · 暂无可恢复备份';
    el.textContent = text;
  }

  function statCard(label, value, unit, sub) {
    return '' +
      '<div class="stat">' +
        '<div class="stat-label">' + label + '</div>' +
        '<div class="stat-value">' + value + '<span class="unit">' + unit + '</span></div>' +
        '<div class="stat-sub">' + sub + '</div>' +
      '</div>';
  }

  function renderRecordList(db, n) {
    var keys = BP.recentKeys(db, n);
    $('#recordCount').textContent = keys.length ? keys.length + ' 天' : '';
    if (!keys.length) {
      $('#recordList').innerHTML = '<div class="empty-tip">还没有记录，去「填写」页记录第一条吧</div>';
      return;
    }
    var html = keys.map(function (k) {
      var day = db.records[k];
      return '' +
        '<div class="rec-day">' +
          '<div class="rec-date">' +
            '<div class="rec-date-main">' + BP.humanDate(k) + '<span>' + BP.weekday(k) + '</span></div>' +
            (BP.dayAverage(day) ? gradePill(BP.dayAverage(day)) : '') +
          '</div>' +
          '<div class="rec-slots">' + slotCell(day.morning, '早间') + slotCell(day.evening, '晚间') + '</div>' +
        '</div>';
    }).join('');
    $('#recordList').innerHTML = html;
  }

  function slotCell(rec, label) {
    if (!rec || !rec.avg) {
      return '<div class="rec-slot empty"><span class="k">' + label + '</span><span class="v">未记录</span></div>';
    }
    var a = rec.avg;
    var g = BP.grade(a.sys, a.dia);
    return '' +
      '<div class="rec-slot">' +
        '<span class="k">' + label + '</span>' +
        '<span class="v" style="color:' + g.color + '">' + a.sys + '/' + a.dia +
          (a.pulse ? '<small> · 脉 ' + a.pulse + '</small>' : '') +
        '</span>' +
      '</div>';
  }

  function gradePill(avg) {
    var g = BP.grade(avg.sys, avg.dia);
    return '<span class="avg-tag" style="color:' + g.color + ';background:' + g.color + '1a">' + g.text + '</span>';
  }

  /* ---------------- 趋势图 ---------------- */
  function drawChart(points) {
    var canvas = $('#trendChart');
    if (!canvas) return;
    var wrap = canvas.parentElement;
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    if (!w || !h) return;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!points.length) return;

    var css = getComputedStyle(document.documentElement);
    var sysColor = css.getPropertyValue('--sys').trim() || '#ef5b5b';
    var diaColor = css.getPropertyValue('--dia').trim() || '#2f80ed';
    var lineColor = '#eef3f5';
    var textColor = '#93a7b0';

    var padL = 30, padR = 12, padT = 12, padB = 22;
    var iw = w - padL - padR;
    var ih = h - padT - padB;

    var all = [];
    points.forEach(function (p) { all.push(p.sys, p.dia); });
    var min = Math.min.apply(null, all);
    var max = Math.max.apply(null, all);
    min = Math.floor((min - 10) / 20) * 20;
    max = Math.ceil((max + 10) / 20) * 20;
    if (min < 40) min = 40;
    if (max - min < 80) max = min + 80;

    function y(v) { return padT + ih - (v - min) / (max - min) * ih; }
    function x(i) {
      if (points.length === 1) return padL + iw / 2;
      return padL + (i / (points.length - 1)) * iw;
    }

    // 横向网格
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var v = min; v <= max + 0.5; v += 20) {
      var yy = y(v);
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(v, padL - 6, yy);
    }

    // 折线
    function drawLine(key, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach(function (p, i) {
        if (i === 0) ctx.moveTo(x(i), y(p[key]));
        else ctx.lineTo(x(i), y(p[key]));
      });
      ctx.stroke();

      points.forEach(function (p, i) {
        ctx.beginPath();
        ctx.arc(x(i), y(p[key]), 2.8, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
    drawLine('dia', diaColor);
    drawLine('sys', sysColor);

    // X 轴标签（最多 5 个）
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var step = Math.ceil(points.length / 5);
    points.forEach(function (p, i) {
      if (i % step !== 0 && i !== points.length - 1) return;
      if (i === points.length - 1 && points.length > 1 && (points.length - 1) % step === 0) {
        // 已绘制过，跳过重复
      }
      ctx.fillText(p.label, x(i), padT + ih + 8);
    });
  }

  /* ---------------- 数据管理 ---------------- */
  function exportData() {
    var data = BP.exportJSON();
    var blob = new Blob([data], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '血压记录-' + BP.dateKey() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出备份文件');
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        BP.importJSON(String(reader.result));
        toast('导入成功');
        renderRecords();
      } catch (e) {
        toast('导入失败：' + e.message);
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.dataset.view); });
    });

    $$('#rangeSeg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#rangeSeg .seg-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        state.range = +b.dataset.range;
        renderRecords();
      });
    });

    // 补录：选择过去的日期，不受早晚时间限制
    $('#btnBackfill').addEventListener('click', function () {
      state.backfill = !state.backfill;
      state.entryKey = BP.dateKey();
      renderEntry();
    });
    $('#backfillDate').addEventListener('change', function () {
      var v = this.value;
      if (!v) return;
      var today = BP.dateKey();
      if (v > today) { toast('不能补录未来的日期'); this.value = state.entryKey || today; return; }
      state.backfill = true;
      state.entryKey = v;
      renderEntry();
    });
    $('#btnBackToday').addEventListener('click', function () {
      state.backfill = false;
      state.entryKey = BP.dateKey();
      renderEntry();
    });

    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('#btnClear').addEventListener('click', function () {
      if (!confirm('确定要清空所有血压记录吗？清空后可用「恢复到上次保存前」找回，仍建议先导出备份。')) return;
      var db = BP.load();
      db.records = {};
      BP.save(db);
      toast('已清空记录');
      renderRecords();
      renderEntry();
    });

    $('#btnRestore').addEventListener('click', function () {
      var info = BP.backupInfo();
      if (!info) { toast('暂无可恢复的备份'); return; }
      if (!confirm('将恢复到上一次保存前的数据（' + info.time + '，共 ' + info.days + ' 天记录），当前记录会被覆盖。继续？')) return;
      if (BP.restoreBackup()) {
        toast('已恢复');
        renderRecords();
        renderEntry();
      } else {
        toast('恢复失败');
      }
    });

    renderEntry();
    window.addEventListener('resize', function () {
      if (state.view === 'records') renderRecords();
    });

    // 每分钟刷新一次填写页的开放状态（有未保存的输入时不刷新，避免清掉内容）
    setInterval(function () {
      if (state.view === 'entry' && !entryDirty) renderEntry();
    }, 60000);
  }

  window.BPApp = { switchView: switchView, toast: toast, renderEntry: renderEntry };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
