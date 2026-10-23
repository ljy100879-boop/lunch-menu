// 지도 SDK와 무관한 순수 계산 함수. tests/core.test.html에서 검사한다.
import { TABS, HIDDEN } from './categories.js';

export const WALK_M_PER_MIN = 67;
const EARTH_R = 6371000;
const M_PER_DEG_LAT = 111320;

export function distanceM(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

export function walkMinutes(meters) {
  return Math.max(1, Math.ceil(meters / WALK_M_PER_MIN));
}

// 카카오 장소 → 탭 id. 숨김 업종이면 null.
export function classify(place) {
  const parts = (place.category_name || '').split('>').map((s) => s.trim());
  const second = parts[1] || '';
  if (HIDDEN.includes(second)) return null;
  const byGroup = TABS.find((t) => t.groups?.includes(place.category_group_code));
  if (byGroup) return byGroup.id;
  const byName = TABS.find((t) => t.match?.includes(second));
  if (byName) return byName.id;
  return TABS.find((t) => t.fallback).id;
}

// 카카오 응답 목록들을 하나로 합쳐 앱용 장소 객체로 바꾼다.
// 장소 ID로 중복 제거, 숨김 업종과 반경 밖 제거, 가까운 순 정렬.
export function buildPlaces(rawLists, center, radius) {
  const seen = new Set();
  const out = [];
  for (const raw of rawLists.flat()) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const tab = classify(raw);
    if (!tab) continue;
    const lat = Number(raw.y);
    const lng = Number(raw.x);
    const distance = Math.round(distanceM(center.lat, center.lng, lat, lng));
    if (distance > radius) continue;
    const parts = (raw.category_name || '').split('>').map((s) => s.trim());
    out.push({
      id: raw.id,
      name: raw.place_name,
      tab,
      // 마지막 단계는 브랜드명인 경우가 많아 3단계부터 이어 붙인다. 기타는 칩만으로 종류를 알 수 없어 2단계부터.
      detail: parts.slice(tab === 'etc' ? 1 : 2).join(' · '),
      lat,
      lng,
      distance,
      walk: walkMinutes(distance),
      address: raw.road_address_name || raw.address_name || '',
      phone: raw.phone || '',
      url: (raw.place_url || `https://place.map.kakao.com/${raw.id}`).replace(/^http:/, 'https:'),
    });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// 제외한 카테고리(탭 id 집합)와 숨긴 장소(장소 id 집합)를 뺀다.
export function includedPlaces(places, excluded, hiddenIds = new Set()) {
  if (!excluded.size && !hiddenIds.size) return places;
  return places.filter((p) => !excluded.has(p.tab) && !hiddenIds.has(p.id));
}

export function formatRadius(m) {
  return m >= 1000 ? `${m / 1000}km` : `${m}m`;
}

export function countByTab(places) {
  const counts = Object.fromEntries(TABS.map((t) => [t.id, 0]));
  counts.all = places.length;
  for (const p of places) counts[p.tab] += 1;
  return counts;
}

// 중심 기준 반경을 덮는 정사각형을 4개 사분면으로 나눈 경계. [[swLat, swLng], [neLat, neLng]]
export function quadrantBounds(center, radius) {
  const dLat = radius / M_PER_DEG_LAT;
  const dLng = radius / (M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180));
  const { lat, lng } = center;
  return [
    [[lat, lng - dLng], [lat + dLat, lng]],
    [[lat, lng], [lat + dLat, lng + dLng]],
    [[lat - dLat, lng - dLng], [lat, lng]],
    [[lat - dLat, lng], [lat, lng + dLng]],
  ];
}

// 후보 중 하나를 무작위로 고른다. 후보가 둘 이상이면 직전 결과는 뺀다.
export function pickRandom(candidates, excludeId, rand = Math.random) {
  const pool = candidates.length > 1 ? candidates.filter((p) => p.id !== excludeId) : candidates;
  if (pool.length === 0) return null;
  return pool[Math.floor(rand() * pool.length)];
}

// 카카오맵 도보 길찾기 링크. 이름의 쉼표·슬래시는 링크 구분자라 공백으로 바꾼다.
export function walkUrl(from, place) {
  const seg = (name, lat, lng) => `${encodeURIComponent(name.replace(/[,/]/g, ' '))},${lat},${lng}`;
  return `https://map.kakao.com/link/by/walk/${seg('내 위치', from.lat, from.lng)}/${seg(place.name, place.lat, place.lng)}`;
}

export function cacheKey(center, radius) {
  return `search:${center.lat.toFixed(4)},${center.lng.toFixed(4)},${radius}`;
}
