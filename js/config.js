// 카카오 개발자 콘솔 > 내 애플리케이션 > 앱 키 > "JavaScript 키"를 넣는다.
// 콘솔의 플랫폼 > Web > 사이트 도메인에 http://localhost:8000 과 배포 도메인을 등록해야 지도가 뜬다.
export const KAKAO_JS_KEY = 'b570b9026c3d9c7d51f899231de35215';

// 위치 권한이 없을 때 처음 보여 줄 지도 중심 (서울시청)
export const DEFAULT_CENTER = { lat: 37.5666805, lng: 126.9784147 };

export const RADIUS_M = 500;
export const RADIUS_OPTIONS = [300, 500, 1000];
export const CACHE_TTL_MS = 10 * 60 * 1000;
