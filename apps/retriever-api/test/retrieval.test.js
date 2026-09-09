import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupBy,
  simpleMMR,
  normPlace,
  detectCityKey,
  googleMapsUrl,
  extractDisabilityLevels,
  buildDisabilityStandardPayload,
  pickBestOffice,
  extractFromText,
  normalizeOfficeName,
  buildOfficeAddress,
} from '../lib/retrieval.js';

const hit = (score, url, title = '') => ({ score, payload: { url, title, text: 'x' } });

test('dedupBy drops repeats but keeps entries with no key', () => {
  const rows = [{ u: 'a' }, { u: 'a' }, { u: 'b' }, { u: '' }, { u: '' }];
  assert.equal(dedupBy(rows, (r) => r.u).length, 4);
});

test('simpleMMR returns short lists untouched', () => {
  const two = [hit(0.9, 'a'), hit(0.8, 'b')];
  assert.deepEqual(simpleMMR(two), two);
  assert.deepEqual(simpleMMR([]), []);
});

test('simpleMMR puts the highest scoring hit first and caps at five', () => {
  const hits = [hit(0.1, 'a'), hit(0.9, 'b'), hit(0.5, 'c'), hit(0.7, 'd'), hit(0.3, 'e'), hit(0.2, 'f')];
  const out = simpleMMR(hits);
  assert.equal(out[0].payload.url, 'b');
  assert.ok(out.length <= 5);
});

test('simpleMMR prefers a different source over a duplicate of equal score', () => {
  // Same score, but 'b' repeats the already-picked source, so 'c' should win.
  const hits = [hit(0.9, 'a'), hit(0.5, 'a'), hit(0.5, 'c'), hit(0.4, 'd')];
  const out = simpleMMR(hits);
  assert.equal(out[1].payload.url, 'c');
});

test('normPlace folds 臺/台 and strips administrative suffixes', () => {
  assert.equal(normPlace('臺中市'), normPlace('台中'));
  assert.equal(normPlace('高雄市 辦事處'), '高雄');
});

test('detectCityKey matches Chinese, English and variant forms', () => {
  assert.equal(detectCityKey('臺北車站附近的辦事處'), '台北');
  assert.equal(detectCityKey('Where is the Taichung office?'), '台中');
  assert.equal(detectCityKey('馬祖有服務據點嗎'), '連江');
  assert.equal(detectCityKey('請問給付要幾天'), null);
});

test('googleMapsUrl prefers coordinates and falls back to address', () => {
  assert.match(googleMapsUrl({ lat: '25.03', lng: '121.51' }), /query=25\.03%2C121\.51/);
  assert.match(googleMapsUrl({ address: '台北市羅斯福路1段4號' }), /query=%E5%8F%B0/);
  assert.equal(googleMapsUrl({}), '');
  assert.equal(googleMapsUrl({ lat: '', lng: '' }), '');
});

test('extractDisabilityLevels parses both languages, sorts and dedupes', () => {
  assert.deepEqual(extractDisabilityLevels('第15級與第 1 級的給付日數？'), [1, 15]);
  assert.deepEqual(extractDisabilityLevels('grade 3 and Grade 3'), [3]);
});

test('extractDisabilityLevels rejects grades outside the statutory 1-15 table', () => {
  assert.deepEqual(extractDisabilityLevels('第16級'), []);
  assert.deepEqual(extractDisabilityLevels('第0級'), []);
});

test('buildDisabilityStandardPayload reports the statutory day counts', () => {
  const zh = buildDisabilityStandardPayload([1, 15], 'zh', 'rag');
  assert.equal(zh.route, 'disability_standard_lookup');
  assert.ok(zh.answer.includes('1200日') && zh.answer.includes('30日'));
  assert.equal(zh.sources.length, 1);

  const en = buildDisabilityStandardPayload([1], 'en', 'rag');
  assert.ok(en.answer.includes('1800日'));
});

test('normalizeOfficeName collapses the doubled suffix in the source data', () => {
  assert.equal(normalizeOfficeName('台北市辦事處辦事處'), '台北市辦事處');
  assert.equal(normalizeOfficeName('高雄市第二辦事處辦事處'), '高雄市第二辦事處');
  assert.equal(normalizeOfficeName('基隆辦事處'), '基隆辦事處');
  assert.equal(normalizeOfficeName(''), '');
});

test('buildOfficeAddress never repeats the office name inside the address', () => {
  assert.equal(
    buildOfficeAddress({ city: '台北市辦事處', address: '台北市羅斯福路1段4號1樓' }),
    '台北市羅斯福路1段4號1樓',
  );
  // A genuine city column is still used.
  assert.equal(
    buildOfficeAddress({ zip: '100', city: '台北市', district: '中正區', address: '羅斯福路1段4號' }),
    '100 台北市 中正區 羅斯福路1段4號',
  );
});

test('pickBestOffice scores the office the question actually names', () => {
  const hits = [
    { payload: { city: '基隆辦事處', address: '基隆市正義路40號', phone: '02-1' } },
    { payload: { city: '台中市辦事處', address: '台中市西區民權路131號', phone: '04-2' } },
  ];
  assert.equal(pickBestOffice(hits, '台中市辦事處在哪裡').phone, '04-2');
  assert.equal(pickBestOffice([], 'anything'), null);
});

test('extractFromText recovers fields from an unstructured payload', () => {
  const got = extractFromText('辦事處\n地址： 台北市羅斯福路1段4號1樓\n電話：02-23216884\n服務時間：週一至週五');
  assert.equal(got.address, '台北市羅斯福路1段4號1樓');
  assert.equal(got.phone, '02-23216884');
  assert.equal(got.hours, '週一至週五');
});
