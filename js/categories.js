// 메뉴 탭 설정. 탭 추가·이름 변경·색 변경은 이 파일만 고치면 된다.
// match: 카카오 업종명(category_name)의 두 번째 단계 ("음식점 > 일식 > 초밥,롤" → "일식")
// groups: 카카오 카테고리 그룹 코드 전체를 이 탭으로 묶는다 (CE7 = 카페)
// fallback: 어느 탭에도 맞지 않는 업종이 들어가는 탭
export const TABS = [
  { id: 'all', label: '전체' },
  { id: 'korean', label: '한식', color: '#e5484d', match: ['한식'] },
  { id: 'chinese', label: '중식', color: '#f76b15', match: ['중식'] },
  { id: 'japanese', label: '일식', color: '#0090ff', match: ['일식'] },
  { id: 'western', label: '양식', color: '#8e4ec6', match: ['양식'] },
  { id: 'snack', label: '분식', color: '#d6409f', match: ['분식'] },
  { id: 'fastfood', label: '패스트푸드', color: '#d29e00', match: ['패스트푸드'] },
  { id: 'chicken', label: '치킨', color: '#a0715a', match: ['치킨'] },
  { id: 'cafe', label: '카페', color: '#30a46c', match: ['카페'], groups: ['CE7'] },
  { id: 'etc', label: '기타', color: '#6f7380', fallback: true },
];

// 점심 영업이 드물어 기본으로 숨기는 업종 (업종명 2단계 기준)
export const HIDDEN = ['술집'];

// 검색할 카카오 카테고리 그룹 코드
export const GROUP_CODES = ['FD6', 'CE7'];
