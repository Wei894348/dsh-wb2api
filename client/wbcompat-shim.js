// wbcompat-shim —— 让 functy23/dsh-workbuddy-connect-functy 的浏览器半边跑在
// 本插件（dsh-plugin-wb2api-ui）的宿主数据上。
//
// 为什么要这一层：复刻过来的 UI 是一份完整的 React 客户端，它只认
// `/plugins/dsh-workbuddy-connect-functy/{status,accounts,probe,ai/*}` 六个路由
// 和一份 WorkBuddyWebStatus 文档。本插件宿主侧的数据已经挂在 `/dsh-wb2api/*`
// （state / credits / models / checkin / login / import / account/*），
// 再往宿主里加一套路由就要重启 DSH 才能生效。这里在浏览器侧把 fetch 截住，
// 用现有路由的数据拼出那份文档、把写动作翻译成现有路由的调用 —— 只换一个
// client/client.js 就能上线，刷新页面即可回滚。
//
// 约定（与宿主路由一一对应）：
//   GET  .../status, .../ai/status   ← /dsh-wb2api/{state,credits,models}
//   POST .../accounts, .../ai/accounts ← /dsh-wb2api/{account/*,credits,login/*,import,keepalive}
//   POST .../probe, .../ai/probe      ← /dsh-wb2api/{checkin,credits} + localStorage 偏好
(function () {
  'use strict';

  // 诊断用（无害）：宿主侧加载异常时只有 console 能看到栈，出问题先看这一行。
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', function (event) {
      try {
        var error = event.error || event.message;
        console.error('[wb2api-diag] uncaught:', error && (error.stack || String(error)),
          'at', String(event.filename) + ':' + String(event.lineno) + ':' + String(event.colno));
      } catch (_ignore) { /* 诊断失败不影响加载 */ }
    });
  }

  var PREFIX = '/plugins/dsh-workbuddy-connect-functy';
  var API = '/dsh-wb2api';
  /** 写路由的握手 key：UI 从文档里取它再回填到 X-WorkBuddy-Probe-Key。 */
  var PROBE_KEY = 'wb2api-local';
  var PREFS_KEY = 'wb2api.ui.prefs';
  var DATA_TTL_MS = 4000;

  function readPrefs() {
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      var parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function writePref(key, value) {
    var prefs = readPrefs();
    prefs[key] = value;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (_error) { /* 隐私模式：偏好只在本次会话里生效 */ }
  }

  /** 本地日期 `YYYY-MM-DD`：与宿主 autocheckin 记录（本地日）同口径比较。 */
  function localDayString(date) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function toJsonResponse(value, status) {
    return new Response(JSON.stringify(value), {
      status: status === undefined ? 200 : status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  async function getJson(url) {
    var response = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    var body = await response.json().catch(function () { return undefined; });
    if (!response.ok) {
      throw new Error((body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status));
    }
    return body;
  }

  async function postJson(url, payload) {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload === undefined ? {} : payload),
    });
    var body = await response.json().catch(function () { return undefined; });
    if (!response.ok) {
      throw new Error((body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status));
    }
    return body;
  }

  // --- 数据读取 -------------------------------------------------------------

  var cache = { at: 0, value: null };

  async function loadData(force) {
    var now = Date.now();
    if (!force && cache.value !== null && now - cache.at < DATA_TTL_MS) return cache.value;
    var statePromise = getJson(API + '/state');
    var creditsPromise = getJson(API + '/credits' + (force ? '?force=1' : '')).catch(function () { return null; });
    var modelsPromise = getJson(API + '/models').catch(function () { return null; });
    var checkinPromise = getJson(API + '/checkin-status').catch(function () { return null; });
    var state = await statePromise;
    var creditsBody = await creditsPromise;
    var modelsBody = await modelsPromise;
    var checkinBody = await checkinPromise;
    var value = {
      state: state,
      credits: creditsBody && creditsBody.credits ? creditsBody.credits : null,
      models: modelsBody && Array.isArray(modelsBody.models) ? modelsBody.models : [],
      checkin: checkinBody,
    };
    cache.at = Date.now();
    cache.value = value;
    return value;
  }

  function realmOfVariant(variantId) {
    return variantId === 'workbuddy-ai' ? 'global' : 'cn';
  }

  function segmentTotal(segments) {
    var sum = 0;
    for (var i = 0; i < segments.length; i += 1) {
      var size = Number(segments[i].total);
      if (Number.isFinite(size)) sum += size;
    }
    return Number(sum.toFixed(2));
  }

  function mergePackages(rows) {
    var byKey = new Map();
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var segments = Array.isArray(row.segments) ? row.segments : [];
      for (var j = 0; j < segments.length; j += 1) {
        var segment = segments[j];
        var remain = Number(segment.remaining);
        if (!Number.isFinite(remain) || remain <= 0) continue;
        var size = Number(segment.total);
        var name = typeof segment.source === 'string' && segment.source !== '' ? segment.source : '积分';
        var key = name;
        var previous = byKey.get(key);
        if (previous === undefined) {
          byKey.set(key, {
            packageName: name,
            remain: remain,
            size: Number.isFinite(size) ? Math.max(size, remain) : remain,
          });
        } else {
          previous.remain = Number((previous.remain + remain).toFixed(2));
          previous.size = Number((previous.size + (Number.isFinite(size) ? Math.max(size, remain) : remain)).toFixed(2));
        }
      }
    }
    var packages = Array.from(byKey.values());
    packages.sort(function (a, b) { return b.size - a.size; });
    return packages;
  }

  function buildAccounts(state, creditRows, realm, now) {
    var creditByFile = new Map();
    for (var i = 0; i < creditRows.length; i += 1) creditByFile.set(creditRows[i].file, creditRows[i]);

    var pool = Array.isArray(state.accounts) ? state.accounts : [];
    var mine = pool.filter(function (account) {
      return (account.realm === 'global' ? 'global' : 'cn') === realm;
    });

    var accounts = mine.map(function (account) {
      var credit = creditByFile.get(account.file);
      var ok = credit !== undefined && credit.state === 'ok';
      var segments = ok && Array.isArray(credit.segments) ? credit.segments : [];
      var expiresAtMs = Number(account.expiresAt) > 0 ? Number(account.expiresAt) * 1000 : 0;
      var row = {
        id: account.file,
        uid: account.uid,
        name: typeof account.nickname === 'string' && account.nickname !== ''
          ? account.nickname
          : String(account.uid || '').slice(0, 8),
        origin: 'desktop',
        domain: typeof account.domain === 'string' ? account.domain : '',
        renewable: true,
        enabled: account.disabled !== true,
        available: account.disabled !== true && account.expired !== true,
        expiresAtMs: expiresAtMs,
        lastUsedAtMs: 0,
        addedAtMs: Number.isFinite(Number(account.mtime)) ? Math.round(Number(account.mtime)) : 0,
      };
      if (account.nickname) row.nickname = account.nickname;
      if (ok) {
        row.credits = Number(Number(credit.total).toFixed(2));
        row.creditsTotal = segmentTotal(segments);
        if (credit.fetchedAt) row.creditsAtMs = Number(credit.fetchedAt);
        if (credit.todayUsage && Number(credit.todayUsage.used) > 0) {
          row.creditsUsed = Number(Number(credit.todayUsage.used).toFixed(2));
        }
      } else if (credit !== undefined) {
        row.creditsError = typeof credit.error === 'string' && credit.error !== ''
          ? credit.error
          : '读取失败';
        if (/401|403|凭证|授权/.test(row.creditsError)) row.sessionDead = false;
      }
      if (account.disabled === true) row.enabled = false;
      void now;
      return row;
    });

    var primary;
    for (var k = 0; k < accounts.length; k += 1) {
      if (accounts[k].available) { primary = accounts[k].id; break; }
    }
    if (primary === undefined && accounts.length > 0) primary = accounts[0].id;

    var section = { accounts: accounts };
    if (primary !== undefined) section.primary = primary;
    return { section: section, rows: accounts, mine: mine };
  }

  function buildModels(models, realm) {
    var prefix = realm === 'global' ? 'global:' : 'cn:';
    var rows = [];
    for (var i = 0; i < models.length; i += 1) {
      var model = models[i];
      if (typeof model.id !== 'string' || model.id.indexOf(prefix) !== 0) continue;
      var row = {
        id: model.id,
        name: typeof model.displayName === 'string' && model.displayName !== '' ? model.displayName : model.id.slice(prefix.length),
        contextWindow: Number(model.contextLength) || undefined,
        maxContextWindow: Number(model.contextLength) || undefined,
      };
      // 倍率：宿主 /models 现在带 creditsMult（"0.79x"），卡片按参考实现的口径
      // 显示成 "x0.79"；0 倍率另给 free 徽章。
      if (typeof model.creditsMult === 'string' && model.creditsMult !== '') {
        var mult = model.creditsMult.replace(/x$/i, '');
        row.credits = 'x' + mult;
        if (/^0(?:\.0+)?$/.test(mult)) row.free = true;
      }
      if (typeof model.description === 'string' && model.description !== '') row.description = model.description;
      if (model.supportsImages === true) row.inputModalities = ['text', 'image'];
      rows.push(row);
    }
    return rows;
  }

  function buildDocument(data, variantId) {
    var realm = realmOfVariant(variantId);
    var credits = data.credits;
    var creditRows = credits && Array.isArray(credits.accounts) ? credits.accounts : [];
    var built = buildAccounts(data.state, creditRows, realm, Date.now());
    var prefs = readPrefs();

    var doc = { status: 'signed-out', accounts: built.section, probeKey: PROBE_KEY };
    var mineCredits = creditRows.filter(function (row) {
      var pool = built.mine.filter(function (account) { return account.file === row.file; });
      return pool.length > 0;
    });

    if (built.mine.length > 0) {
      var packages = mergePackages(mineCredits);
      var total = 0;
      for (var i = 0; i < packages.length; i += 1) total += packages[i].remain;

      var primaryFile = built.section.primary;
      var primaryAccount = null;
      for (var j = 0; j < built.mine.length; j += 1) {
        if (built.mine[j].file === primaryFile) { primaryAccount = built.mine[j]; break; }
      }

      doc.status = 'signed-in';
      if (primaryAccount !== null) {
        if (primaryAccount.nickname) doc.nickname = primaryAccount.nickname;
        if (primaryAccount.domain) doc.domain = primaryAccount.domain;
        doc.expiresAt = Number(primaryAccount.expiresAt) * 1000 || undefined;
      }
      doc.source = 'desktop';
      doc.credits = {
        total: Number(total.toFixed(2)),
        accounts: packages,
      };
      if (credits && credits.unlimited > 0) doc.credits.unlimited = true;
      var errored = mineCredits.filter(function (row) { return row.state !== 'ok'; });
      if (errored.length > 0) {
        doc.creditsError = String(errored[0].error || '部分账号读取失败').slice(0, 240);
      }
      doc.models = buildModels(data.models, realm);
      doc.catalog = { source: 'live', fetchedAt: Date.now() };

      // 签到：参考实现的设置页本来就有「每日签到」分组（自动开关 + 每账号一行 +
      // 「立即签到」）。这里把宿主 autocheckin 的记录翻译成它的 WorkBuddyWebCheckin，
      // 于是签到是**原生界面**，不额外画控件。
      if (data.checkin && Array.isArray(data.checkin.rows)) {
        var byUid = {};
        for (var m = 0; m < built.mine.length; m += 1) byUid[built.mine[m].uid] = built.mine[m].file;
        var checkinRows = [];
        for (var n = 0; n < data.checkin.rows.length; n += 1) {
          var source = data.checkin.rows[n];
          var accountId = byUid[source.uid];
          if (accountId === undefined) continue;
          var row = { accountId: accountId };
          if (typeof source.day === 'string') row.day = source.day;
          if (Number(source.atMs) > 0) row.atMs = Number(source.atMs);
          if (typeof source.state === 'string') row.state = source.state;
          if (typeof source.reason === 'string' && source.reason !== '') row.reason = source.reason;
          checkinRows.push(row);
        }
        doc.checkin = { auto: data.checkin.auto === true, rows: checkinRows };
      }
    }

    if (prefs.sidebarCreditStyle === 'remaining' || prefs.sidebarCreditStyle === 'usage') {
      doc.sidebarCreditStyle = prefs.sidebarCreditStyle;
    }
    if (typeof prefs.sidebarCreditVisible === 'boolean') doc.sidebarCreditVisible = prefs.sidebarCreditVisible;
    if (typeof prefs.composerCreditVisible === 'boolean') doc.composerCreditVisible = prefs.composerCreditVisible;
    if (typeof prefs.probeControlVisible === 'boolean') doc.probeControlVisible = prefs.probeControlVisible;
    if (typeof prefs.useMaximumContextWindow === 'boolean') doc.useMaximumContextWindow = prefs.useMaximumContextWindow;
    return doc;
  }

  // --- 写动作 ---------------------------------------------------------------

  function decodeJwtPayload(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length < 2) return null;
      var base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base.length % 4 !== 0) base += '=';
      return JSON.parse(window.atob(base));
    } catch (_error) {
      return null;
    }
  }

  async function handleAccounts(action, realm) {
    var kind = action && action.action;

    if (kind === 'refresh-credits') {
      cache.value = null;
      await getJson(API + '/credits?force=1');
      return { state: 'ok' };
    }
    if (kind === 'enable') {
      await postJson(API + '/account/toggle', { file: String(action.id || ''), enabled: action.enabled === true });
      return { state: 'ok' };
    }
    if (kind === 'remove') {
      await postJson(API + '/account/delete', { file: String(action.id || '') });
      return { state: 'ok' };
    }
    if (kind === 'reorder') return { state: 'ok' };
    if (kind === 'test') {
      var testPool = await getJson(API + '/state');
      var target = null;
      var list = Array.isArray(testPool.accounts) ? testPool.accounts : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].file === action.id) { target = list[i]; break; }
      }
      if (target === null) return { state: 'failed', reason: '找不到这个账号' };
      var alive = await postJson(API + '/keepalive', { uid: target.uid });
      var result = alive && alive.result ? alive.result : null;
      var rows = result && Array.isArray(result.results) ? result.results : [];
      var own = rows.length > 0 ? rows[0] : null;
      return {
        state: 'ok',
        test: {
          ok: own === null ? true : own.ok === true,
          message: own === null ? '保活请求已发出' : String(own.message || (own.ok === true ? '通过' : '失败')),
        },
      };
    }
    if (kind === 'add') {
      var started = await postJson(API + '/login/begin', { realm: realm });
      var expires = Number(started.expiresAt) > 0
        ? Number(started.expiresAt) * 1000
        : (Number(started.expiresAtMs) > 0 ? Number(started.expiresAtMs) : Date.now() + 300000);
      return {
        state: 'ok',
        challenge: {
          state: String(started.state || ''),
          authUrl: String(started.authUrl || started.url || ''),
          expiresAtMs: expires,
        },
      };
    }
    if (kind === 'poll') {
      try {
        var polled = await postJson(API + '/login/poll', { realm: realm, state: String(action.state || '') });
        var account = polled && polled.account ? polled.account : null;
        if (account === null) return { state: 'waiting' };
        cache.value = null;
        return {
          state: 'added',
          name: String(account.nickname || account.uid || '账号'),
          created: true,
        };
      } catch (error) {
        var message = error instanceof Error ? error.message : String(error);
        // 「还没扫码 / 还没确认」不是故障：上游用 code=11217 + msg="login ing"
        // 表示登录进行中，宿主按可重试处理。宽一点匹配，别把等待渲染成错误。
        if (/202|pending|11217|login\s*ing|未确认|未完成|尚未|等待/i.test(message)) return { state: 'waiting' };
        throw error;
      }
    }
    if (kind === 'cancel') return { state: 'ok' };
    if (kind === 'add-cookie') {
      var token = String(action.token || '').trim();
      if (token === '') return { state: 'failed', reason: '令牌为空' };
      var claims = decodeJwtPayload(token);
      var uid = claims && typeof claims.sub === 'string' ? claims.sub : '';
      if (uid === '') return { state: 'failed', reason: '令牌里没有 sub，无法确定账号' };
      var issuerHost = claims && typeof claims.iss === 'string' ? claims.iss.replace(/^https?:\/\//, '').split('/')[0] : '';
      var isGlobal = /workbuddy\.ai$/i.test(issuerHost);
      var expiresAt = claims && Number(claims.exp) > 0 ? Number(claims.exp) : 0;
      var nickname = claims && typeof claims.preferred_username === 'string' ? claims.preferred_username : uid.slice(0, 8);
      await postJson(API + '/import', {
        document: {
          account: { uid: uid, nickname: nickname, enterpriseId: '' },
          auth: {
            accessToken: token,
            refreshToken: '',
            expiresAt: expiresAt,
            domain: issuerHost || (isGlobal ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
            realm: isGlobal ? 'global' : 'cn',
          },
        },
      });
      cache.value = null;
      return { state: 'added', name: nickname, created: true };
    }
    if (kind === 'adopt-desktop') {
      return {
        state: 'failed',
        reason: '本插件不走面板内接管：请在宿主机跑 tools/wb_import.mjs --write（WorkBuddy 桌面端登录态导入）。',
      };
    }
    if (kind === 'label') {
      return { state: 'failed', reason: '本插件的账号池没有自定义标签字段' };
    }
    if (kind === 'context') {
      return { state: 'failed', reason: '本插件不按模型切换上下文长度' };
    }
    return { state: 'failed', reason: '未知动作：' + String(kind) };
  }

  async function handleProbe(action) {
    var kind = action && action.action;
    if (kind === 'refresh') {
      cache.value = null;
      await getJson(API + '/credits?force=1').catch(function () { return null; });
      return { state: 'ok' };
    }
    if (kind === 'check-in') {
      var body = {};
      if (typeof action.account === 'string' && action.account !== '') {
        var pool = await getJson(API + '/state');
        var rows = Array.isArray(pool.accounts) ? pool.accounts : [];
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i].uid === action.account || rows[i].file === action.account) {
            body.uid = rows[i].uid;
            break;
          }
        }
      }
      var result = await postJson(API + '/checkin', body);
      cache.value = null;
      return { state: 'ok', name: result && result.result ? '签到已执行' : undefined };
    }
    if (kind === 'set-sidebar-credit-style') {
      if (action.creditStyle === 'remaining' || action.creditStyle === 'usage') writePref('sidebarCreditStyle', action.creditStyle);
      return { state: 'ok' };
    }
    if (kind === 'set-sidebar-credit-visible') {
      writePref('sidebarCreditVisible', action.enabled !== false);
      return { state: 'ok' };
    }
    if (kind === 'set-composer-credit-visible') {
      writePref('composerCreditVisible', action.enabled !== false);
      return { state: 'ok' };
    }
    if (kind === 'set-probe-control-visible') {
      writePref('probeControlVisible', action.enabled !== false);
      return { state: 'ok' };
    }
    if (kind === 'set-maximum-context-window') {
      writePref('useMaximumContextWindow', action.enabled !== false);
      return { state: 'ok' };
    }
    if (kind === 'open-link') {
      var url = String(action.url || '');
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
      return { state: 'ok' };
    }
    if (kind === 'clear' || kind === 'set-model-visibility' || kind === 'set-model-allowlist') {
      return { state: 'ok' };
    }
    if (kind === 'probe') {
      return { state: 'failed', reason: '本插件不做推理能力探测（模型清单直接取自网关 /v1/models）' };
    }
    return { state: 'ok' };
  }

  function variantOf(url) {
    var path = String(url);
    if (path.indexOf(PREFIX) !== 0) return null;
    var rest = path.slice(PREFIX.length);
    var global = rest.indexOf('/ai/') === 0;
    var tail = global ? rest.slice(4) : rest;
    var name = tail.replace(/^\//, '').split('?')[0];
    if (name !== 'status' && name !== 'accounts' && name !== 'probe') return null;
    return { kind: name, variantId: global ? 'workbuddy-ai' : 'workbuddy', realm: global ? 'global' : 'cn' };
  }

  var originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    var route = variantOf(url);
    if (route === null) return originalFetch(input, init);

    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    if (route.kind === 'status' && method === 'GET') {
      try {
        var data = await loadData(false);
        return toJsonResponse(buildDocument(data, route.variantId));
      } catch (error) {
        var message = error instanceof Error ? error.message : String(error);
        return toJsonResponse({ status: 'error', message: message }, 200);
      }
    }

    if (route.kind === 'accounts' && method === 'POST') {
      var action = {};
      try {
        action = JSON.parse(String((init && init.body) || '{}'));
      } catch (_error) {
        return toJsonResponse({ state: 'failed', reason: '请求体不是 JSON' }, 200);
      }
      try {
        return toJsonResponse(await handleAccounts(action, route.realm));
      } catch (error) {
        var reason = error instanceof Error ? error.message : String(error);
        return toJsonResponse({ state: 'failed', reason: reason }, 200);
      }
    }

    if (route.kind === 'probe' && method === 'POST') {
      var probeAction = {};
      try {
        probeAction = JSON.parse(String((init && init.body) || '{}'));
      } catch (_error) {
        return toJsonResponse({ state: 'failed', reason: '请求体不是 JSON' }, 200);
      }
      try {
        return toJsonResponse(await handleProbe(probeAction));
      } catch (error) {
        var probeReason = error instanceof Error ? error.message : String(error);
        return toJsonResponse({ state: 'failed', reason: probeReason }, 200);
      }
    }

    return originalFetch(input, init);
  };

  // --- 参考界面里没有的入口：补一个「WorkBuddy 工具」分区 --------------------
  //
  // 参考项目的设置页只有「账号 / 模型」两页，网关重启与成长任务领取没有落点。
  // 这里用它**自己的样式类**（wbp-*）在同一个 settings.section 槽位里再挂一页，
  // 骨架与它逐行一致（.wbp-section → .wbp-group → .wbp-row），所以看上去是同一
  // 套界面的一部分；代码留在这层，vendor bundle 保持逐字节原样。

  function makeToolsComponent(React) {
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    /**
     * 三件套与参考界面同一套类名：一行 = 文案块 + 右侧控件，一组 = 标题 + 行容器。
     * 定义在 makeToolsComponent 里而不是模块级，这样它们拿到的 props 就是槽位
     * 直接传进来的那一个（模块级签名写成 (React, props) 会被 React 当成 props，
     * 拿到的 React 其实是 props —— 冒烟里当场炸成 "h is not a function"）。
     */
    function toolsRow(props) {
      return h('div', { className: 'wbp-row' },
        h('div', { className: 'wbp-rowText' },
          h('span', { className: 'wbp-rowTitle' }, props.title),
          props.desc ? h('span', { className: 'wbp-rowDesc' }, props.desc) : null),
        h('div', { className: 'wbp-rowControl' }, props.children));
    }

    function toolsGroup(props) {
      return h('div', { className: 'wbp-group' },
        h('div', { className: 'wbp-groupHead' },
          h('h3', { className: 'wbp-groupTitle' }, props.title)),
        props.desc ? h('p', { className: 'wbp-groupDesc' }, props.desc) : null,
        h('div', { className: 'wbp-rows' }, props.children));
    }

    function toolsButton(props) {
      return h('button', {
        type: 'button',
        className: 'wbp-linkButton',
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.label);
    }

    return function WorkBuddyTools() {
      const [gateway, setGateway] = useState({ phase: 'idle', text: '—', note: '', busy: false });
      const [tasks, setTasks] = useState({ running: false, pending: null, summary: null, logs: [], note: '', });
      /** 今日签到：phase=idle/ready/error；rows 里 today 由本地日期与记录 day 比出来。 */
      const [checkin, setCheckin] = useState({ phase: 'idle', day: '', rows: [], note: '', busy: false });
      // 凭证 JSON 粘贴：参考界面的「添加账号」只有扫码 / 令牌两条路，本插件一直
      // 支持整份凭证 JSON（含 refreshToken），这里补一个输入框，走宿主 /import。

      const loadGateway = useCallback(async () => {
        setGateway((prev) => ({ ...prev, phase: 'loading' }));
        try {
          const response = await fetch('/dsh-wb2api/state', { headers: { accept: 'application/json' } });
          const body = await response.json();
          const pool = body && body.gateway ? body.gateway : {};
          const accounts = Array.isArray(body && body.accounts) ? body.accounts : [];
          const usable = accounts.filter((account) => account.disabled !== true).length;
          const health = pool.health ? pool.health : {};
          setGateway({
            phase: 'ready',
            busy: false,
            text: (pool.running === true ? '运行中' : '未运行')
              + ' · ' + String(pool.baseURL || '—')
              + ' · 可用账号 ' + usable + '/' + accounts.length,
            note: health.service
              ? '健康 ' + String(health.healthy === undefined ? '—' : health.healthy) + '/' + String(health.total === undefined ? '—' : health.total)
              : '',
          });
        } catch (error) {
          setGateway({ phase: 'error', busy: false, text: '读取网关状态失败', note: String((error && error.message) || error) });
        }
      }, []);

      const restartGateway = useCallback(async () => {
        setGateway((prev) => ({ ...prev, busy: true, note: '正在重启网关…' }));
        try {
          const response = await fetch('/dsh-wb2api/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          });
          const body = await response.json().catch(() => ({}));
          const state = typeof body.state === 'string' ? body.state : (response.ok ? 'ok' : 'failed');
          const health = body && body.health ? body.health : null;
          const took = Number(body && body.tookMs);
          const parts = ['重启 ' + state];
          if (health) parts.push('可用账号 ' + String(health.healthy === undefined ? '—' : health.healthy) + '/' + String(health.total === undefined ? '—' : health.total));
          if (Number.isFinite(took) && took > 0) parts.push('用时 ' + (took / 1000).toFixed(1) + ' 秒');
          setGateway((prev) => ({ ...prev, busy: false, note: parts.join(' · ') }));
          await loadGateway();
        } catch (error) {
          setGateway((prev) => ({ ...prev, busy: false, note: '重启失败：' + String((error && error.message) || error) }));
        }
      }, [loadGateway]);

      const loadTasks = useCallback(async () => {
        try {
          const response = await fetch('/dsh-wb2api/tasks/status', { headers: { accept: 'application/json' } });
          const body = await response.json();
          setTasks({
            running: body.running === true,
            pending: body.pending || null,
            summary: body.summary || null,
            logs: Array.isArray(body.logs) ? body.logs.slice(-6) : [],
            note: typeof body.error === 'string' && body.error !== '' ? body.error : '',
          });
        } catch (error) {
          setTasks((prev) => ({ ...prev, note: String((error && error.message) || error) }));
        }
      }, []);

      const runTasks = useCallback(async () => {
        setTasks((prev) => ({ ...prev, running: true, note: '已开始执行，进度见下方日志' }));
        try {
          const response = await fetch('/dsh-wb2api/tasks/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          });
          const body = await response.json().catch(() => ({}));
          if (body && body.started === false) {
            setTasks((prev) => ({ ...prev, running: body.running === true, note: String(body.message || '已有一轮在执行') }));
          }
        } catch (error) {
          setTasks((prev) => ({ ...prev, running: false, note: '启动失败：' + String((error && error.message) || error) }));
        }
      }, []);

      /** 今日签到：宿主 autocheckin 记录 + 账号昵称，按本地日期比出「今日已签到」。 */
      const loadCheckin = useCallback(async () => {
        try {
          const [statusResponse, stateResponse] = await Promise.all([
            fetch('/dsh-wb2api/checkin-status', { headers: { accept: 'application/json' } }),
            fetch('/dsh-wb2api/state', { headers: { accept: 'application/json' } }),
          ]);
          if (!statusResponse.ok) throw new Error('HTTP ' + statusResponse.status);
          const status = await statusResponse.json().catch(() => ({}));
          const pool = stateResponse.ok ? await stateResponse.json().catch(() => ({})) : {};
          const byUid = new Map();
          for (const account of (Array.isArray(pool.accounts) ? pool.accounts : [])) byUid.set(account.uid, account);
          const today = localDayString(new Date());
          const rows = (Array.isArray(status.rows) ? status.rows : []).map((row) => {
            const account = byUid.get(row.uid) || byUid.get(row.accountId);
            return {
              uid: String(row.uid || row.accountId || ''),
              name: (account && account.nickname) || String(row.uid || '').slice(0, 8),
              today: row.day === today,
              day: typeof row.day === 'string' ? row.day : '',
              state: typeof row.state === 'string' ? row.state : '',
              reason: typeof row.reason === 'string' ? row.reason : '',
            };
          });
          setCheckin({ phase: 'ready', day: typeof status.day === 'string' ? status.day : '', rows: rows, note: '', busy: false });
        } catch (error) {
          setCheckin((prev) => ({ ...prev, phase: 'error', busy: false, note: '签到状态读取失败：' + String((error && error.message) || error) }));
        }
      }, []);

      const runCheckin = useCallback(async () => {
        setCheckin((prev) => ({ ...prev, busy: true, note: '正在签到…' }));
        try {
          const response = await fetch('/dsh-wb2api/checkin', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'HTTP ' + response.status);
          await loadCheckin();
          setCheckin((prev) => ({ ...prev, busy: false }));
        } catch (error) {
          setCheckin((prev) => ({ ...prev, busy: false, note: '签到失败：' + String((error && error.message) || error) }));
        }
      }, [loadCheckin]);

      useEffect(() => { void loadGateway(); void loadTasks(); void loadCheckin(); }, [loadGateway, loadTasks, loadCheckin]);
      useEffect(() => {
        const timer = setInterval(() => { void loadTasks(); }, 3000);
        return () => clearInterval(timer);
      }, [loadTasks]);

      const pendingTotal = tasks.pending && Number.isFinite(Number(tasks.pending.total)) ? Number(tasks.pending.total) : null;
      const taskTitle = tasks.running
        ? '任务执行中…'
        : pendingTotal === null
          ? (tasks.summary ? '上一轮已完成' : '当前没有待办')
          : '待办 ' + pendingTotal + ' 项';

      // 折进参考页面里渲染（同一个 wbp-section 列），所以这里只出分组、不再自建列。
      return h(React.Fragment, null,
        h(toolsGroup, { title: '每日签到', desc: '宿主每天自动签到一次；这里显示每个账号今天签没签，也可以手动补一次。' },
          h(toolsRow, {
            title: checkin.phase === 'ready'
              ? '今日已签到 ' + checkin.rows.filter((row) => row.today).length + '/' + checkin.rows.length
              : (checkin.phase === 'error' ? '签到状态读取失败' : '读取中…'),
            desc: checkin.note || (checkin.day !== '' ? '最近一次记录：' + checkin.day : null),
          }, h(toolsButton, { label: checkin.busy ? '签到中…' : '立即签到', disabled: checkin.busy, onClick: runCheckin })),
          checkin.rows.length === 0 ? null : h('div', { className: 'wbp-rows' },
            checkin.rows.map((row) => h('div', { key: row.uid, className: 'wbp-row wbp-rowFlush' },
              h('div', { className: 'wbp-rowText' },
                h('span', { className: 'wbp-rowTitle' }, row.name),
                h('span', { className: 'wbp-rowDesc', style: row.today ? { color: 'var(--dsw-alias-state-success-primary, #16a34a)' } : undefined },
                  row.today
                    ? '今日已签到'
                    : (row.state === 'failed' ? '上次失败：' + (row.reason || '未知原因') : '今日未签到'))))))),
        h(toolsGroup, { title: '网关', desc: '自托管网关进程（WorkBuddy / CodeBuddy 账号池反代）。抽风时重启一次即可，端口僵死会被清掉。' },
          h(toolsRow, {
            title: gateway.phase === 'loading' ? '读取中…' : gateway.text,
            desc: gateway.note || null,
          }, h(toolsButton, { label: gateway.busy ? '重启中…' : '重启网关', disabled: gateway.busy, onClick: restartGateway }))),
        h(toolsGroup, { title: '成长任务', desc: '一键确认待办 → 执行 → 达标自动领奖。执行在宿主后台跑，可以离开本页。' },
          h(toolsRow, { title: taskTitle, desc: tasks.note || null },
            h(toolsButton, { label: tasks.running ? '领取中…' : '领取任务积分', disabled: tasks.running, onClick: runTasks })),
          tasks.logs.length === 0 ? null : h('div', { className: 'wbp-rows' },
            tasks.logs.map((line, index) => h('div', { key: String(index), className: 'wbp-row wbp-rowFlush' },
              h('div', { className: 'wbp-rowText' }, h('span', { className: 'wbp-hint' }, String(line))))))));
    };
  }

  /**
   * 工具块（网关 / 成长任务）的工厂暴露给构建产物里那段注入代码。
   *
   * **不再碰 `window.__ModuleLoader__`。** 宿主 0.2.1 的浏览器加载器是 bootstrap
   * facade 形态，早先那套「换掉 loader.load、再包 exports.apply」在本版本上把宿主
   * 加载器换坏过一次（DSH 直接起不来）。现在由 tools/build_client.mjs 把一小段
   * 补丁注入 vendor 的 `apply` 内部完成「合页」：拦 `ctx.slots.register`，把设置页
   * 裹成「原页面 + 工具块」的 Fragment —— 效果和之前一致，但不碰模块加载面。
   */
  window.__wb2apiToolsFactory = makeToolsComponent;

  // 让同一页面的其它脚本能手动清缓存（调试用）。
  window.__wb2apiShim = {
    invalidate: function () { cache.value = null; },
    prefs: readPrefs,
    prefix: PREFIX,
    /** 供冒烟脚本直接喂数据验映射（浏览器里没人用）。 */
    buildDocument: buildDocument,
    buildModels: buildModels,
  };
})();
