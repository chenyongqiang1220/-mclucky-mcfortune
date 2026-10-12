'use strict';

/**
 * 定位辅助：浏览器 geolocation 给的是经纬度，
 * 但麦当劳 query-nearby-stores 只认「城市 + 地标关键词」，
 * 所以这里做一层免密钥的逆地理编码，把经纬度翻译成 city / keyword。
 *
 * 两个 provider 都不需要 API Key，互为备份：
 *   1. BigDataCloud reverse-geocode-client
 *   2. OpenStreetMap Nominatim
 */

const UA = 'maimen-daily-fortune/1.0 (contest demo)';

async function getJson(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 去掉行政后缀，麦当劳接口认「上海」不认「上海市」 */
function stripAdminSuffix(s = '') {
  return String(s).replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|市|县|区|省)$/g, '').trim();
}

async function viaBigDataCloud(lat, lng) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=zh`;
  const j = await getJson(url);
  const city = stripAdminSuffix(j.city || j.principalSubdivision || '');
  const locality = stripAdminSuffix(j.locality || '');
  if (!city) throw new Error('未识别到城市');
  return { city, keyword: locality || city, source: 'BigDataCloud' };
}

async function viaNominatim(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=zh&zoom=16`;
  const j = await getJson(url);
  const a = j.address || {};
  const city = stripAdminSuffix(a.city || a.town || a.county || a.state || '');
  if (!city) throw new Error('未识别到城市');
  const keyword = a.road || a.suburb || a.quarter || a.neighbourhood || city;
  return { city, keyword, source: 'Nominatim' };
}

/**
 * 逆地理编码。全部失败时抛出，由调用方降级成手动输入。
 */
async function reverseGeocode(lat, lng) {
  const errs = [];
  for (const fn of [viaBigDataCloud, viaNominatim]) {
    try {
      return await fn(lat, lng);
    } catch (e) {
      errs.push(`${fn.name}: ${e.message}`);
    }
  }
  throw new Error(`逆地理编码失败（${errs.join('；')}）`);
}

module.exports = { reverseGeocode, stripAdminSuffix };
