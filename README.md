# DSH Plugins

DeepSeek Harness용 로컬 플러그인 모음입니다. 각 패키지는 독립적으로 설치합니다.

| 플러그인 | 기능 |
| --- | --- |
| [dsh-session-delete](packages/dsh-session-delete/README.md) | 확인 후 다음 DSH 재시작 때 세션 영구 삭제 |
| [dsh-web-search](packages/dsh-web-search/README.md) | Tavily 검색, Brave 대체 검색, API 키 설정 화면 |

## 설치

사용할 패키지 디렉터리를 DSH 플러그인 관리자에서 로컬 번들로 추가하고 활성화합니다. 저장소 루트가 아닌 `packages/<플러그인 이름>`을 지정하세요.

**Plugins → Installed**에서 각 패키지의 활성화 스위치로 독립적으로 켜고 끕니다. 내부 모듈 스위치가 아닌 패키지 전체 스위치를 사용하세요. 세션 삭제를 끄면 예약 처리도 멈추며, 다시 켠 뒤 다음 재시작부터 처리합니다.

이 저장소에는 소스만 보관합니다. API 키, DSH 프로필 설정, 대화 기록은 포함하지 않습니다. 기존 설치 경로는 자동으로 변경하지 않습니다.
