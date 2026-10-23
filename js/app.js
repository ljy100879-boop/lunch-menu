import { KAKAO_JS_KEY, DEFAULT_CENTER, RADIUS_M, RADIUS_OPTIONS, CACHE_TTL_MS } from './config.js';
import { TABS } from './categories.js';
import { countByTab, cacheKey, distanceM, pickRandom, walkUrl, includedPlaces, formatRadius } from './core.js';
import { loadSdk, searchNearby, coordToAddress, findLocation } from './kakao.js';

const $ = (id) => document.getElementById(id);
const tabById = Object.fromEntries(TABS.map((t) => [t.id, t]));
const FAV_TAB = 'fav';
const MAP_LEVEL = { 300: 3, 500: 4, 1000: 5 };

// localStorage 키: excludedTabs, favorites, hiddenPlaces, radius, theme
function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function loadExcluded() {
  const ids = loadJSON('excludedTabs', []);
  return new Set(Array.isArray(ids) ? ids.filter((id) => tabById[id] && id !== 'all') : []);
}

function saveExcluded() {
  saveJSON('excludedTabs', [...state.excluded]);
}

function loadRadius() {
  const r = loadJSON('radius', RADIUS_M);
  return RADIUS_OPTIONS.includes(r) ? r : RADIUS_M;
}

const state = {
  center: null,
  radius: loadRadius(),
  places: [],
  activeTab: 'all',
  selectedId: null,
  lastPickId: null,
  excluded: loadExcluded(),
  favorites: loadJSON('favorites', {}), // 장소 id → 이름
  hidden: loadJSON('hiddenPlaces', {}), // 장소 id → 이름
  hasResult: false,
  pickMode: false,
  searchSeq: 0,
};

let kakao, map, circle, centerOverlay;
const markers = new Map(); // place id → { overlay, el }

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// ── 안내 문구 ──────────────────────────────────────────

function showNotice(text, { action, onAction } = {}) {
  const box = $('notice');
  box.replaceChildren(h('span', {}, text), action && h('button', { type: 'button', onclick: onAction }, action));
  box.hidden = false;
}

function hideNotice() {
  $('notice').hidden = true;
}

function setListStatus(...children) {
  $('list').replaceChildren();
  $('list-status').replaceChildren(...children);
  $('list-status').hidden = false;
}

// ── 위치 정하기 (F1) ────────────────────────────────────

function requestLocation() {
  if (!navigator.geolocation || !window.isSecureContext) return locationFailed();
  $('loc-address').textContent = '위치를 확인하는 중…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    () => locationFailed(),
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
  );
}

function locationFailed() {
  if (state.center) {
    showNotice('현재 위치를 가져오지 못했어요. 주소를 검색하거나 지도에서 위치를 찍어 주세요.');
    return;
  }
  $('loc-address').textContent = '위치를 정해 주세요';
  showNotice('위치 권한이 없어 기본 지도(서울시청)를 보여줘요. 주소를 검색하거나 지도를 눌러 위치를 정하세요.');
  toggleSearchForm(true);
  setPickMode(true);
  setListStatus(h('p', { class: 'empty' }, '위치를 정하면 걸어갈 수 있는 식당을 보여드려요.'));
}

function setPickMode(on) {
  state.pickMode = on;
  $('btn-pick').setAttribute('aria-pressed', String(on));
  $('pick-hint').hidden = !on;
}

function toggleSearchForm(force) {
  const form = $('search-form');
  form.hidden = force === undefined ? !form.hidden : !force;
  $('btn-search-toggle').setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) $('search-input').focus();
}

async function onSearchSubmit(e) {
  e.preventDefault();
  const query = $('search-input').value.trim();
  if (!query) return;
  try {
    const loc = await findLocation(query);
    if (!loc) return showNotice(`"${query}"을(를) 찾지 못했어요. 다른 주소나 장소 이름으로 검색해 주세요.`);
    toggleSearchForm(false);
    setLocation(loc);
  } catch {
    showNotice('주소 검색 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.');
  }
}

function setLocation(center, radius = state.radius) {
  hideNotice();
  setPickMode(false);
  state.center = center;
  state.radius = radius;
  map.setCenter(new kakao.maps.LatLng(center.lat, center.lng));
  map.setLevel(MAP_LEVEL[radius] ?? 4);
  drawRange();
  $('btn-research').hidden = true;
  $('loc-address').textContent = '주소를 확인하는 중…';
  coordToAddress(center).then((addr) => {
    if (state.center === center) $('loc-address').textContent = addr || '선택한 위치';
  });
  runSearch();
}

// ── 검색 (F2) ──────────────────────────────────────────

function readCache(key) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(key));
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.places;
  } catch {}
  return null;
}

function writeCache(key, places) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), places }));
  } catch {}
}

async function runSearch() {
  const seq = ++state.searchSeq;
  const { center, radius } = state;
  const key = cacheKey(center, radius);
  let places = readCache(key);

  if (!places) {
    if (!state.hasResult) setListStatus(h('p', { class: 'loading' }, '주변 식당을 찾는 중…'));
    $('list-wrap').setAttribute('aria-busy', 'true');
    try {
      places = await searchNearby(center, radius);
      writeCache(key, places);
    } catch {
      if (seq !== state.searchSeq) return;
      $('list-wrap').removeAttribute('aria-busy');
      // 마지막 성공 결과는 그대로 두고 재시도만 안내한다
      if (state.hasResult) {
        showNotice('식당 정보를 새로 불러오지 못했어요. 이전 결과를 보여주고 있어요.', { action: '다시 시도', onAction: runSearch });
      } else {
        setListStatus(
          h('p', { class: 'empty' }, '식당 정보를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'),
          h('button', { type: 'button', class: 'btn-primary', onclick: runSearch }, '다시 시도'),
        );
      }
      return;
    }
    if (seq !== state.searchSeq) return;
    $('list-wrap').removeAttribute('aria-busy');
  }

  state.places = places;
  state.hasResult = true;
  state.selectedId = null;
  state.lastPickId = null;
  closeSheet();
  renderMarkers();
  render();
}

// ── 지도 (F2 범위, F5 마커) ─────────────────────────────

function initMap() {
  map = new kakao.maps.Map($('map'), {
    center: new kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
    level: 4,
  });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);

  kakao.maps.event.addListener(map, 'click', (e) => {
    if (!state.pickMode) return;
    const ll = e.latLng;
    setLocation({ lat: ll.getLat(), lng: ll.getLng() });
  });

  // 사용자가 지도를 끌어 중심이 바뀌면 "이 위치에서 다시 찾기"를 띄운다
  kakao.maps.event.addListener(map, 'dragend', () => {
    if (!state.center) return;
    const c = map.getCenter();
    const moved = distanceM(state.center.lat, state.center.lng, c.getLat(), c.getLng());
    $('btn-research').hidden = moved < 50;
  });
}

function drawRange() {
  const pos = new kakao.maps.LatLng(state.center.lat, state.center.lng);
  circle?.setMap(null);
  circle = new kakao.maps.Circle({
    center: pos,
    radius: state.radius,
    strokeWeight: 2,
    strokeColor: '#2563eb',
    strokeOpacity: 0.7,
    strokeStyle: 'dash',
    fillColor: '#2563eb',
    fillOpacity: 0.06,
  });
  circle.setMap(map);

  centerOverlay?.setMap(null);
  centerOverlay = new kakao.maps.CustomOverlay({
    position: pos,
    content: h('div', { class: 'me-dot', title: '기준 위치' }),
    zIndex: 3,
  });
  centerOverlay.setMap(map);
}

function renderMarkers() {
  for (const { overlay } of markers.values()) overlay.setMap(null);
  markers.clear();
  for (const p of state.places) {
    const tab = tabById[p.tab];
    const el = h(
      'button',
      {
        type: 'button',
        class: `marker${state.favorites[p.id] ? ' is-fav' : ''}`,
        style: `--c:${tab.color}`,
        'aria-label': `${p.name}, ${tab.label}, ${p.distance}m`,
      },
      h('span', { class: 'marker-label' }, p.name),
    );
    el.addEventListener('click', () => selectPlace(p.id, { from: 'map' }));
    const overlay = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(p.lat, p.lng),
      content: el,
      clickable: true,
      zIndex: 1,
    });
    markers.set(p.id, { overlay, el });
  }
}

function clearSelection() {
  const prev = markers.get(state.selectedId);
  if (prev) {
    prev.el.classList.remove('is-selected');
    prev.overlay.setZIndex(1);
  }
  document.querySelector('.card.is-selected')?.classList.remove('is-selected');
  state.selectedId = null;
}

function selectPlace(id, { from }) {
  clearSelection();
  state.selectedId = id;
  const m = markers.get(id);
  if (!m) return;
  m.el.classList.add('is-selected');
  m.overlay.setZIndex(5);

  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  card?.classList.add('is-selected');
  if (from !== 'list') card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (from !== 'map') map.panTo(m.overlay.getPosition());
}

// ── 탭·목록 렌더링 (F3, F4) ─────────────────────────────

function included() {
  return includedPlaces(state.places, state.excluded, new Set(Object.keys(state.hidden)));
}

function inTab(p, tabId) {
  if (tabId === 'all') return true;
  if (tabId === FAV_TAB) return Boolean(state.favorites[p.id]);
  return p.tab === tabId;
}

function visiblePlaces() {
  return included().filter((p) => inTab(p, state.activeTab));
}

function render() {
  const inc = included();
  const counts = countByTab(inc);
  counts[FAV_TAB] = inc.filter((p) => state.favorites[p.id]).length;
  if (state.excluded.has(state.activeTab) || counts[state.activeTab] === 0) state.activeTab = 'all';
  renderTabs(counts);
  renderList();
  const visible = visiblePlaces();
  $('btn-random').hidden = !state.hasResult;
  $('btn-random').disabled = visible.length === 0;
  const shown = new Set(visible.map((p) => p.id));
  for (const [id, m] of markers) m.overlay.setMap(shown.has(id) ? map : null);
}

function renderTabs(counts) {
  const n = state.excluded.size + Object.keys(state.hidden).length;
  const tabs = TABS.filter((t) => !state.excluded.has(t.id));
  tabs.splice(1, 0, { id: FAV_TAB, label: '즐겨찾기', icon: '★' });
  $('tabs').replaceChildren(
    h(
      'button',
      { type: 'button', class: `tab tab-exclude${n ? ' is-on' : ''}`, 'aria-haspopup': 'dialog', onclick: openExcludeDialog },
      n ? `제외 ${n}` : '제외 설정',
    ),
    ...tabs.map((t) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: `tab${t.id === FAV_TAB ? ' tab-fav' : ''}`,
          'aria-selected': String(t.id === state.activeTab),
          disabled: state.hasResult && !counts[t.id],
          style: t.color ? `--c:${t.color}` : false,
          onclick: () => {
            state.activeTab = t.id;
            const sel = state.places.find((p) => p.id === state.selectedId);
            if (sel && !inTab(sel, t.id)) clearSelection();
            state.lastPickId = null;
            closeSheet();
            render();
          },
        },
        t.color && h('span', { class: 'tab-dot', 'aria-hidden': 'true' }),
        t.icon && h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, t.icon),
        t.label,
        h('span', { class: 'tab-count' }, state.hasResult ? String(counts[t.id] ?? 0) : '–'),
      ),
    ),
  );
}

function renderList() {
  const visible = visiblePlaces();
  const radiusText = formatRadius(state.radius);

  if (visible.length === 0 && state.places.length > 0) {
    const allOut = state.excluded.size === TABS.length - 1;
    setListStatus(
      h('p', { class: 'empty' }, allOut ? '모든 카테고리를 제외했어요.' : '제외하거나 숨기지 않은 식당이 없어요.'),
      h('button', { type: 'button', class: 'btn-primary', onclick: openExcludeDialog }, '제외 설정 열기'),
    );
    return;
  }

  if (visible.length === 0) {
    const children = [h('p', { class: 'empty' }, `${radiusText} 안에 식당이 없어요.`)];
    const wider = RADIUS_OPTIONS.find((r) => r > state.radius);
    if (wider) {
      children.push(
        h('button', { type: 'button', class: 'btn-primary', onclick: () => setRadius(wider) }, `반경 ${formatRadius(wider)}로 넓혀 찾기`),
      );
    }
    setListStatus(...children);
    return;
  }

  $('list-status').hidden = true;
  $('list').replaceChildren(
    ...visible.map((p) => {
      const tab = tabById[p.tab];
      return h(
        'li',
        {},
        h(
          'article',
          {
            class: `card${p.id === state.selectedId ? ' is-selected' : ''}`,
            'data-id': p.id,
            tabindex: '0',
            onclick: (e) => {
              if (e.target.closest('a, button')) return;
              selectPlace(p.id, { from: 'list' });
            },
            onkeydown: (e) => {
              if (e.target !== e.currentTarget) return; // 카드 안 버튼·링크의 Enter는 그대로 둔다
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectPlace(p.id, { from: 'list' });
              }
            },
          },
          h(
            'div',
            { class: 'card-head' },
            h('h3', { class: 'card-name' }, p.name),
            h('span', { class: 'card-dist' }, `${p.distance}m · 도보 ${p.walk}분`),
            favButton(p),
          ),
          h(
            'p',
            { class: 'card-cat' },
            h('span', { class: 'chip', style: `--c:${tab.color}` }, tab.label),
            p.detail ? h('span', { class: 'card-detail' }, p.detail) : null,
          ),
          p.address && h('p', { class: 'card-meta' }, p.address),
          p.phone && h('p', { class: 'card-meta' }, h('a', { href: `tel:${p.phone}` }, p.phone)),
          placeLinks(p),
        ),
      );
    }),
  );
}

function placeLinks(p) {
  return h(
    'div',
    { class: 'card-links' },
    h('a', { class: 'card-link', href: walkUrl(state.center, p), target: '_blank', rel: 'noopener' }, '도보 길찾기 ↗'),
    h('a', { class: 'card-link', href: p.url, target: '_blank', rel: 'noopener' }, '카카오맵에서 보기 ↗'),
    h('button', { type: 'button', class: 'card-hide', onclick: () => hidePlace(p) }, '숨기기'),
  );
}

// ── 즐겨찾기·숨기기 (F8) ────────────────────────────────

function favButton(p) {
  const on = Boolean(state.favorites[p.id]);
  return h(
    'button',
    {
      type: 'button',
      class: 'fav-btn',
      'data-fav': p.id,
      'aria-pressed': String(on),
      'aria-label': `${p.name} 즐겨찾기`,
      onclick: () => toggleFavorite(p),
    },
    on ? '★' : '☆',
  );
}

function toggleFavorite(p) {
  const on = !state.favorites[p.id];
  if (on) state.favorites[p.id] = p.name;
  else delete state.favorites[p.id];
  saveJSON('favorites', state.favorites);
  markers.get(p.id)?.el.classList.toggle('is-fav', on);
  for (const btn of document.querySelectorAll(`[data-fav="${CSS.escape(p.id)}"]`)) {
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '★' : '☆';
  }
  render();
}

function hidePlace(p) {
  state.hidden[p.id] = p.name;
  saveJSON('hiddenPlaces', state.hidden);
  if (state.selectedId === p.id) clearSelection();
  if (state.lastPickId === p.id) {
    state.lastPickId = null;
    closeSheet();
  }
  render();
  showNotice(`"${p.name}"을(를) 숨겼어요.`, { action: '되돌리기', onAction: () => unhidePlace(p.id) });
}

function unhidePlace(id) {
  delete state.hidden[id];
  saveJSON('hiddenPlaces', state.hidden);
  hideNotice();
  renderHiddenList();
  render();
}

function renderHiddenList() {
  const entries = Object.entries(state.hidden);
  $('hidden-list').replaceChildren(
    ...(entries.length
      ? entries.map(([id, name]) =>
          h(
            'li',
            { class: 'hidden-item' },
            h('span', { class: 'hidden-name' }, name),
            h('button', { type: 'button', class: 'btn-ghost', onclick: () => unhidePlace(id) }, '다시 보기'),
          ),
        )
      : [h('li', { class: 'hidden-empty' }, '숨긴 식당이 없어요. 목록 카드의 "숨기기"로 추가할 수 있어요.')]),
  );
}

// ── 반경 선택 (F14) ────────────────────────────────────

function renderRadius() {
  $('radius-select').replaceChildren(
    ...RADIUS_OPTIONS.map((r) =>
      h(
        'button',
        { type: 'button', class: 'radius-opt', 'aria-pressed': String(r === state.radius), onclick: () => setRadius(r) },
        formatRadius(r),
      ),
    ),
  );
}

function setRadius(r) {
  state.radius = r;
  saveJSON('radius', r);
  renderRadius();
  if (state.center && map) setLocation(state.center, r);
}

// ── 다크 모드 (F15) ────────────────────────────────────

function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function renderThemeButton() {
  const dark = currentTheme() === 'dark';
  const label = dark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기';
  const btn = $('btn-theme');
  btn.textContent = dark ? '☀' : '☾';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  saveJSON('theme', next);
  renderThemeButton();
}

// ── 랜덤 추천 (F6) ─────────────────────────────────────

function pickAndShow() {
  const candidates = visiblePlaces();
  const p = pickRandom(candidates, state.lastPickId);
  if (!p) return;
  state.lastPickId = p.id;
  selectPlace(p.id, { from: 'pick' });
  renderSheet(p, candidates.length);
}

function renderSheet(p, total) {
  const tab = tabById[p.tab];
  const scope = state.activeTab === 'all' ? '전체' : `${tabById[state.activeTab]?.label ?? '즐겨찾기'} 탭`;
  $('sheet').replaceChildren(
    h(
      'div',
      { class: 'sheet-head' },
      h('span', { class: 'sheet-kicker' }, `오늘은 여기 어때요? · ${scope} ${total}곳 중`),
      h('button', { type: 'button', class: 'sheet-close', 'aria-label': '닫기', onclick: closeSheet }, '✕'),
    ),
    h('div', { class: 'sheet-title-row' }, h('h2', { id: 'sheet-title', class: 'sheet-name' }, p.name), favButton(p)),
    h(
      'p',
      { class: 'card-cat' },
      h('span', { class: 'chip', style: `--c:${tab.color}` }, tab.label),
      p.detail ? h('span', { class: 'card-detail' }, p.detail) : null,
    ),
    h('p', { class: 'sheet-dist' }, `${p.distance}m · 도보 ${p.walk}분`),
    p.address && h('p', { class: 'card-meta' }, p.address),
    h(
      'div',
      { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn-ghost', disabled: total < 2, onclick: pickAndShow }, '다시 뽑기'),
      h('a', { class: 'btn-primary', href: walkUrl(state.center, p), target: '_blank', rel: 'noopener' }, '도보 길찾기 ↗'),
    ),
    h('a', { class: 'card-link', href: p.url, target: '_blank', rel: 'noopener' }, '카카오맵에서 보기 ↗'),
  );
  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
}

// ── 카테고리 제외 (F13) ─────────────────────────────────

function openExcludeDialog() {
  renderExcludeOptions();
  renderHiddenList();
  $('exclude-dialog').showModal();
}

function renderExcludeOptions() {
  const counts = countByTab(state.places);
  $('exclude-options').replaceChildren(
    ...TABS.filter((t) => t.id !== 'all').map((t) =>
      h(
        'label',
        { class: 'exclude-option', style: `--c:${t.color}` },
        h('input', {
          type: 'checkbox',
          checked: !state.excluded.has(t.id),
          onchange: (e) => setExcluded(t.id, !e.target.checked),
        }),
        h('span', { class: 'tab-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'exclude-label' }, t.label),
        state.hasResult && h('span', { class: 'tab-count' }, String(counts[t.id])),
      ),
    ),
  );
}

function setExcluded(tabId, on) {
  if (on) state.excluded.add(tabId);
  else state.excluded.delete(tabId);
  saveExcluded();
  const sel = state.places.find((p) => p.id === state.selectedId);
  if (sel && state.excluded.has(sel.tab)) clearSelection();
  const pick = state.places.find((p) => p.id === state.lastPickId);
  if (pick && state.excluded.has(pick.tab)) {
    state.lastPickId = null;
    closeSheet();
  }
  render();
}

// ── 시작 ───────────────────────────────────────────────

function bindUi() {
  $('btn-mylocation').addEventListener('click', requestLocation);
  $('btn-search-toggle').addEventListener('click', () => toggleSearchForm());
  $('btn-pick').addEventListener('click', () => setPickMode(!state.pickMode));
  $('search-form').addEventListener('submit', onSearchSubmit);
  $('btn-random').addEventListener('click', pickAndShow);
  $('btn-include-all').addEventListener('click', () => {
    state.excluded.clear();
    saveExcluded();
    renderExcludeOptions();
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
  $('btn-research').addEventListener('click', () => {
    const c = map.getCenter();
    setLocation({ lat: c.getLat(), lng: c.getLng() }, state.radius);
  });
}

async function start() {
  renderTabs(countByTab([]));
  renderRadius();
  renderThemeButton();
  $('btn-theme').addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton);
  if (!KAKAO_JS_KEY) {
    $('loc-address').textContent = '설정 필요';
    setListStatus(h('p', { class: 'empty' }, 'js/config.js에 카카오 JavaScript 키를 넣어 주세요.'));
    return;
  }
  try {
    kakao = await loadSdk(KAKAO_JS_KEY);
  } catch {
    $('loc-address').textContent = '지도를 불러오지 못했어요';
    setListStatus(
      h('p', { class: 'empty' }, '카카오 지도를 불러오지 못했어요. JavaScript 키와 콘솔에 등록한 사이트 도메인을 확인해 주세요.'),
    );
    return;
  }
  initMap();
  bindUi();
  requestLocation();
}

start();
