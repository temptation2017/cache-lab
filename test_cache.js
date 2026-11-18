'use strict';

var C = require('./cache.js');
var failed = 0;
var passed = 0;

function check(name, got, expected) {
  var ok = got === expected;
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.error('FAIL', name, '\n  got:     ', JSON.stringify(got), '\n  expected:', JSON.stringify(expected));
}

function checkOk(name, cond) {
  check(name, !!cond, true);
}

function checkClose(name, got, expected) {
  check(name, got, expected);
}

var T0 = C.parseHttpDate('Wed, 18 Nov 2026 12:00:00 GMT');
var T60 = T0 + 60 * 1000;
var T90 = T0 + 90 * 1000;
var T120 = T0 + 120 * 1000;

checkOk('parse IMF date', T0 === Date.parse('Wed, 18 Nov 2026 12:00:00 GMT'));

var parsed = C.parseHeaders([
  'HTTP/1.1 200 OK',
  'Date: Wed, 18 Nov 2026 12:00:00 GMT',
  'Cache-Control: public, max-age=300',
  'X-Id: a',
  'X-Id: b',
  '  folded'
].join('\n'));
check('status', parsed.status, 200);
check('date header', parsed.map.date.values[0], 'Wed, 18 Nov 2026 12:00:00 GMT');
check('duplicate + fold', parsed.map['x-id'].values.join('|'), 'a|b folded');

var reqLine = C.parseHeaders('GET /assets/app.css HTTP/1.1\nAuthorization: Bearer example-token\n');
check('request method', reqLine.method, 'GET');
checkOk('authorization present', !!reqLine.map.authorization);

var cc = C.parseCacheControl('public, max-age=300, s-maxage="600", no-cache="Set-Cookie", stale-while-revalidate=120');
check('max-age', cc.directives['max-age'].value, 300);
check('s-maxage quoted', cc.directives['s-maxage'].value, 600);
check('no-cache field', cc.directives['no-cache'].fields[0], 'set-cookie');
check('swr', cc.directives['stale-while-revalidate'].value, 120);

var bad = C.parseCacheControl('max-age=60.5, foo=bar');
checkOk('invalid max-age flagged', !!bad.errors.length);
checkOk('unknown kept', bad.unknown.indexOf('foo=bar') !== -1);

var staleAny = C.parseCacheControl('max-stale');
checkOk('max-stale any', !!(staleAny.directives['max-stale'] && staleAny.directives['max-stale'].any));

function A(partial) {
  return C.analyze(partial);
}

var fresh = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=300',
    'ETag: "abc"'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private',
  method: 'GET'
});
check('fresh verdict', fresh.verdict, 'fresh');
check('apparent age 60', fresh.age.apparentAge, 60);
check('current age 60', fresh.age.currentAge, 60);
check('lifetime 300', fresh.freshness.lifetime, 300);
check('remaining 240', fresh.freshness.remaining, 240);
check('source max-age', fresh.freshness.source, 'max-age');
checkOk('fresh until', fresh.freshUntil === T0 + 300 * 1000);
check('reval etag', fresh.revalidation.headers[0], 'If-None-Match: "abc"');

var aged = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Age: 280',
    'Cache-Control: max-age=300'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('age header wins', aged.age.currentAge, 280);
check('still fresh', aged.verdict, 'fresh');
check('remain 20', aged.freshness.remaining, 20);

var stale = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=60'
  ].join('\n'),
  now: T90,
  receivedAt: T90,
  cacheKind: 'private'
});
check('stale verdict', stale.verdict, 'stale');
check('stale remaining', stale.freshness.remaining, -30);

var sharedSmax = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: public, max-age=300, s-maxage=30'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'shared'
});
check('shared uses s-maxage', sharedSmax.freshness.source, 's-maxage');
check('shared lifetime 30', sharedSmax.freshness.lifetime, 30);
check('shared already stale', sharedSmax.verdict, 'stale');

var privateMax = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: public, max-age=300, s-maxage=30'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('private uses max-age', privateMax.freshness.source, 'max-age');
check('private still fresh', privateMax.verdict, 'fresh');

var byExpires = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Expires: Wed, 18 Nov 2026 12:10:00 GMT'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('expires source', byExpires.freshness.source, 'expires');
check('expires lifetime 600', byExpires.freshness.lifetime, 600);
check('expires fresh', byExpires.verdict, 'fresh');

var maxAgeWins = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=60',
    'Expires: Wed, 18 Nov 2026 15:00:00 GMT'
  ].join('\n'),
  now: T90,
  receivedAt: T90,
  cacheKind: 'private'
});
check('max-age beats expires', maxAgeWins.freshness.source, 'max-age');
check('ignored expires stale', maxAgeWins.verdict, 'stale');
checkOk('expires-ignored note', maxAgeWins.notes.some(function (n) { return n.id === 'expires-ignored'; }));

var noStore = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: no-store',
    'Set-Cookie: session=example-not-real'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('no-store', noStore.verdict, 'not-stored');

var noCache = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: no-cache',
    'ETag: "page-9"'
  ].join('\n'),
  now: T0 + 10 * 1000,
  receivedAt: T0 + 10 * 1000,
  cacheKind: 'private'
});
check('no-cache revalidate', noCache.verdict, 'must-revalidate');
checkOk('no-cache can store', noCache.store.canStore);

var privateOnShared = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: private, max-age=3600'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'shared'
});
check('private not on shared', privateOnShared.verdict, 'not-stored');

var privateOnBrowser = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: private, max-age=3600'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('private ok on browser', privateOnBrowser.verdict, 'fresh');

var authShared = A({
  requestHeadersText: [
    'GET /v1/profile HTTP/1.1',
    'Authorization: Bearer example-token'
  ].join('\n'),
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=60'
  ].join('\n'),
  now: T0 + 30 * 1000,
  receivedAt: T0 + 30 * 1000,
  cacheKind: 'shared'
});
check('auth blocked on shared', authShared.verdict, 'not-stored');

var authPublic = A({
  requestHeadersText: [
    'GET /v1/profile HTTP/1.1',
    'Authorization: Bearer example-token'
  ].join('\n'),
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: public, max-age=60'
  ].join('\n'),
  now: T0 + 30 * 1000,
  receivedAt: T0 + 30 * 1000,
  cacheKind: 'shared'
});
check('auth public allowed', authPublic.verdict, 'fresh');

var authSmax = A({
  requestHeadersText: 'Authorization: Bearer example-token',
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: s-maxage=60'
  ].join('\n'),
  now: T0 + 30 * 1000,
  receivedAt: T0 + 30 * 1000,
  cacheKind: 'shared'
});
check('auth s-maxage allowed', authSmax.verdict, 'fresh');

var swr = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Age: 90',
    'Cache-Control: max-age=60, stale-while-revalidate=300, stale-if-error=86400',
    'ETag: "v2"',
    'Last-Modified: Wed, 18 Nov 2026 10:00:00 GMT'
  ].join('\n'),
  now: T120,
  receivedAt: T120,
  cacheKind: 'private'
});
check('swr verdict', swr.verdict, 'stale-swr');
checkOk('in SWR', swr.inSWR);
checkOk('in SIE window', swr.inSIE);
checkOk('has both reval headers', swr.revalidation.headers.length === 2);

var swrBlocked = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=60, stale-while-revalidate=300, must-revalidate'
  ].join('\n'),
  now: T90,
  receivedAt: T90,
  cacheKind: 'private'
});
check('must-revalidate beats swr', swrBlocked.verdict, 'must-revalidate');
checkOk('swr not usable', !swrBlocked.inSWR);

// Last-Modified 5 hours before Date → heuristic 1800s; age at +5min still fresh
var heur = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Last-Modified: Wed, 18 Nov 2026 07:00:00 GMT'
  ].join('\n'),
  now: T0 + 5 * 60 * 1000,
  receivedAt: T0 + 5 * 60 * 1000,
  cacheKind: 'private'
});
check('heuristic source', heur.freshness.source, 'heuristic');
check('heuristic lifetime 1800', heur.freshness.lifetime, 1800);
check('heuristic fresh', heur.verdict, 'heuristic-fresh');

var heurCap = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Last-Modified: Wed, 01 Nov 2026 12:00:00 GMT'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('heuristic capped 24h', heurCap.freshness.lifetime, 24 * 3600);
checkOk('heuristic-capped note', heurCap.notes.some(function (n) { return n.id === 'heuristic-capped'; }));

var futureDate = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:05:00 GMT',
    'Cache-Control: max-age=300'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('future date apparent 0', futureDate.age.apparentAge, 0);
checkOk('date-future note', futureDate.notes.some(function (n) { return n.id === 'date-future'; }));

var reqMaxAge = A({
  requestHeadersText: 'Cache-Control: max-age=30',
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=300'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('request max-age tightens', reqMaxAge.isFresh, false);
checkOk('req-max-age note', reqMaxAge.notes.some(function (n) { return n.id === 'req-max-age'; }));

var reqMinFresh = A({
  requestHeadersText: 'Cache-Control: min-fresh=200',
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=300'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
// remain = 240, min-fresh=200 → still ok? 240 >= 200, should stay fresh
check('min-fresh still ok', reqMinFresh.isFresh, true);

var reqMinFreshFail = A({
  requestHeadersText: 'Cache-Control: min-fresh=250',
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=300'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('min-fresh not enough', reqMinFreshFail.isFresh, false);

var reqMaxStale = A({
  requestHeadersText: 'Cache-Control: max-stale=60',
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=60'
  ].join('\n'),
  now: T90,
  receivedAt: T90,
  cacheKind: 'private'
});
check('max-stale allows', reqMaxStale.verdict, 'stale-max-stale');

var pragmaOnly = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Pragma: no-cache'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('pragma fallback', pragmaOnly.verdict, 'must-revalidate');

var pragmaIgnored = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=300',
    'Pragma: no-cache'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
check('pragma ignored stays fresh', pragmaIgnored.verdict, 'fresh');
checkOk('pragma-ignored note', pragmaIgnored.notes.some(function (n) { return n.id === 'pragma-ignored'; }));

var cookiePublic = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: public, max-age=600',
    'Set-Cookie: sid=example-not-real; Path=/'
  ].join('\n'),
  now: T0 + 20 * 1000,
  receivedAt: T0 + 20 * 1000,
  cacheKind: 'shared'
});
check('public+cookie still fresh', cookiePublic.verdict, 'fresh');
checkOk('set-cookie warning', cookiePublic.notes.some(function (n) { return n.id === 'set-cookie-public'; }));

var expiresPast = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Expires: Wed, 18 Nov 2026 11:00:00 GMT'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('expires past lifetime 0', expiresPast.freshness.lifetime, 0);
check('expires past stale', expiresPast.verdict, 'stale');

var resident = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Age: 10',
    'Cache-Control: max-age=300'
  ].join('\n'),
  receivedAt: T60,
  now: T120,
  cacheKind: 'private'
});
check('resident time 60', resident.age.residentTime, 60);
check('current = max(60,10)+60', resident.age.currentAge, 120);
check('resident still fresh', resident.verdict, 'fresh');

var found302 = A({
  responseText: [
    'HTTP/1.1 302 Found',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Location: https://example.com/next'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('302 without freshness not stored', found302.verdict, 'not-stored');

var found302Age = A({
  responseText: [
    'HTTP/1.1 302 Found',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=60',
    'Location: https://example.com/next'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('302 with max-age stored', found302Age.verdict, 'fresh');

var notFoundCached = A({
  responseText: [
    'HTTP/1.1 404 Not Found',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=30'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('404 with max-age fresh', notFoundCached.verdict, 'fresh');

var noLifetime = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Content-Type: text/html'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('no freshness revalidate', noLifetime.verdict, 'must-revalidate');
check('no lifetime source', noLifetime.freshness.source, 'none');

var postBare = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: max-age=60'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private',
  method: 'POST'
});
checkOk('POST with freshness can store', postBare.store.canStore);
checkOk('POST note', postBare.notes.some(function (n) { return n.id === 'post-cached'; }));

var postNoFresh = A({
  responseText: 'HTTP/1.1 200 OK\nDate: Wed, 18 Nov 2026 12:00:00 GMT',
  now: T0,
  receivedAt: T0,
  cacheKind: 'private',
  method: 'POST'
});
check('POST without freshness', postNoFresh.verdict, 'not-stored');

var ageOnly = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Age: 40',
    'Cache-Control: max-age=300'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'private'
});
check('age without date', ageOnly.age.currentAge, 40);
check('age without date fresh', ageOnly.verdict, 'fresh');

var varyStar = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: public, max-age=60',
    'Vary: *'
  ].join('\n'),
  now: T0,
  receivedAt: T0,
  cacheKind: 'shared'
});
checkOk('vary star warning', varyStar.notes.some(function (n) { return n.id === 'vary-star'; }));

var immutableFresh = A({
  responseText: [
    'HTTP/1.1 200 OK',
    'Date: Wed, 18 Nov 2026 12:00:00 GMT',
    'Cache-Control: public, max-age=31536000, immutable',
    'ETag: "asset"'
  ].join('\n'),
  now: T60,
  receivedAt: T60,
  cacheKind: 'private'
});
checkOk('immutable fresh note', immutableFresh.notes.some(function (n) { return n.id === 'immutable-fresh'; }));

checkOk('duration 90s', C.formatDuration(90) === '1 分 30 秒');
checkOk('duration 0', C.formatDuration(0) === '0 秒');
checkOk('cn offset', C.formatCn(T0).indexOf('2026-11-18 20:00:00') !== -1);

var sample = A(C.samples.cdnFresh);
check('sample cdn verdict', sample.verdict, 'fresh');
check('sample cdn shared lifetime', sample.freshness.lifetime, 600);

var sampleSWR = A(C.samples.swr);
check('sample swr verdict', sampleSWR.verdict, 'stale-swr');

var sampleNoStore = A(C.samples.noStore);
check('sample no-store', sampleNoStore.verdict, 'not-stored');

var sampleNoCache = A(C.samples.noCache);
check('sample no-cache', sampleNoCache.verdict, 'must-revalidate');

var samplePrivate = A(C.samples.privateOnly);
check('sample private shared', samplePrivate.verdict, 'not-stored');

var sampleAuth = A(C.samples.authorized);
check('sample auth', sampleAuth.verdict, 'not-stored');

var sampleHeur = A(C.samples.heuristic);
check('sample heuristic', sampleHeur.verdict, 'heuristic-fresh');

var sampleCookie = A(C.samples.cookiePublic);
check('sample cookie public', sampleCookie.verdict, 'fresh');
checkOk('sample cookie warn', sampleCookie.notes.some(function (n) { return n.id === 'set-cookie-public'; }));

checkOk('markdown has verdict', sample.markdown.indexOf('新鲜，可直接复用') !== -1);

if (failed) {
  console.error('\n' + failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
console.log(passed + ' passed');
