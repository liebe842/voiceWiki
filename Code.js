/**
 * 보이스위키 (VoiceWiki) — GAS 저장 + 전사 백엔드
 *
 * 녹음 UI는 별도 정적 호스트(web/index.html)에서 돌아가고,
 * 이 스크립트는 오디오를 받아 Google Drive raw/voice에 저장한 뒤 Gemini로 전사해 .md를 만든다.
 *
 * 왜 백엔드 분리?
 *   GAS 웹앱 HTML은 샌드박스 iframe 안에서 실행돼 마이크(getUserMedia)가 차단된다.
 *   그래서 녹음은 최상위 정적 페이지에서 하고, 여기로 POST만 보낸다.
 *
 * Phase 1: 오디오 저장.  Phase 2: Gemini 전사 → .md 생성.
 */

// ── 설정 ─────────────────────────────────────────────
// 저장소(Drive 폴더) 맵. 키는 이름과 무관하게 안정적으로 유지 —
// 폴더 이름/라벨이 바뀌어도 프론트가 저장한 선택값(localStorage)이 깨지지 않도록.
// label = 드롭다운에 표시할 앱 이름(Drive 폴더명과 별개).
const REPOS = {
  voice:  { id: '1Kbhx-lYbR3-B2fnv5oLkII_a6LQc1An6', label: '바이브코딩' }, // claude-code-wiki/raw/voice
  second: { id: '1MLLig8sBjRFGPEDzyu2xjmC2Z9WCIn1z', label: '일상기록' },
};
const DEFAULT_REPO = 'voice';
// 하위호환: 폴더 하나만 참조하는 수동 함수용(transcribeLatest 등)
const VOICE_FOLDER_ID = REPOS[DEFAULT_REPO].id;

// 아무나 POST 못 하게 막는 공유 토큰. 프론트(web/index.html)의 TOKEN과 반드시 일치.
const VW_TOKEN = 'vwk-7f3a91c4e28b5d06';

// Gemini 모델 ID. listGeminiModels()로 키에서 쓸 수 있는 모델 확인 후 조정.
const GEMINI_MODEL = 'gemini-2.5-flash';
// ─────────────────────────────────────────────────────

/** Script Properties에서 Gemini API 키를 읽는다. (에디터: 프로젝트 설정 → 스크립트 속성) */
function getGeminiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 미설정 (스크립트 속성에 추가하세요)');
  return key;
}

// ── 진단 / 셋업 함수 (에디터에서 수동 실행) ──────────────

/** 최초 1회: Drive 권한 승인 + 폴더 접근 확인. 로그에 폴더 이름이 찍히면 정상. */
function authorizeAndTest() {
  const folder = DriveApp.getFolderById(VOICE_FOLDER_ID);
  Logger.log('폴더 접근 OK: ' + folder.getName());
  return folder.getName();
}

/** 이 API 키로 쓸 수 있는 모델 목록을 로그로 출력. generateContent 지원 모델만. */
function listGeminiModels() {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + getGeminiKey_();
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  (data.models || []).forEach(function (m) {
    const methods = m.supportedGenerationMethods || [];
    if (methods.indexOf('generateContent') !== -1) {
      Logger.log(m.name + '  ← ' + m.displayName);
    }
  });
  return data;
}

/** 폴더에서 가장 최근 오디오 파일을 전사해 .md를 만든다. (Gemini/포맷 검증용) */
function transcribeLatest() {
  const folder = DriveApp.getFolderById(VOICE_FOLDER_ID);
  const files = folder.getFiles();
  let newest = null, newestTime = 0;
  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    if (/\.md$/i.test(name)) continue; // md는 건너뜀
    const t = f.getDateCreated().getTime();
    if (t > newestTime) { newestTime = t; newest = f; }
  }
  if (!newest) throw new Error('전사할 오디오 파일이 없습니다');

  const base64 = Utilities.base64Encode(newest.getBlob().getBytes());
  const mime = newest.getBlob().getContentType() || mimeFromName_(newest.getName());
  const nameBase = newest.getName().replace(/\.[^.]+$/, '');

  const parsed = transcribe_(base64, mime);
  const mdFile = writeMarkdown_(folder, nameBase, newest.getDateCreated(), parsed);
  Logger.log('전사 완료 → ' + mdFile.getName() + '\n제목: ' + parsed.title + '\n요약: ' + parsed.summary);
  return parsed;
}

// ── 웹앱 엔드포인트 ──────────────────────────────────

/**
 * 접근 확인용 + 저장소 목록(JSONP) 엔드포인트.
 * ?list=1&token=...&callback=cb 로 호출하면 각 REPO의 표시 라벨을 담아
 * cb({repos:[{key,name}]}) 형태의 JavaScript를 반환한다.
 * 프론트가 no-cors라 fetch로는 응답을 못 읽으므로 <script> 태그(JSONP)로 로드한다.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.list) {
    const cb = p.callback || 'callback';
    let repos = [];
    if (p.token === VW_TOKEN) {
      repos = Object.keys(REPOS).map(function (k) {
        return { key: k, name: REPOS[k].label || k };
      });
    }
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify({ repos: repos }) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput('VoiceWiki backend is running. POST audio here.')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * 프론트에서 보낸 오디오를 전사해 .md만 저장한다. (오디오 파일은 남기지 않음)
 * 전사가 실패할 때만 메모 유실 방지용으로 오디오를 백업 저장한다.
 * 요청 본문(JSON, text/plain 전송): { token, audio(base64), mime, ts }
 */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.token !== VW_TOKEN) return json({ ok: false, error: 'unauthorized' });
    if (!body.audio) return json({ ok: false, error: 'no audio' });

    const folder = resolveFolder_(body.repo);
    const when = body.ts ? new Date(body.ts) : new Date();
    const nameBase = timestampName(body.ts);

    try {
      // 정상 흐름: 전사 → .md 만 생성 (오디오 저장 안 함)
      const parsed = transcribe_(body.audio, body.mime);
      const md = writeMarkdown_(folder, nameBase, when, parsed);
      return json({ ok: true, md: md.getName(), title: parsed.title });
    } catch (tErr) {
      // 실패 시에만 원본 오디오를 백업 저장해 메모 유실 방지
      let backup = null;
      try { backup = saveAudioToFolder_(folder, body.audio, body.mime, nameBase).getName(); } catch (_) {}
      return json({
        ok: false,
        transcribeError: String(tErr && tErr.message ? tErr.message : tErr),
        audioBackup: backup
      });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ── 저장 ────────────────────────────────────────────

/** repo 키를 검증해 대상 폴더를 반환. 알 수 없는 키면 기본 저장소로 폴백. */
function resolveFolder_(repoKey) {
  const repo = REPOS[repoKey] || REPOS[DEFAULT_REPO];
  return DriveApp.getFolderById(repo.id);
}

/** base64 오디오를 폴더에 저장하고 File을 반환. */
function saveAudioToFolder_(folder, base64Data, mimeType, nameBase) {
  const ext = extensionForMime(mimeType);
  const bytes = Utilities.base64Decode(base64Data);
  const containerType = String(mimeType || '').split(';')[0] || 'application/octet-stream';
  const blob = Utilities.newBlob(bytes, containerType, nameBase + ext);
  return folder.createFile(blob);
}

/** 위키 스키마에 맞춘 .md 파일을 만든다. */
function writeMarkdown_(folder, nameBase, whenDate, parsed) {
  const updated = Utilities.formatDate(whenDate, 'Asia/Seoul', 'yyyy-MM-dd');
  const md =
    '---\n' +
    'title: ' + parsed.title + '\n' +
    'type: source\n' +
    'tags: [voice]\n' +
    'sources: []\n' +
    'updated: ' + updated + '\n' +
    '---\n\n' +
    parsed.summary + '\n\n' +
    parsed.body + '\n';
  return folder.createFile(nameBase + '.md', md, 'text/markdown');
}

// ── Gemini 전사 ─────────────────────────────────────

/**
 * 오디오를 Gemini로 전사·정리해 {title, summary, body}를 반환.
 * @param {string} base64 - 오디오 base64
 * @param {string} mimeType - 예: 'audio/webm;codecs=opus'
 */
function transcribe_(base64, mimeType) {
  const container = String(mimeType || '').split(';')[0] || 'audio/ogg';

  const prompt =
    '다음은 사용자 본인이 남긴 개인 음성 메모입니다. 이 오디오를 한국어로 전사하고 정리하세요.\n' +
    '- 필러(음..., 어..., 반복)와 군더더기는 제거하되, 사실·의도를 바꾸지 마세요.\n' +
    '- 1인칭 메모체로 자연스럽게 다듬으세요.\n' +
    '- 아래 JSON 형식으로만 응답하세요. 다른 텍스트 금지.\n' +
    '{"title": "메모 내용을 대표하는 짧은 제목 한 줄", ' +
    '"summary": "핵심을 1~2문장으로 요약", ' +
    '"body": "정리한 메모 본문(마크다운 허용)"}';

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: container, data: base64 } }
      ]
    }],
    generationConfig: { responseMimeType: 'application/json' }
  };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + getGeminiKey_();
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) throw new Error('Gemini ' + code + ': ' + text.slice(0, 500));

  const data = JSON.parse(text);
  const cand = data.candidates && data.candidates[0];
  const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
  if (!part || !part.text) {
    throw new Error('Gemini 빈 응답: ' + text.slice(0, 500));
  }

  const parsed = JSON.parse(part.text);
  return {
    title: (parsed.title || '음성 메모').trim(),
    summary: (parsed.summary || '').trim(),
    body: (parsed.body || '').trim()
  };
}

// ── 유틸 ────────────────────────────────────────────

/** 녹음 시각 기반 파일명 베이스 (YYYY-MM-DD_HHmm), Asia/Seoul 기준 */
function timestampName(clientTimestamp) {
  let d = clientTimestamp ? new Date(clientTimestamp) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd_HHmm');
}

/** MIME 타입 → 파일 확장자 */
function extensionForMime(mimeType) {
  const t = String(mimeType || '').toLowerCase();
  if (t.indexOf('ogg') !== -1) return '.ogg';
  if (t.indexOf('webm') !== -1) return '.webm';
  if (t.indexOf('mp4') !== -1 || t.indexOf('m4a') !== -1) return '.m4a';
  if (t.indexOf('wav') !== -1) return '.wav';
  return '.bin';
}

/** 파일명 확장자 → MIME (blob 타입이 비어있을 때 폴백) */
function mimeFromName_(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.ogg')) return 'audio/ogg';
  if (n.endsWith('.webm')) return 'audio/webm';
  if (n.endsWith('.m4a') || n.endsWith('.mp4')) return 'audio/mp4';
  if (n.endsWith('.wav')) return 'audio/wav';
  if (n.endsWith('.mp3')) return 'audio/mp3';
  return 'audio/ogg';
}

/** JSON 응답 헬퍼 */
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
