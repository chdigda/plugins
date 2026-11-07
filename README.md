# DSH Plugins

DeepSeek Harness용 독립 플러그인 모음입니다. 저장소와 개발 브랜치는 하나로 유지하고, 필요한 패키지만 설치합니다.

| 플러그인 | 기능 |
| --- | --- |
| [dsh-session-delete](packages/dsh-session-delete/README.md) | 확인 후 다음 DSH 재시작 때 세션 영구 삭제 (Linux·Windows / Node 24+) |
| [dsh-web-search](packages/dsh-web-search/README.md) | Tavily 검색, Brave 대체 검색, API 키 설정 화면 |
| [dsh-session-tweak](packages/dsh-session-tweak/README.md) | 모델 컨텍스트에서 사용자 메시지 수정·메시지 제거 |

## Harness에서 설치

1. Harness의 **Plugins → + Add plugin**을 클릭합니다.
2. 필요한 플러그인의 주소 **전체**를 입력하고 설치·활성화합니다.

**웹 검색**

```text
git+https://github.com/chdigda/plugins.git#path:/packages/dsh-web-search
```

**세션 영구 삭제**

```text
git+https://github.com/chdigda/plugins.git#path:/packages/dsh-session-delete
```

**세션 트윅**

```text
git+https://github.com/chdigda/plugins.git#path:/packages/dsh-session-tweak
```

3. Harness가 재시작을 요구하면 다시 시작하고 브라우저를 새로고침합니다. 세션 삭제는 부팅 순서가 필요하므로 설치 후 반드시 재시작합니다.

주소의 `#path:` 부분을 빼면 플러그인이 아닌 저장소 루트를 설치하게 됩니다. GitHub의 `/tree/main/...` 페이지 주소가 아닌 위 주소를 사용하세요. 설치 주소는 pnpm이 지원하는 Git 하위 디렉터리 형식이며, pnpm 12.15.0에서 세 패키지의 하위 디렉터리 설치를 검증했습니다. 다른 Harness 배포본의 pnpm 버전에서는 하위 경로 지원 여부를 확인해야 합니다. 설치 오류가 나면 진단 로그와 pnpm 버전을 확인하세요.

기존 로컬 설치는 자동으로 Git 설치로 바꾸지 않습니다. 로컬 번들로 설치했다면 해당 패키지를 제거한 후 위 주소로 다시 추가하세요. 동일한 패키지를 중복 등록하지 마세요. API 키, 삭제 예약, 프로필 설정은 저장소에 포함하지 않습니다.

## 업데이트 확인·갱신

0.3.0부터 **Plugins → Installed → 플러그인 상세 → Components → web-search 또는 session-delete**의 **업데이트** 화면에서 확인합니다.

- **업데이트 확인**: 설치한 GitHub 주소의 해당 패키지 버전을 조회합니다. 포크에서 설치했다면 그 포크를 확인합니다.
- **새 버전 → 업데이트 → 확인**: Harness 플러그인 관리자를 통해 같은 주소로 갱신합니다. 기존 활성화 상태를 유지합니다.
- Harness가 이미 설치된 패키지의 덮어쓰기를 거부하면 제거 후 재설치합니다. 프로필 설정·보안 자격 증명은 따로 보관되지만, 재설치 실패 시 플러그인이 제거된 상태로 남을 수 있습니다. 화면의 설치 주소를 복사해 **+ Add plugin**에서 다시 추가하세요.
- 재시작 안내가 나오면 Harness를 다시 시작합니다. 세션 삭제 플러그인은 갱신 후 재시작이 필요하며, 대기 중인 삭제 예약이 있으면 그 재시작 때 처리될 수 있습니다. 미리 `/session-delete status`로 확인하고 필요하면 취소하세요.
- 로컬 설치·커밋 고정·태그 고정 설치는 이 화면에서 갱신하지 않습니다. 자동 설치는 하지 않습니다.
- 세션 트윅에는 아직 업데이트 화면이 없습니다. 새 버전을 설치하려면 플러그인을 제거한 뒤 **+ Add plugin**에서 같은 주소로 다시 추가합니다.
- 네트워크 오류·GitHub 요청 제한은 확인 실패로 표시하며 최신 버전이라고 표시하지 않습니다.

현재 0.2.0에는 확인 화면이 없으므로 처음 한 번은 제거 후 같은 Git 주소로 다시 추가해야 합니다. **목록 새로고침**은 설치 목록을 다시 읽는 기능이지 GitHub 업데이트 확인이 아닙니다.

### 참고

- [pnpm Git 하위 디렉터리 설치 문서](https://pnpm.io/package-sources#install-from-a-subdirectory-of-a-git-repository)
- [설치·업데이트 UX 참고 저장소](https://github.com/noire113-dev/deepseek-harness-kr) — 구현은 Harness 공개 API에 맞춰 독립 작성했습니다.

## 라이선스

[MIT](LICENSE) · Copyright (c) 2026 chdigda
