# DSH Plugins

DeepSeek Harness용 독립 플러그인 모음입니다. 저장소는 하나이고, 설치는 **링크 하나**로 시작합니다. 컬렉션 관리자가 하위 플러그인의 설치 상태와 GitHub 최신 버전을 보여 주고, 각 플러그인을 개별적으로 설치·업데이트합니다.

| 플러그인 | 역할 |
| --- | --- |
| **dsh-plugins** | 컬렉션 관리자. 하위 플러그인 설치, 업데이트 확인, 갱신, 활성화 상태 유지 |
| [dsh-session-delete](packages/dsh-session-delete/README.md) | 확인 후 다음 DSH 재시작 때 세션 영구 삭제 (Linux·Windows / Node 24+) |
| [dsh-web-search](packages/dsh-web-search/README.md) | Tavily 검색, Brave 대체 검색, API 키 설정 화면 |

## Harness에서 설치 (링크 하나)

1. Harness의 **Plugins → + Add plugin**을 클릭합니다.
2. 아래 주소를 입력하고 설치·활성화합니다.

```text
git+https://github.com/chdigda/plugins.git
```

3. **Plugins → Installed → dsh-plugins** 상세 페이지를 열면 **Plugin collection** 카드가 있습니다.
4. **Check for updates**(업데이트 확인)를 누르면 GitHub의 각 하위 플러그인 최신 버전을 조회합니다.
5. **Install or update all**(전체 설치·업데이트)을 누르거나 행별 **Install / Update**를 누릅니다.
6. 재시작 안내가 나오면 Harness를 다시 시작하고 브라우저를 새로고침합니다. 세션 삭제 플러그인은 부팅 순서가 필요하므로 설치·갱신 후 재시작해야 동작합니다.

링크 하나는 **컬렉션 관리자**를 설치하고, 관리자가 나머지 플러그인을 각각 설치합니다. DSH의 설치 단위는 패키지 하나이고 번들 하나에는 클라이언트 모듈이 하나만 붙기 때문에, 하위 플러그인을 별도 번들로 유지해야 개별 버전 확인·업데이트·제거가 가능합니다. 그래서 "한 번들에 모두 넣기" 대신 "관리자 + 개별 번들" 구조를 사용합니다.

## 업데이트 확인·갱신

- **컬렉션 카드**: 각 하위 플러그인의 설치 버전 → GitHub 최신 버전, 상태(미설치·최신·업데이트 가능·확인 불가·다른 소스), 행별 설치/업데이트 버튼, 전체 확인·전체 적용을 제공합니다.
- **개별 플러그인 상세의 업데이트 카드**: 기존과 동일하게 각 플러그인 페이지에서도 확인·갱신할 수 있습니다. 두 화면은 같은 GitHub 주소와 같은 규칙을 사용합니다.
- **갱신 방식**: 같은 GitHub 주소로 재설치합니다. Harness가 이미 설치된 패키지의 재설치를 거부하면 제거 후 재설치하며, 그동안 해당 플러그인의 화면이 잠시 사라질 수 있습니다. 저장된 설정·자격 증명·삭제 예약은 패키지 밖(프로필)에 있어 유지되지만, 재설치가 실패하면 플러그인이 제거된 상태로 남을 수 있습니다. 화면에 표시되는 설치 주소를 복사해 **+ Add plugin**에서 다시 추가하세요.
- **재시작**: 갱신 결과가 재시작을 요구하면 Harness를 다시 시작합니다. 세션 삭제 플러그인은 재시작이 필요하며, 대기 중인 삭제 예약이 있으면 그 재시작 때 처리될 수 있으니 미리 `/session-delete status`로 확인하고 필요하면 취소하세요.
- **관리 범위**: 이 저장소(또는 설치한 포크)의 브랜치 설치만 확인·갱신합니다. 로컬 번들 설치, 커밋·태그 고정 설치, 마켓의 커밋 고정 설치는 **다른 소스**로 표시하고 여기서 갱신하지 않습니다. 커밋 고정 설치를 옮기려면 해당 플러그인을 제거하고 컬렉션 소스로 다시 설치하세요.
- 네트워크 오류·GitHub 요청 제한은 **확인 불가**로 표시하며 최신 버전이라고 표시하지 않습니다. 자동 업데이트는 하지 않습니다.

## 개별 설치 (선택)

필요한 플러그인만 설치하려면 기존처럼 하위 경로 주소를 사용합니다.

**웹 검색**

```text
git+https://github.com/chdigda/plugins.git#path:/packages/dsh-web-search
```

**세션 영구 삭제**

```text
git+https://github.com/chdigda/plugins.git#path:/packages/dsh-session-delete
```

주소의 `#path:` 부분을 빼면 저장소 루트(컬렉션 관리자)를 설치합니다. GitHub의 `/tree/main/...` 페이지 주소가 아니라 위 주소를 사용하세요. 설치 주소는 pnpm이 지원하는 Git 하위 디렉터리 형식이며, pnpm 12.16.x에서 루트·하위 경로 설치를 모두 검증했습니다. 다른 Harness 배포본의 pnpm 버전에서는 하위 경로 지원 여부를 확인해야 합니다.

## 개발·배포

개발은 `main`의 `packages/<이름>`에서 합니다. 설치용 브랜치나 브랜치 간 머지는 필요하지 않습니다.

1. 변경한 패키지의 `package.json` 버전을 올립니다. 커밋만 바꾸고 버전을 그대로 두면 업데이트 알림은 나오지 않습니다.
2. 새 플러그인을 추가하면 `packages/<이름>`을 만들고 `collection.json`의 `plugins`에 이름·경로·표시 이름을 추가합니다. 컬렉션 관리자가 이 목록으로 확인·설치 대상을 정합니다.
3. `npm run build`로 클라이언트 파일을 생성하고, `npm test`로 업데이트 로직과 클라이언트 모듈을 검사합니다.
4. `npm run check`로 생성물이 최신인지 확인하고, 변경 기능은 대상 환경에서 직접 검증한 뒤 생성물까지 함께 커밋·푸시합니다. 설치할 때 별도 빌드나 빌드 스크립트 실행이 필요하지 않습니다.

업데이트 로직 원본은 `shared/plugin-updates.js`(개별 플러그인 카드)와 `shared/plugin-collection.js`(컬렉션 카드)이고, `scripts/build-clients.mjs`가 각 패키지와 저장소 루트에 이를 포함한 독립 클라이언트 파일을 만듭니다. 설치된 패키지는 저장소의 다른 폴더에 의존하지 않습니다. CI는 생성물 최신 여부, 클라이언트 구문, 업데이트 로직 테스트만 검사하며 기능·호환성을 보증하지 않습니다.

### 파일 구조

- `package.json` — 컬렉션 관리자 번들(`dsh.bundle.patch`, `dsh.client`)이자 워크스페이스 루트
- `cordis.patch.yml`, `index.mjs` — 컬렉션 관리자 행
- `collection.json` — 하위 플러그인 목록(이름·경로·표시 이름)
- `shared/plugin-collection.js` — 컬렉션 카드와 업데이트 컨트롤러 원본
- `shared/plugin-updates.js` — 개별 플러그인 업데이트 카드 원본
- `client-bundle.mjs`, `packages/*/client-bundle.mjs`, `packages/dsh-session-delete/client.mjs` — 빌드 생성물(커밋 대상)
- `packages/<이름>` — 독립 설치 가능한 하위 플러그인

## 참고

- [pnpm Git 하위 디렉터리 설치 문서](https://pnpm.io/package-sources#install-from-a-subdirectory-of-a-git-repository)
- [설치·업데이트 UX 참고 저장소](https://github.com/noire113-dev/deepseek-harness-kr) — 구현은 Harness 공개 API에 맞춰 독립 작성했습니다.

## 라이선스

[MIT](LICENSE) · Copyright (c) 2026 chdigda
