/* =========================================================
 * storage.js —— 数据层：本地存储、时间窗口、平均值计算
 * ========================================================= */
var BP = (function () {
  'use strict';

  var KEY = 'bp_log_v1';
  var BACKUP_KEY = 'bp_log_v1_backup';

  var DEFAULT_DB = {
    version: 1,
    records: {},
    settings: {
      api: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
      profile: { name: '', age: '', gender: '' }
    },
    ai: { messages: [] }
  };

  /* ---------- 基础读写 ---------- */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) return clone(DEFAULT_DB);
    var db;
    try { db = JSON.parse(raw); } catch (e) { return clone(DEFAULT_DB); }
    if (!db || typeof db !== 'object') return clone(DEFAULT_DB);
    db.version = 1;
    db.records = db.records && typeof db.records === 'object' ? db.records : {};
    db.settings = db.settings || {};
    db.settings.api = Object.assign({}, DEFAULT_DB.settings.api, db.settings.api || {});
    db.settings.profile = Object.assign({}, DEFAULT_DB.settings.profile, db.settings.profile || {});
    db.ai = db.ai || { messages: [] };
    db.ai.messages = Array.isArray(db.ai.messages) ? db.ai.messages : [];
    return db;
  }

  function save(db) {
    try {
      var raw = JSON.stringify(db);
      var prev = null;
      try { prev = localStorage.getItem(KEY); } catch (e2) { prev = null; }
      localStorage.setItem(KEY, raw);
      // 每次保存前把旧数据留在备份里，误清空/误导入后可恢复到上一次保存前
      if (prev) {
        try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: Date.now(), raw: prev })); } catch (e3) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- 上次保存前的备份 ---------- */
  function backupInfo() {
    try {
      var b = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
      if (!b || !b.raw) return null;
      var d = JSON.parse(b.raw);
      var t = new Date(b.savedAt);
      return {
        days: Object.keys(d.records || {}).length,
        savedAt: b.savedAt,
        time: (t.getMonth() + 1) + '月' + t.getDate() + '日 ' + pad(t.getHours()) + ':' + pad(t.getMinutes())
      };
    } catch (e) {
      return null;
    }
  }

  function restoreBackup() {
    try {
      var b = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
      if (!b || !b.raw) return false;
      JSON.parse(b.raw);
      localStorage.setItem(KEY, b.raw);
      return true;
    } catch (e) {
      return false;
    }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- 日期工具 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseKey(key) {
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function humanDate(key) {
    var d = parseKey(key);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function weekday(key) {
    return WEEK[parseKey(key).getDay()];
  }

  /* ---------- 时间窗口 ----------
   * 早间：当天 00:00 ~ 11:59 可填写，12:00 后锁定
   * 晚间：当天 12:00 ~ 23:59 可填写，次日 00:00 后锁定
   * -------------------------------------------------------- */
  function windowState(key, slot, now) {
    now = now || new Date();
    var d = parseKey(key);
    var y = d.getFullYear(), m = d.getMonth(), day = d.getDate();

    var start = slot === 'morning'
      ? new Date(y, m, day, 0, 0, 0, 0)
      : new Date(y, m, day, 12, 0, 0, 0);
    var end = slot === 'morning'
      ? new Date(y, m, day, 12, 0, 0, 0)
      : new Date(y, m, day + 1, 0, 0, 0, 0);

    if (now < start) {
      return { open: false, future: true, reason: slot === 'morning' ? '今天的记录还没开始' : '晚间记录 12:00 后开放' };
    }
    if (now >= end) {
      return { open: false, future: false, reason: slot === 'morning' ? '已过中午 12 点，早间数据已锁定' : '已过凌晨 12 点，晚间数据已锁定' };
    }
    return { open: true, future: false, reason: '' };
  }

  /* ---------- 记录操作 ---------- */
  function getDay(db, key) {
    return db.records[key] || null;
  }

  function getSlot(db, key, slot) {
    var day = db.records[key];
    return day && day[slot] ? day[slot] : null;
  }

  // 平均：只填一次时，平均值即该次数值
  function average(readings) {
    var list = readings.filter(function (r) {
      return r && isNum(r.sys) && isNum(r.dia);
    });
    if (!list.length) return null;
    var s = { sys: 0, dia: 0, pulse: 0, pulseCount: 0 };
    list.forEach(function (r) {
      s.sys += +r.sys;
      s.dia += +r.dia;
      if (isNum(r.pulse)) { s.pulse += +r.pulse; s.pulseCount++; }
    });
    return {
      sys: Math.round(s.sys / list.length),
      dia: Math.round(s.dia / list.length),
      pulse: s.pulseCount ? Math.round(s.pulse / s.pulseCount) : null
    };
  }

  function isNum(v) {
    return v !== null && v !== undefined && v !== '' && !isNaN(+v);
  }

  function saveSlot(db, key, slot, readings) {
    var clean = readings
      .filter(function (r) { return isNum(r.sys) && isNum(r.dia); })
      .map(function (r) {
        return {
          sys: Math.round(+r.sys),
          dia: Math.round(+r.dia),
          pulse: isNum(r.pulse) ? Math.round(+r.pulse) : null
        };
      });
    if (!clean.length) return false;

    if (!db.records[key]) db.records[key] = {};
    db.records[key][slot] = {
      readings: clean,
      avg: average(clean),
      savedAt: Date.now()
    };
    return true;
  }

  /* ---------- 血压分级 ---------- */
  // 返回 { level, text, color }
  function grade(sys, dia) {
    if (!isNum(sys) || !isNum(dia)) return { level: 'none', text: '--', color: 'var(--ink-3)' };
    sys = +sys; dia = +dia;
    if (sys < 90 || dia < 60) return { level: 'low', text: '偏低', color: 'var(--low)' };
    if (sys < 120 && dia < 80) return { level: 'ok', text: '正常', color: 'var(--ok)' };
    if (sys < 140 && dia < 90) return { level: 'warn', text: '正常高值', color: 'var(--warn)' };
    if (sys >= 180 || dia >= 110) return { level: 'bad', text: '很高', color: 'var(--bad)' };
    return { level: 'bad', text: '高血压', color: 'var(--bad)' };
  }

  /* ---------- 汇总 ---------- */
  // 取最近 n 天的日期键（n=0 表示全部），按日期倒序
  function recentKeys(db, n) {
    var keys = Object.keys(db.records).filter(function (k) {
      return db.records[k] && (db.records[k].morning || db.records[k].evening);
    }).sort();
    if (n > 0) keys = keys.slice(-n);
    return keys.reverse();
  }

  // 每天的综合平均值（早 + 晚）
  function dayAverage(day) {
    var avgs = [];
    if (day.morning && day.morning.avg) avgs.push(day.morning.avg);
    if (day.evening && day.evening.avg) avgs.push(day.evening.avg);
    if (!avgs.length) return null;
    return average(avgs.map(function (a) {
      return { sys: a.sys, dia: a.dia, pulse: a.pulse };
    }));
  }

  // 近 n 天的统计
  function stats(db, n) {
    var keys = recentKeys(db, n);
    var sysSum = 0, diaSum = 0, pulseSum = 0, pulseN = 0, dayN = 0, okN = 0;
    keys.forEach(function (k) {
      var a = dayAverage(db.records[k]);
      if (!a) return;
      dayN++;
      sysSum += a.sys;
      diaSum += a.dia;
      if (a.pulse) { pulseSum += a.pulse; pulseN++; }
      if (grade(a.sys, a.dia).level === 'ok') okN++;
    });
    return {
      days: dayN,
      sys: dayN ? Math.round(sysSum / dayN) : null,
      dia: dayN ? Math.round(diaSum / dayN) : null,
      pulse: pulseN ? Math.round(pulseSum / pulseN) : null,
      okRate: dayN ? Math.round(okN / dayN * 100) : null
    };
  }

  // 趋势数据：按日期正序
  function trend(db, n) {
    var keys = recentKeys(db, n).reverse();
    return keys.map(function (k) {
      var a = dayAverage(db.records[k]);
      return a ? { key: k, label: humanDate(k), sys: a.sys, dia: a.dia } : null;
    }).filter(Boolean);
  }

  /* ---------- 备份 ---------- */
  function exportJSON() {
    return JSON.stringify(load(), null, 2);
  }

  function importJSON(text) {
    var data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !data.records) {
      throw new Error('文件格式不正确');
    }
    var db = load();
    Object.keys(data.records).forEach(function (k) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) db.records[k] = data.records[k];
    });
    if (data.settings) {
      if (data.settings.api) db.settings.api = Object.assign(db.settings.api, data.settings.api);
      if (data.settings.profile) db.settings.profile = Object.assign(db.settings.profile, data.settings.profile);
    }
    return save(db);
  }

  return {
    KEY: KEY,
    load: load,
    save: save,
    dateKey: dateKey,
    humanDate: humanDate,
    weekday: weekday,
    windowState: windowState,
    getDay: getDay,
    getSlot: getSlot,
    saveSlot: saveSlot,
    average: average,
    grade: grade,
    isNum: isNum,
    recentKeys: recentKeys,
    dayAverage: dayAverage,
    stats: stats,
    trend: trend,
    exportJSON: exportJSON,
    importJSON: importJSON,
    backupInfo: backupInfo,
    restoreBackup: restoreBackup
  };
})();
