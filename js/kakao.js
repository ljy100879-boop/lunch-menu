// 카카오맵 SDK 로딩과 services 라이브러리 호출을 Promise로 감싼다.
import { GROUP_CODES } from './categories.js';
import { buildPlaces, quadrantBounds } from './core.js';

const MAX_PAGES = 3;
const MAX_RESULTS = 45;

export function loadSdk(appKey) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&libraries=services&autoload=false`;
    s.onload = () => {
      if (!window.kakao?.maps?.load) return reject(new Error('sdk'));
      window.kakao.maps.load(() => resolve(window.kakao));
    };
    s.onerror = () => reject(new Error('sdk'));
    document.head.appendChild(s);
  });
}

// 한 카테고리 그룹을 최대 3페이지(45곳)까지 받아 온다.
function categorySearchAll(code, options) {
  const { services } = window.kakao.maps;
  return new Promise((resolve, reject) => {
    const items = [];
    new services.Places().categorySearch(
      code,
      (data, status, pagination) => {
        if (status === services.Status.ZERO_RESULT) return resolve({ items });
        if (status !== services.Status.OK) return reject(new Error('search'));
        items.push(...data);
        if (pagination.hasNextPage && pagination.current < MAX_PAGES) pagination.nextPage();
        else resolve({ items });
      },
      options,
    );
  });
}

// 그룹 하나를 검색한다. 45곳을 꽉 채워 받으면 사분면 4개로 나눠 다시 받는다.
// (SDK의 totalCount는 45에서 잘려 와서 받은 개수로 판단한다)
async function searchGroup(code, center, radius) {
  const { maps } = window.kakao;
  const location = new maps.LatLng(center.lat, center.lng);
  const sort = maps.services.SortBy.DISTANCE;
  const first = await categorySearchAll(code, { location, radius, sort });
  if (first.items.length < MAX_RESULTS) return first.items;

  const quads = await Promise.all(
    quadrantBounds(center, radius).map(([sw, ne]) => {
      const bounds = new maps.LatLngBounds(new maps.LatLng(...sw), new maps.LatLng(...ne));
      return categorySearchAll(code, { bounds, location, sort });
    }),
  );
  return [first.items, ...quads.map((q) => q.items)].flat();
}

export async function searchNearby(center, radius) {
  const lists = await Promise.all(GROUP_CODES.map((code) => searchGroup(code, center, radius)));
  return buildPlaces(lists, center, radius);
}

export function coordToAddress(center) {
  const { services } = window.kakao.maps;
  return new Promise((resolve) => {
    new services.Geocoder().coord2Address(center.lng, center.lat, (result, status) => {
      if (status !== services.Status.OK || !result[0]) return resolve('');
      const r = result[0];
      resolve(r.road_address?.address_name || r.address?.address_name || '');
    });
  });
}

// 주소로 먼저 찾고, 없으면 장소 이름(예: 강남역)으로 찾는다.
export function findLocation(query) {
  const { services } = window.kakao.maps;
  const pick = (r) => ({ lat: Number(r.y), lng: Number(r.x) });
  return new Promise((resolve, reject) => {
    new services.Geocoder().addressSearch(query, (result, status) => {
      if (status === services.Status.OK && result[0]) return resolve(pick(result[0]));
      if (status === services.Status.ERROR) return reject(new Error('search'));
      new services.Places().keywordSearch(query, (places, s2) => {
        if (s2 === services.Status.OK && places[0]) return resolve(pick(places[0]));
        if (s2 === services.Status.ERROR) return reject(new Error('search'));
        resolve(null);
      });
    });
  });
}
