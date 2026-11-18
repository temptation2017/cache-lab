'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CacheLab = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var DELTA_NAMES = {
    'max-age': 1,
    's-maxage': 1,
    'min-fresh': 1,
    'stale-while-revalidate': 1,
    'stale-if-error': 1
  };
  // max-stale may appear with or without a delta
  var FLAG_NAMES = {
    'no-store': 1,
    'no-transform': 1,
    'only-if-cached': 1,
    'must-revalidate': 1,
    'proxy-revalidate': 1,
    'must-understand': 1,
    'public': 1,
    'immutable': 1
  };
  var FIELD_LIST_NAMES = {
    'no-cache': 1,
    'private': 1
  };
  var DEFAULT_CACHEABLE_STATUS = {
    200: 1, 203: 1, 204: 1, 206: 1,
    300: 1, 301: 1, 308: 1,
    404: 1, 405: 1, 410: 1, 414: 1, 501: 1
  };
  var HEURISTIC_CAP = 24 * 3600;

  function trim(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  function toMs(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && isFinite(value)) return value;
    if (value instanceof Date) {
      var t = value.getTime();
      return isFinite(t) ? t : null;
    }
    var n = Number(value);
    if (typeof value === 'string' && value !== '' && isFinite(n) && /^\d+$/.test(trim(value))) {
      return n;
    }
    var p = parseHttpDate(String(value));
    return p;
  }

  function headerFirst(parsed, name) {
    var item = parsed.map[name.toLowerCase()];
    if (!item || !item.values.length) return null;
    return item.values[0];
  }

  function headerJoin(parsed, name) {
    var item = parsed.map[name.toLowerCase()];
    if (!item || !item.values.length) return '';
    return item.values.join(', ');
  }

  function hasHeader(parsed, name) {
    var item = parsed.map[name.toLowerCase()];
    return !!(item && item.values.length);
  }

  function parseHeaders(text) {
    var errors = [];
    var lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var status = null;
    var method = null;
    var map = {};
    var i = 0;
    var lastKey = null;
    while (i < lines.length && trim(lines[i]) === '') i++;
    if (i < lines.length) {
      var statusMatch = lines[i].match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+(.*))?$/i);
      if (statusMatch) {
        status = parseInt(statusMatch[1], 10);
        i++;
      } else {
        var reqMatch = lines[i].match(/^([A-Za-z]+)\s+\S+\s+HTTP\/\d/i);
        if (reqMatch) {
          method = reqMatch[1].toUpperCase();
          i++;
        }
      }
    }
    for (; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim() === '') continue;
      if (/^[ \t]/.test(line) && lastKey) {
        map[lastKey].values[map[lastKey].values.length - 1] += ' ' + trim(line);
        continue;
      }
      var idx = line.indexOf(':');
      if (idx < 1) {
        errors.push('无法解析的行：' + line);
        continue;
      }
      var rawName = trim(line.slice(0, idx));
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(rawName)) {
        errors.push('非法的头字段名：' + rawName);
        continue;
      }
      var value = trim(line.slice(idx + 1));
      var key = rawName.toLowerCase();
      if (!map[key]) map[key] = { rawName: rawName, values: [] };
      map[key].values.push(value);
      lastKey = key;
    }
    return { status: status, method: method, map: map, errors: errors };
  }

  // IMF-fixdate, RFC 850, asctime; also ISO-8601 for the "now" field.
  function parseHttpDate(value) {
    if (value == null) return null;
    var s = trim(value);
    if (!s) return null;
    if (/^0$/.test(s) || /^-1$/.test(s)) return 0;
    var iso = Date.parse(s);
    if (isFinite(iso)) return iso;
    var withGmt = Date.parse(s + ' GMT');
    if (isFinite(withGmt)) return withGmt;
    return null;
  }

  function parseDelta(raw) {
    if (raw == null) return { ok: false, error: '缺少取值' };
    var s = trim(String(raw));
    if (!/^\d+$/.test(s)) return { ok: false, error: '不是非负整数：' + raw };
    var n = parseInt(s, 10);
    if (!isFinite(n)) return { ok: false, error: '不是非负整数：' + raw };
    return { ok: true, value: n };
  }

  function splitCommaList(input) {
    var parts = [];
    var buf = '';
    var inQuote = false;
    var i, c;
    for (i = 0; i < input.length; i++) {
      c = input[i];
      if (c === '"') {
        inQuote = !inQuote;
        buf += c;
      } else if (c === ',' && !inQuote) {
        if (trim(buf)) parts.push(trim(buf));
        buf = '';
      } else {
        buf += c;
      }
    }
    if (trim(buf)) parts.push(trim(buf));
    return parts;
  }

  function unquote(s) {
    s = trim(s);
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
      return s.slice(1, -1).replace(/\\"/g, '"');
    }
    return s;
  }

  function parseFieldList(raw) {
    if (raw == null || trim(raw) === '') return [];
    return splitCommaList(unquote(raw)).map(function (x) { return trim(x).toLowerCase(); }).filter(Boolean);
  }

  function parseCacheControl(value) {
    var result = {
      raw: value || '',
      present: !!(value && trim(value)),
      directives: {},
      errors: [],
      unknown: []
    };
    if (!result.present) return result;
    var parts = splitCommaList(value);
    var i, part, eq, name, rawVal, token, entry;
    for (i = 0; i < parts.length; i++) {
      part = parts[i];
      eq = part.indexOf('=');
      if (eq === -1) {
        name = part.toLowerCase();
        rawVal = null;
      } else {
        name = trim(part.slice(0, eq)).toLowerCase();
        rawVal = trim(part.slice(eq + 1));
      }
      if (!name) continue;
      entry = { name: name, raw: rawVal };
      if (DELTA_NAMES[name]) {
        token = parseDelta(rawVal == null ? '' : unquote(rawVal));
        if (!token.ok) {
          result.errors.push(name + ' ' + token.error);
          entry.invalid = true;
        } else {
          entry.value = token.value;
        }
      } else if (name === 'max-stale') {
        if (rawVal == null || trim(unquote(rawVal)) === '') {
          entry.any = true;
        } else {
          token = parseDelta(unquote(rawVal));
          if (!token.ok) {
            result.errors.push(name + ' ' + token.error);
            entry.invalid = true;
          } else {
            entry.value = token.value;
          }
        }
      } else if (FIELD_LIST_NAMES[name]) {
        entry.present = true;
        entry.fields = rawVal == null ? [] : parseFieldList(rawVal);
      } else if (FLAG_NAMES[name]) {
        entry.present = true;
        if (rawVal != null) entry.raw = rawVal;
      } else {
        result.unknown.push(name + (rawVal != null ? '=' + rawVal : ''));
        entry.unknown = true;
        if (rawVal != null) {
          token = parseDelta(unquote(rawVal));
          if (token.ok) entry.value = token.value;
        }
      }
      result.directives[name] = entry;
    }
    return result;
  }

  function hasDir(cc, name) {
    var d = cc.directives[name];
    return !!(d && !d.invalid);
  }

  function dirValue(cc, name) {
    var d = cc.directives[name];
    if (!d || d.invalid || typeof d.value !== 'number') return null;
    return d.value;
  }

  function dirFields(cc, name) {
    var d = cc.directives[name];
    return d && d.fields ? d.fields : [];
  }

  function parseAgeHeader(raw) {
    if (raw == null || trim(raw) === '') return { present: false, value: 0 };
    var token = parseDelta(raw);
    if (!token.ok) return { present: true, value: 0, error: token.error, invalid: true };
    return { present: true, value: token.value };
  }

  function allowsAuthorizedShared(cc) {
    return hasDir(cc, 'public') || hasDir(cc, 'must-revalidate') ||
      hasDir(cc, 'proxy-revalidate') || dirValue(cc, 's-maxage') != null;
  }

  function formatDuration(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    var sign = sec < 0 ? '-' : '';
    var n = Math.abs(Math.round(sec));
    var d = Math.floor(n / 86400);
    var h = Math.floor((n % 86400) / 3600);
    var m = Math.floor((n % 3600) / 60);
    var s = n % 60;
    var parts = [];
    if (d) parts.push(d + ' 天');
    if (h) parts.push(h + ' 小时');
    if (m) parts.push(m + ' 分');
    if (s || !parts.length) parts.push(s + ' 秒');
    return sign + parts.join(' ');
  }

  function formatGmt(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return new Date(ms).toUTCString();
  }

  function formatCn(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var d = new Date(ms);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    // Asia/Shanghai is UTC+8 with no DST
    var t = new Date(ms + 8 * 3600 * 1000);
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) +
      ' ' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds()) +
      '（北京时间）';
  }

  function methodOf(req, fallback) {
    if (req.method) return req.method;
    if (fallback) return String(fallback).toUpperCase();
    return 'GET';
  }

  function hasAuthorization(req) {
    return hasHeader(req, 'authorization');
  }

  function computeLifetime(cc, cacheKind, dateMs, expiresMs, lastModMs, receivedAt, notes) {
    var shared = cacheKind === 'shared';
    var sMax = dirValue(cc, 's-maxage');
    var maxAge = dirValue(cc, 'max-age');
    if (shared && sMax != null) {
      return { lifetime: sMax, source: 's-maxage', heuristic: false };
    }
    if (maxAge != null) {
      if (expiresMs != null) {
        notes.push({
          id: 'expires-ignored',
          level: 'info',
          text: '同时有 max-age 与 Expires 时，以 max-age 为准，Expires 被忽略。'
        });
      }
      return { lifetime: maxAge, source: 'max-age', heuristic: false };
    }
    if (expiresMs != null) {
      var base = dateMs != null ? dateMs : receivedAt;
      var life = Math.floor((expiresMs - base) / 1000);
      if (life < 0) life = 0;
      return { lifetime: life, source: 'expires', heuristic: false };
    }
    if (lastModMs != null) {
      var ref = dateMs != null ? dateMs : receivedAt;
      if (ref > lastModMs) {
        var heur = Math.floor((ref - lastModMs) / 1000 * 0.1);
        if (heur > HEURISTIC_CAP) {
          notes.push({
            id: 'heuristic-capped',
            level: 'info',
            text: '启发式新鲜期按 (Date − Last-Modified) × 10% 计算，并按常见实现封顶 24 小时。'
          });
          heur = HEURISTIC_CAP;
        }
        return { lifetime: heur, source: 'heuristic', heuristic: true };
      }
    }
    return { lifetime: null, source: 'none', heuristic: false };
  }

  function storageDecision(opts) {
    var cc = opts.cc;
    var reqCc = opts.reqCc;
    var cacheKind = opts.cacheKind;
    var method = opts.method;
    var status = opts.status;
    var req = opts.req;
    var res = opts.res;
    var hasExplicit = opts.hasExplicit;
    var reasons = [];
    var warnings = [];
    var canStore = true;

    if (hasDir(reqCc, 'no-store') || hasDir(cc, 'no-store')) {
      canStore = false;
      reasons.push('no-store：不得把请求或响应写入缓存。');
    }

    if (canStore && cacheKind === 'shared' && hasDir(cc, 'private') && dirFields(cc, 'private').length === 0) {
      canStore = false;
      reasons.push('private：共享缓存（CDN / 代理）不得存储这份响应。');
    } else if (cacheKind === 'shared' && hasDir(cc, 'private') && dirFields(cc, 'private').length) {
      warnings.push({
        id: 'private-fields',
        level: 'warn',
        text: 'private 带字段列表：共享缓存可以存储，但必须去掉列出的字段（' + dirFields(cc, 'private').join(', ') + '）。'
      });
    }

    if (canStore && cacheKind === 'shared' && hasAuthorization(req) && !allowsAuthorizedShared(cc)) {
      canStore = false;
      reasons.push('请求带 Authorization 时，共享缓存默认不得存储，除非响应含 public、s-maxage、must-revalidate 或 proxy-revalidate。');
    }

    var cacheableMethod = method === 'GET' || method === 'HEAD';
    if (method === 'POST') {
      if (!hasExplicit) {
        canStore = false;
        reasons.push('POST 响应在没有显式新鲜期（max-age / s-maxage / Expires）时，通常不应缓存。');
      } else {
        warnings.push({
          id: 'post-cached',
          level: 'info',
          text: 'POST 带了显式新鲜期：部分缓存可能存储，供之后的 GET / HEAD 复用，但不能用来直接回答另一次 POST。'
        });
      }
    } else if (!cacheableMethod && canStore) {
      if (!hasExplicit) {
        canStore = false;
        reasons.push(method + ' 默认不是可缓存方法，且没有显式新鲜期。');
      }
    }

    if (canStore && status != null && !DEFAULT_CACHEABLE_STATUS[status] && !hasExplicit) {
      canStore = false;
      reasons.push('状态码 ' + status + ' 默认不可缓存，且没有显式新鲜期（max-age / s-maxage / Expires）。');
    }

    if (canStore && hasHeader(res, 'set-cookie') && cacheKind === 'shared' &&
        (hasDir(cc, 'public') || dirValue(cc, 's-maxage') != null || dirValue(cc, 'max-age') != null)) {
      warnings.push({
        id: 'set-cookie-public',
        level: 'warn',
        text: '响应同时带 Set-Cookie 且看起来可被共享缓存存储。若 Cookie 与用户身份有关，这可能把私人响应交给别人。多数 CDN 仍应避免缓存带 Set-Cookie 的响应。'
      });
    }

    return { canStore: canStore, reasons: reasons, warnings: warnings };
  }

  function mustRevalidateBeforeUse(cc, reqCc) {
    if (hasDir(reqCc, 'no-cache')) return true;
    if (hasDir(cc, 'no-cache') && dirFields(cc, 'no-cache').length === 0) return true;
    return false;
  }

  function analyze(opts) {
    opts = opts || {};
    var notes = [];
    var now = toMs(opts.now);
    if (now == null) now = Date.now();
    var receivedAt = toMs(opts.receivedAt);
    if (receivedAt == null) receivedAt = now;
    var cacheKind = opts.cacheKind === 'shared' ? 'shared' : 'private';

    var res = parseHeaders(opts.responseText || '');
    var req = parseHeaders(opts.requestHeadersText || '');
    var parseErrors = res.errors.concat(req.errors);

    var ccRaw = headerJoin(res, 'cache-control');
    var cc = parseCacheControl(ccRaw);
    parseErrors = parseErrors.concat(cc.errors);
    var reqCc = parseCacheControl(headerJoin(req, 'cache-control'));
    parseErrors = parseErrors.concat(reqCc.errors);

    var pragma = (headerJoin(res, 'pragma') || '').toLowerCase();
    if (!cc.present && /(?:^|,)\s*no-cache\s*(?:,|$)/.test(pragma)) {
      cc.directives['no-cache'] = { name: 'no-cache', present: true, fields: [], fromPragma: true };
      cc.present = true;
      notes.push({
        id: 'pragma-fallback',
        level: 'info',
        text: '没有 Cache-Control 时，按 HTTP/1.0 的 Pragma: no-cache 处理：存储后每次使用前必须再验证。'
      });
    } else if (cc.present && /(?:^|,)\s*no-cache\s*(?:,|$)/.test(pragma)) {
      notes.push({
        id: 'pragma-ignored',
        level: 'info',
        text: '已有 Cache-Control 时，Pragma 通常被忽略。'
      });
    }

    var dateMs = parseHttpDate(headerFirst(res, 'date'));
    if (headerFirst(res, 'date') && dateMs == null) {
      parseErrors.push('无法解析 Date：' + headerFirst(res, 'date'));
    }
    var expiresMs = null;
    if (headerFirst(res, 'expires')) {
      expiresMs = parseHttpDate(headerFirst(res, 'expires'));
      if (expiresMs == null) {
        expiresMs = 0;
        notes.push({
          id: 'expires-invalid',
          level: 'warn',
          text: 'Expires 无法解析或为 0，按已过期处理。'
        });
      }
    }
    var lastModMs = parseHttpDate(headerFirst(res, 'last-modified'));
    if (headerFirst(res, 'last-modified') && lastModMs == null) {
      parseErrors.push('无法解析 Last-Modified：' + headerFirst(res, 'last-modified'));
    }
    var ageInfo = parseAgeHeader(headerFirst(res, 'age'));
    if (ageInfo.invalid) parseErrors.push('无法解析 Age：' + headerFirst(res, 'age'));

    if (dateMs != null && dateMs > receivedAt + 2000) {
      notes.push({
        id: 'date-future',
        level: 'warn',
        text: 'Date 比观测时刻还晚，按规范 apparent age 记为 0。可能是时钟不同步。'
      });
    }

    var method = methodOf(req, opts.method);
    var hasExplicit = dirValue(cc, 'max-age') != null ||
      (cacheKind === 'shared' && dirValue(cc, 's-maxage') != null) ||
      expiresMs != null;
    // explicit for POST storage should count s-maxage even in private view
    var hasExplicitAny = dirValue(cc, 'max-age') != null || dirValue(cc, 's-maxage') != null || expiresMs != null;

    var freshInfo = computeLifetime(cc, cacheKind, dateMs, expiresMs, lastModMs, receivedAt, notes);
    var store = storageDecision({
      cc: cc,
      reqCc: reqCc,
      cacheKind: cacheKind,
      method: method,
      status: res.status,
      req: req,
      res: res,
      hasExplicit: hasExplicitAny
    });
    notes = notes.concat(store.warnings);

    var apparentAge = 0;
    if (dateMs != null) apparentAge = Math.max(0, Math.floor((receivedAt - dateMs) / 1000));
    var ageHeader = ageInfo.present && !ageInfo.invalid ? ageInfo.value : 0;
    var correctedInitialAge = Math.max(apparentAge, ageHeader);
    var residentTime = Math.max(0, Math.floor((now - receivedAt) / 1000));
    var currentAge = correctedInitialAge + residentTime;

    var lifetime = freshInfo.lifetime;
    var remaining = lifetime != null ? lifetime - currentAge : null;
    var isFresh = lifetime != null && currentAge < lifetime;

    if (reqCc && dirValue(reqCc, 'max-age') != null && currentAge >= dirValue(reqCc, 'max-age')) {
      isFresh = false;
      notes.push({
        id: 'req-max-age',
        level: 'info',
        text: '请求带 max-age=' + dirValue(reqCc, 'max-age') + '，当前年龄已达到或超过该上限，不能当新鲜响应用。'
      });
    }
    if (reqCc && dirValue(reqCc, 'min-fresh') != null) {
      var need = dirValue(reqCc, 'min-fresh');
      var remainNow = lifetime != null ? lifetime - currentAge : -1;
      if (remainNow < need) {
        isFresh = false;
        notes.push({
          id: 'req-min-fresh',
          level: 'info',
          text: '请求要求至少再新鲜 ' + formatDuration(need) + '（min-fresh），当前剩余不足。'
        });
      }
    }

    var swr = dirValue(cc, 'stale-while-revalidate');
    var sie = dirValue(cc, 'stale-if-error');
    var inSWR = !isFresh && lifetime != null && swr != null && currentAge < lifetime + swr;
    var inSIE = !isFresh && lifetime != null && sie != null && currentAge < lifetime + sie;
    var cannotServeStale = hasDir(cc, 'must-revalidate') ||
      (cacheKind === 'shared' && hasDir(cc, 'proxy-revalidate'));
    if (cannotServeStale && (inSWR || inSIE)) {
      notes.push({
        id: 'must-revalidate-vs-stale',
        level: 'warn',
        text: (hasDir(cc, 'must-revalidate') ? 'must-revalidate' : 'proxy-revalidate') +
          ' 禁止在过期后继续使用，stale-while-revalidate / stale-if-error 不会放行过期副本。'
      });
    }

    var maxStale = null;
    if (hasDir(reqCc, 'max-stale')) {
      maxStale = reqCc.directives['max-stale'].any ? Infinity : dirValue(reqCc, 'max-stale');
    }
    var staleBy = remaining != null && remaining < 0 ? -remaining : 0;
    var inMaxStale = !isFresh && maxStale != null && lifetime != null && staleBy <= maxStale;

    if (hasDir(cc, 'no-cache') && dirFields(cc, 'no-cache').length) {
      notes.push({
        id: 'no-cache-fields',
        level: 'info',
        text: 'no-cache 带字段列表：响应在新鲜期内仍可使用，但列出的字段（' +
          dirFields(cc, 'no-cache').join(', ') + '）在再验证前不能用。'
      });
    }
    if (hasDir(cc, 'immutable') && isFresh) {
      notes.push({
        id: 'immutable-fresh',
        level: 'info',
        text: 'immutable：在新鲜期内浏览器通常可跳过再验证（例如刷新时）。过期后不再适用。'
      });
    } else if (hasDir(cc, 'immutable') && !isFresh) {
      notes.push({
        id: 'immutable-stale',
        level: 'info',
        text: 'immutable 只在新鲜期内有效，当前已过期，不能凭它继续免验证使用。'
      });
    }
    if (headerFirst(res, 'vary') && trim(headerFirst(res, 'vary')) === '*') {
      notes.push({
        id: 'vary-star',
        level: 'warn',
        text: 'Vary: * 表示响应随不可枚举的因素变化，共享缓存通常无法安全复用。'
      });
    }
    if (dirValue(cc, 's-maxage') != null && dirValue(cc, 'max-age') != null) {
      notes.push({
        id: 's-maxage-diff',
        level: 'info',
        text: 's-maxage=' + dirValue(cc, 's-maxage') + ' 只约束共享缓存；浏览器等私有缓存走 max-age=' +
          dirValue(cc, 'max-age') + '。'
      });
    }
    if (hasDir(cc, 'no-cache') && hasDir(cc, 'no-store')) {
      notes.push({
        id: 'no-cache-and-store',
        level: 'info',
        text: '同时写了 no-cache 与 no-store：no-store 更严，不得存储。no-cache 并不是“不要缓存”，而是“用之前先再验证”。'
      });
    } else if (hasDir(cc, 'no-cache') && dirFields(cc, 'no-cache').length === 0) {
      notes.push({
        id: 'no-cache-meaning',
        level: 'info',
        text: 'no-cache 允许存储，但每次拿出来用之前必须和源站再验证。若本意是“不要留下副本”，应使用 no-store。'
      });
    }
    if (dirValue(cc, 'max-age') === 0 && !hasDir(cc, 'no-store')) {
      notes.push({
        id: 'max-age-zero',
        level: 'info',
        text: 'max-age=0 表示一落地就过期，通常仍可存储，但使用前要再验证。'
      });
    }

    var needRevalidate = mustRevalidateBeforeUse(cc, reqCc);
    var verdict;
    var verdictLabel;
    var verdictDetail;
    if (!store.canStore) {
      verdict = 'not-stored';
      verdictLabel = '不会进入缓存';
      verdictDetail = store.reasons[0] || '这份响应不应被存储。';
    } else if (needRevalidate) {
      verdict = 'must-revalidate';
      verdictLabel = '必须先再验证';
      verdictDetail = '可以存储，但在观测时刻使用前必须向源站再验证（no-cache 或请求要求验证）。';
    } else if (isFresh) {
      verdict = freshInfo.heuristic ? 'heuristic-fresh' : 'fresh';
      verdictLabel = freshInfo.heuristic ? '启发式新鲜' : '新鲜，可直接复用';
      verdictDetail = '当前年龄 ' + formatDuration(currentAge) + '，新鲜期 ' +
        formatDuration(lifetime) + '，还可再用 ' + formatDuration(remaining) + '。' +
        (freshInfo.heuristic ? ' 新鲜期来自启发式，源站未给出显式过期时间。' : '');
    } else if (inSWR && !cannotServeStale) {
      verdict = 'stale-swr';
      verdictLabel = '已过期，可边用边再验证';
      verdictDetail = '已过期 ' + formatDuration(staleBy) + '，仍在 stale-while-revalidate=' +
        formatDuration(swr) + ' 窗口内：可以先交出旧副本，同时后台再验证。';
    } else if (inMaxStale && !cannotServeStale) {
      verdict = 'stale-max-stale';
      verdictLabel = '已过期，但请求允许过期使用';
      verdictDetail = '请求带 max-stale，当前过期 ' + formatDuration(staleBy) + '，仍在允许范围内。';
    } else if (cannotServeStale && lifetime != null && currentAge >= lifetime) {
      verdict = 'must-revalidate';
      verdictLabel = '已过期，必须再验证';
      verdictDetail = '新鲜期已过，且 must-revalidate / proxy-revalidate 不允许继续使用过期副本。';
    } else if (lifetime == null) {
      verdict = 'must-revalidate';
      verdictLabel = '没有新鲜期，使用前应再验证';
      verdictDetail = '没有 max-age / s-maxage / Expires，也无法做启发式估算。缓存即便留下副本，使用前通常也要再验证。';
    } else {
      verdict = 'stale';
      verdictLabel = '已过期';
      verdictDetail = '已过期 ' + formatDuration(staleBy) + '。默认不应再直接使用；' +
        (inSIE ? '若源站出错，stale-if-error 还允许在 ' + formatDuration(sie - staleBy) + ' 内交出旧副本。' : '除非另有约定，应向源站再验证。');
    }

    var freshUntil = lifetime != null ? receivedAt + (lifetime - correctedInitialAge) * 1000 : null;
    var swrUntil = lifetime != null && swr != null ? receivedAt + (lifetime + swr - correctedInitialAge) * 1000 : null;
    var sieUntil = lifetime != null && sie != null ? receivedAt + (lifetime + sie - correctedInitialAge) * 1000 : null;

    var etag = headerFirst(res, 'etag');
    var lastModRaw = headerFirst(res, 'last-modified');
    var revalidation = { headers: [], possible: !!(etag || lastModRaw) };
    if (etag) revalidation.headers.push('If-None-Match: ' + etag);
    if (lastModRaw) revalidation.headers.push('If-Modified-Since: ' + lastModRaw);
    if (!revalidation.possible) {
      revalidation.note = '响应没有 ETag 或 Last-Modified，再验证时通常只能重新拉完整响应。';
    } else {
      revalidation.note = '源站若认为未改动，可回 304 Not Modified，缓存会刷新新鲜期并继续用旧正文。';
    }

    var result = {
      now: now,
      receivedAt: receivedAt,
      cacheKind: cacheKind,
      method: method,
      status: res.status,
      response: res,
      request: req,
      cc: cc,
      reqCc: reqCc,
      parseErrors: parseErrors,
      dateMs: dateMs,
      expiresMs: expiresMs,
      lastModMs: lastModMs,
      freshness: {
        lifetime: lifetime,
        source: freshInfo.source,
        heuristic: freshInfo.heuristic,
        remaining: remaining
      },
      age: {
        apparentAge: apparentAge,
        ageHeader: ageInfo.present && !ageInfo.invalid ? ageInfo.value : null,
        correctedInitialAge: correctedInitialAge,
        residentTime: residentTime,
        currentAge: currentAge
      },
      isFresh: isFresh,
      inSWR: inSWR && !cannotServeStale,
      inSIE: inSIE,
      cannotServeStale: cannotServeStale,
      store: store,
      verdict: verdict,
      verdictLabel: verdictLabel,
      verdictDetail: verdictDetail,
      notes: notes,
      freshUntil: freshUntil,
      swrUntil: swrUntil,
      sieUntil: sieUntil,
      revalidation: revalidation,
      times: {
        nowGmt: formatGmt(now),
        nowCn: formatCn(now),
        dateGmt: formatGmt(dateMs),
        dateCn: formatCn(dateMs),
        freshUntilGmt: formatGmt(freshUntil),
        freshUntilCn: formatCn(freshUntil),
        swrUntilGmt: formatGmt(swrUntil),
        swrUntilCn: formatCn(swrUntil)
      }
    };
    result.markdown = toMarkdown(result);
    return result;
  }

  function sourceLabel(source) {
    if (source === 's-maxage') return 's-maxage（共享缓存）';
    if (source === 'max-age') return 'max-age';
    if (source === 'expires') return 'Expires';
    if (source === 'heuristic') return '启发式（Last-Modified × 10%）';
    return '无显式新鲜期';
  }

  function verdictWord(verdict) {
    return {
      'not-stored': '不会进入缓存',
      'must-revalidate': '必须先再验证',
      fresh: '新鲜，可直接复用',
      'heuristic-fresh': '启发式新鲜',
      'stale-swr': '已过期，可边用边再验证',
      'stale-max-stale': '已过期，但请求允许过期使用',
      stale: '已过期'
    }[verdict] || verdict;
  }

  function toMarkdown(r) {
    var lines = [];
    lines.push('## HTTP 缓存新鲜度');
    lines.push('');
    lines.push('- 结论：' + r.verdictLabel);
    lines.push('- 缓存类型：' + (r.cacheKind === 'shared' ? '共享（CDN / 代理）' : '私有（浏览器）'));
    lines.push('- 方法 / 状态：' + r.method + (r.status != null ? ' / ' + r.status : ''));
    lines.push('- 当前年龄：' + formatDuration(r.age.currentAge) +
      '（apparent ' + formatDuration(r.age.apparentAge) +
      '，Age 头 ' + (r.age.ageHeader == null ? '无' : formatDuration(r.age.ageHeader)) +
      '，驻留 ' + formatDuration(r.age.residentTime) + '）');
    lines.push('- 新鲜期：' + (r.freshness.lifetime == null ? '无' : formatDuration(r.freshness.lifetime)) +
      '（来源：' + sourceLabel(r.freshness.source) + '）');
    if (r.freshUntil != null) {
      lines.push('- 新鲜期截止：' + r.times.freshUntilCn + ' / ' + r.times.freshUntilGmt);
    }
    lines.push('- 观测时刻：' + r.times.nowCn + ' / ' + r.times.nowGmt);
    lines.push('- 说明：' + r.verdictDetail);
    if (r.revalidation.headers.length) {
      lines.push('- 再验证请求头：');
      r.revalidation.headers.forEach(function (h) { lines.push('  - `' + h + '`'); });
    }
    if (r.parseErrors.length) {
      lines.push('- 解析问题：' + r.parseErrors.join('；'));
    }
    if (r.notes.length) {
      lines.push('- 注意：');
      r.notes.forEach(function (n) { lines.push('  - ' + n.text); });
    }
    lines.push('');
    lines.push('由 cache-lab 在本地生成，未上传任何响应头。');
    return lines.join('\n');
  }

  var T = 'Wed, 18 Nov 2026 12:00:00 GMT';

  var SAMPLES = {
    cdnFresh: {
      label: 'CDN 仍在新鲜期',
      cacheKind: 'shared',
      method: 'GET',
      now: 'Wed, 18 Nov 2026 12:01:00 GMT',
      receivedAt: 'Wed, 18 Nov 2026 12:01:00 GMT',
      requestHeadersText: '',
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Age: 20',
        'Cache-Control: public, max-age=300, s-maxage=600',
        'ETag: "abc123"',
        'Content-Type: text/css'
      ].join('\n')
    },
    swr: {
      label: '已过期但可 SWR',
      cacheKind: 'private',
      method: 'GET',
      now: 'Wed, 18 Nov 2026 12:02:00 GMT',
      receivedAt: 'Wed, 18 Nov 2026 12:02:00 GMT',
      requestHeadersText: '',
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Age: 90',
        'Cache-Control: max-age=60, stale-while-revalidate=300, stale-if-error=86400',
        'ETag: "v2"',
        'Last-Modified: Wed, 18 Nov 2026 10:00:00 GMT'
      ].join('\n')
    },
    noStore: {
      label: '登录页 no-store',
      cacheKind: 'private',
      method: 'GET',
      now: T,
      receivedAt: T,
      requestHeadersText: '',
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Cache-Control: no-store',
        'Set-Cookie: session=example-not-real',
        'Content-Type: text/html'
      ].join('\n')
    },
    noCache: {
      label: 'no-cache 必须再验证',
      cacheKind: 'private',
      method: 'GET',
      now: 'Wed, 18 Nov 2026 12:00:10 GMT',
      receivedAt: 'Wed, 18 Nov 2026 12:00:10 GMT',
      requestHeadersText: '',
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Cache-Control: no-cache',
        'ETag: "page-9"',
        'Content-Type: application/json'
      ].join('\n')
    },
    privateOnly: {
      label: '仅浏览器可缓存',
      cacheKind: 'shared',
      method: 'GET',
      now: 'Wed, 18 Nov 2026 12:01:00 GMT',
      receivedAt: 'Wed, 18 Nov 2026 12:01:00 GMT',
      requestHeadersText: '',
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Cache-Control: private, max-age=3600',
        'ETag: "html-1"',
        'Content-Type: text/html'
      ].join('\n')
    },
    authorized: {
      label: '带 Authorization 的 CDN',
      cacheKind: 'shared',
      method: 'GET',
      now: 'Wed, 18 Nov 2026 12:00:30 GMT',
      receivedAt: 'Wed, 18 Nov 2026 12:00:30 GMT',
      requestHeadersText: [
        'GET /v1/profile HTTP/1.1',
        'Authorization: Bearer example-token'
      ].join('\n'),
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Cache-Control: max-age=60',
        'Content-Type: application/json'
      ].join('\n')
    },
    heuristic: {
      label: '靠 Last-Modified 启发式',
      cacheKind: 'private',
      method: 'GET',
      now: 'Wed, 18 Nov 2026 12:05:00 GMT',
      receivedAt: 'Wed, 18 Nov 2026 12:05:00 GMT',
      requestHeadersText: '',
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Last-Modified: Wed, 18 Nov 2026 07:00:00 GMT',
        'Content-Type: image/png'
      ].join('\n')
    },
    cookiePublic: {
      label: 'public 却带 Set-Cookie',
      cacheKind: 'shared',
      method: 'GET',
      now: 'Wed, 18 Nov 2026 12:00:20 GMT',
      receivedAt: 'Wed, 18 Nov 2026 12:00:20 GMT',
      requestHeadersText: '',
      responseText: [
        'HTTP/1.1 200 OK',
        'Date: ' + T,
        'Cache-Control: public, max-age=600',
        'Set-Cookie: sid=example-not-real; Path=/',
        'Content-Type: text/html'
      ].join('\n')
    }
  };

  return {
    parseHeaders: parseHeaders,
    parseCacheControl: parseCacheControl,
    parseHttpDate: parseHttpDate,
    analyze: analyze,
    toMarkdown: toMarkdown,
    formatDuration: formatDuration,
    formatGmt: formatGmt,
    formatCn: formatCn,
    sourceLabel: sourceLabel,
    verdictWord: verdictWord,
    samples: SAMPLES
  };
});
