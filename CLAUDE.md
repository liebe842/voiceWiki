# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 개요

VoiceWiki(보이스위키): 음성 메모 녹음 → Gemini가 전사·정리 → Google Drive 위키 폴더에 `.md` 노트 생성. 주석과 UI 문구는 한국어.

**서로 다른 곳에서 실행되는** 두 조각이 단 하나의 HTTP POST로만 통신한다:

- **`index.html`** — 녹음 UI. 일반 정적 페이지로 서빙됨(GAS를 통하지 않음). `MediaRecorder`로 마이크 오디오를 녹음하고, blob을 base64로 인코딩해 백엔드로 POST한다.
- **`Code.js`** — Google Apps Script(GAS) 웹앱 백엔드. 오디오를 받아 Gemini를 호출하고, 결과 `.md`를 Drive에 기록한다.

### 왜 분리되어 있나 (합치지 말 것 — 중요)

GAS 웹앱 HTML은 샌드박스 iframe 안에서 실행돼 `getUserMedia`(마이크 접근)가 차단된다. 그래서 녹음은 반드시 최상위 정적 페이지에서 이뤄지고, 그 페이지가 GAS `/exec` 엔드포인트로 POST한다. 녹음 UI를 GAS `HtmlService` 페이지로 옮기지 말 것 — 마이크가 동작하지 않는다.

## 아키텍처 / 데이터 흐름

1. `index.html`이 오디오를 녹음하고, `pickMimeType()`으로 MIME 타입 선택(`audio/ogg;codecs=opus` 우선), base64로 변환한다.
2. `{ token, audio, mime, ts, repo }`를 `text/plain` + `mode: 'no-cors'`로 POST한다. GAS는 CORS 헤더를 붙이지 않으므로 프론트는 응답을 읽을 수 없다 — 전송은 낙관적(fire-and-forget) 처리. `text/plain`은 CORS preflight를 피하기 위함.
3. `Code.js`의 `doPost(e)`가 `token === VW_TOKEN`을 확인하고 `resolveFolder_(repo)`로 대상 폴더를 고른 뒤, 정상 경로에서는 `transcribe_()`를 호출하고 **`.md`만** 기록한다(오디오는 보관하지 않음).
4. 전사 실패 시에만 원본 오디오를 백업 저장(`saveAudioToFolder_`)해 메모 유실을 막고, 에러 + 백업 파일명을 반환한다.
5. `writeMarkdown_()`이 YAML 프론트매터(`title/type: source/tags: [voice]/sources/updated`) + 요약 + 본문을 출력하며, 위키 노트 스키마를 따른다.

## 저장소(Drive 폴더) 선택

여러 저장소를 지원한다. 백엔드 `REPOS` 맵(`Code.js`)이 **키 → `{id, label}`** 를 담고(`DEFAULT_REPO`가 기본), `resolveFolder_(repoKey)`가 키를 폴더로 해석한다(알 수 없는 키는 기본값 폴백). 프론트는 저장 시 POST 본문에 선택한 `repo` 키를 실어 보낸다.

- **repo 키는 이름과 분리**되어 있다 — `label`이나 Drive 폴더 이름이 바뀌어도 프론트가 localStorage(`vw_repo`)에 저장한 선택값이 깨지지 않는다.
- 드롭다운의 **표시 이름은 `REPOS[key].label`**(앱 표시 이름, Drive 폴더명과 별개)이며, `doGet`의 **JSONP** 목록 엔드포인트로 받아온다: `GAS_URL?list=1&token=...&callback=cb` → `cb({repos:[{key,name}]})`. no-cors라 `fetch`로는 응답을 못 읽으므로 프론트는 `<script>` 태그(JSONP)로 로드하고, 실패 시 `index.html`의 `FALLBACK_REPOS`를 쓴다(백엔드 label과 맞춰 유지).
- 저장소를 추가하려면 `REPOS`에 키/`{id, label}` 한 줄만 추가하면 프론트 드롭다운에 자동 반영된다.

## 반드시 동기화해야 하는 결합점

- **공유 토큰**: `Code.js`의 `VW_TOKEN`은 `index.html`(`<script>` 설정 블록)의 `TOKEN`과 정확히 일치해야 한다. 불일치 시 `unauthorized`(JSONP 목록도 빈 배열 반환).
- **엔드포인트 URL**: `index.html`의 `GAS_URL`은 배포된 `/exec` URL. clasp로 새로 배포할 때마다 바뀌므로, 재배포 후 이 값을 갱신해야 한다.
- **`REPOS` / `DEFAULT_REPO`**(`Code.js`) — 저장소 키→Drive 폴더 ID 맵. `VOICE_FOLDER_ID`는 기본 저장소를 가리키는 하위호환 별칭(수동 함수용).
- **`GEMINI_API_KEY`** — 코드에 없음. GAS Script Properties에 저장(에디터 → 프로젝트 설정 → 스크립트 속성). `getGeminiKey_()`로 읽는다.

## 배포 / 개발 워크플로

배포는 [clasp](https://github.com/google/clasp)로 한다(`.clasp.json`에 `scriptId` 저장). 빌드 단계, 테스트, 린터 없음.

```bash
clasp push                   # Code.js + index.html + appsscript.json을 GAS 프로젝트로 업로드
clasp deployments            # 기존 배포 ID 목록 확인
clasp deploy -i <배포ID>      # 기존 배포를 최신 코드로 갱신 (/exec URL 유지) — 권장
```

**배포는 기존 배포를 `-i`로 덮어쓰는 방식을 쓴다.** 이렇게 하면 `/exec` URL이 그대로라 `index.html`의 `GAS_URL`을 건드릴 필요가 없다.

`-i` 없이 `clasp deploy`를 실행하면 **매번 새 배포가 생성돼 `/exec` URL이 바뀐다.** 이 경우에만 새 URL을 `index.html`의 `GAS_URL`에 복사한 뒤 정적 페이지를 다시 호스팅해야 한다(`GAS_URL`을 바꿨으면 어느 경우든 정적 페이지 재호스팅 필요).

### GAS 에디터에서 수동 실행하는 함수 (CLI 대응 없음)

- `authorizeAndTest()` — 최초 1회 실행. Drive OAuth 승인 + 폴더 접근 확인.
- `listGeminiModels()` — 현재 API 키로 쓸 수 있는 Gemini 모델을 로그로 출력(`GEMINI_MODEL` 선택/확인용).
- `transcribeLatest()` — 폴더 내 가장 최근 오디오 파일을 끝까지 전사. UI를 거치지 않고 Gemini + `.md` 포맷을 테스트할 때 사용.

`appsscript.json`: 타임존 `Asia/Seoul`, V8 런타임, 스코프 `drive` + `script.external_request`, 웹앱은 `ANYONE_ANONYMOUS` 접근 + 배포자 권한으로 실행.
