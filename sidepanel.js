// DR전표 자동입력 - 사이드 패널
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REASONS = ['계절학기사용료', '공간사용료', '교육부지원금_국가장학금', '교육부지원금_기타지원금', '기술료', '기타', '기타국고지원금', '냉난방비', '보건비', '상담료', '수강료', '수강료/계절제수업', '수도료', '수험료', '스포츠센터사용료', '실습비', '어학실습', '연구관련', '외부개방사용료', '용역료', '임대료', '전기료', '전기수도료', '전산시험', '전화료', '지자체지원', '품성교육', '행사관련', '회비'];
const EVIDENCE = ['계산서발급(A1)', '세금계산서발급(AA)', '세금무관(내부부서용)'];

// 엑셀 머리글 → 내부 키 (괄호 안 설명, 공백, * 는 무시)
const COLS = {
  '문서번호': 'docNo', '부서코드': 'dept', '발행구분': 'issueType', '증빙구분': 'evidence', '청구/영수': 'claimType', '증빙일': 'date',
  '총금액': 'total', '적요': 'summary', '사업자등록번호': 'bizNo', '담당자': 'contact', '연락처': 'phone', 'E-MAIL': 'email',
  '청구계좌': 'account', '계정사유': 'reason', '계정과목': 'acct', '자금': 'fund', '금액': 'amount', '적요사항': 'lineText'
};
const HEADER_KEYS = ['dept', 'issueType', 'evidence', 'claimType', 'date', 'total', 'summary', 'bizNo', 'contact', 'phone', 'email', 'account'];
const normH = (s) => String(s ?? '').replace(/\(.*?\)/g, '').replace(/[\s*]/g, '').toUpperCase();

let wbSource = null;   // { aoa, headerRow, sheetName }
let docs = [];
let results = {};      // docNo -> { status, msg, gwDocId, log }
let storeKey = '';
// 진행상태는 '전표 내용(문서번호·사업자번호·증빙일·총금액·적요·행)' 기준으로 기억한다.
// 엑셀을 고쳐 저장하거나 파일 이름이 바뀌어도, 이미 완료된 건은 다시 만들지 않기 위함.
const STORE = 'dr_done_v2';
const fp = (d) => [d.docNo, d.bizNo, d.date, d.total, d.summary, d.lines.map((l) => l.reason + ':' + l.amount).join(',')].join('|');
let running = false;
let stopReq = false;
// 결재문서작성 후 열리는 그룹웨어 창(outProcess.do) 추적
const gwSeen = new Map(); // tabId -> { tabId, docId, loaded, t }
let gwWatch = false;
let gwAutoClose = false; // 임시전표 모드에서 결재문서 창 즉시 닫기
let gwRound = 0; // 결재문서작성 대기중인 문서번호 (그룹웨어 문서ID 연결용)

function log(s) {
  const n = new Date();
  const t = n.toTimeString().slice(0, 8) + '.' + Math.floor(n.getMilliseconds() / 100); // 0.1초 단위
  $('log').textContent += `[${t}] ${s}\n`;
  $('log').scrollTop = $('log').scrollHeight;
}
// 소요시간 표시: 1234 → '1.2s', [['부서', 2100], ...] → '부서 2.1s · ...'
const sec = (ms) => (ms / 1000).toFixed(1) + 's';
const fmtSteps = (arr) => (arr || []).map(([n, ms]) => n + ' ' + sec(ms)).join(' · ');
function banner(s) { const b = $('banner'); b.textContent = s || ''; b.className = s ? 'show' : ''; }

// ---------- 값 정리 ----------
const pad = (n) => String(n).padStart(2, '0');
function toDate(v) {
  if (v === '' || v == null) return '';
  if (v instanceof Date) return `${v.getFullYear()}.${pad(v.getMonth() + 1)}.${pad(v.getDate())}`;
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}.${pad(d.m)}.${pad(d.d)}` : String(v); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/);
  if (m) return `${m[1]}.${pad(m[2])}.${pad(m[3])}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  return s;
}
const toAmount = (v) => (v === '' || v == null ? '' : String(typeof v === 'number' ? Math.round(v) : String(v).replace(/[^\d-]/g, '')));
const toDigits = (v) => String(v ?? '').replace(/\D/g, '');
const toText = (v) => (v instanceof Date ? toDate(v) : String(v ?? '').trim());

// ---------- 엑셀 읽기 ----------
async function loadFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: true });
  const sheetName = wb.SheetNames.includes('입력') ? '입력' : wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
  const headerRow = aoa.findIndex((r) => r.some((c) => normH(c) === '문서번호'));
  if (headerRow < 0) throw new Error(`[${sheetName}] 시트에서 '문서번호' 머리글을 찾지 못했습니다.`);
  const colIdx = {};
  aoa[headerRow].forEach((h, i) => {
    const k = Object.keys(COLS).find((name) => normH(name) === normH(h));
    if (k && colIdx[COLS[k]] === undefined) colIdx[COLS[k]] = i;
  });
  const missing = ['docNo', 'evidence', 'date', 'total', 'summary', 'bizNo', 'reason'].filter((k) => colIdx[k] === undefined);
  if (missing.length) throw new Error('필수 머리글 누락: ' + missing.map((k) => Object.keys(COLS).find((n) => COLS[n] === k)).join(', '));

  const map = new Map();
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r];
    const get = (k) => (colIdx[k] === undefined ? '' : row[colIdx[k]]);
    const docNo = toText(get('docNo'));
    if (!docNo) continue;
    if (docNo.startsWith('예시')) continue;
    const header = {
      dept: toText(get('dept')).replace(/\s/g, ''), // 비우면 화면 기본 부서 사용
      issueType: toText(get('issueType')) || '정발행',
      evidence: toText(get('evidence')),
      claimType: toText(get('claimType')) || '청구',
      date: toDate(get('date')),
      total: toAmount(get('total')),
      summary: toText(get('summary')),
      bizNo: toDigits(get('bizNo')),
      contact: toText(get('contact')),
      phone: toText(get('phone')),
      email: toText(get('email')),
      account: toDigits(get('account'))
    };
    const line = {
      reason: toText(get('reason')),
      acct: toText(get('acct')),
      fund: toText(get('fund')),
      amount: toAmount(get('amount')) || header.total, // 금액을 비우면 총금액
      lineText: toText(get('lineText')),
      excelRow: r
    };
    if (!map.has(docNo)) map.set(docNo, { docNo, ...header, lines: [], rows: [], errors: [], warnings: [] });
    const d = map.get(docNo);
    d.rows.push(r);
    d.lines.push(line);
  }
  docs = [...map.values()];
  // 규칙: 계산서 1건 = 엑셀 1줄 = 계정 1개. 문서번호가 중복되면 입력오류
  docs.forEach((d) => {
    if (d.lines.length > 1) d.errors.push(`문서번호 '${d.docNo}'가 엑셀 ${d.rows.map((r) => r + 1).join(', ')}행에 중복됨 (계산서 1건에 계정은 1개만, 문서번호는 줄마다 다르게)`);
  });
  docs.forEach(validate);
  wbSource = { aoa, headerRow, sheetName };
  storeKey = STORE;
  const all = (await chrome.storage.local.get(STORE))[STORE] || {};
  results = {};
  docs.forEach((d) => { if (all[fp(d)]) results[d.docNo] = all[fp(d)]; });
  return { sheetName, count: docs.length };
}

function validate(d) {
  const e = d.errors;
  if (d.dept && !/^\d{4}$/.test(d.dept)) e.push(`부서코드 '${d.dept}' (숫자 4자리 아님)`);
  if (!d.evidence) e.push('증빙구분 없음');
  else if (!EVIDENCE.some((x) => x.replace(/\s/g, '').includes(d.evidence.replace(/\s/g, '')))) e.push(`증빙구분 '${d.evidence}' 확인`);
  if (!['정발행', '역발행'].some((x) => d.issueType.includes(x))) e.push(`발행구분 '${d.issueType}' 확인`);
  if (d.issueType.includes('역발행')) d.warnings.push('역발행은 아직 검증되지 않은 기능');
  if (!['청구', '영수'].includes(d.claimType)) e.push(`청구/영수 '${d.claimType}' 확인`);
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(d.date)) e.push(`증빙일 '${d.date}' 형식 확인 (YYYY.MM.DD)`);
  if (!d.total) e.push('총금액 없음');
  if (!d.summary) e.push('적요 없음');
  if (d.bizNo.length !== 10) e.push(`사업자등록번호 '${d.bizNo}' (10자리 아님)`);
  if (d.lines.length > 1) return; // 중복 문서번호는 이미 오류 처리
  const l = d.lines[0];
  if (!l.reason) e.push('계정사유 없음');
  else if (!REASONS.includes(l.reason)) e.push(`계정사유 '${l.reason}'가 목록에 없음`);
  if (!l.amount) e.push('금액 없음');
  if (d.total && l.amount && Number(l.amount) !== Number(d.total)) d.warnings.push(`금액 ${Number(l.amount).toLocaleString()} ≠ 총금액 ${Number(d.total).toLocaleString()}`);
}

// ---------- 화면 ----------
function render(currentNo) {
  const tb = $('tbody');
  tb.innerHTML = '';
  for (const d of docs) {
    const r = results[d.docNo] || {};
    const status = d.errors.length && !r.status ? '입력오류' : r.status || '대기';
    const msg = r.msg || [...d.errors, ...d.warnings].join(' / ');
    const tr = document.createElement('tr');
    if (d.docNo === currentNo) tr.className = 'current';
    tr.innerHTML = `<td>${esc(d.docNo)}${d.dept ? '<br><span class="muted">부서 ' + esc(d.dept) + '</span>' : ''}</td><td>${esc(d.bizNo)}</td><td class="num">${Number(d.total || 0).toLocaleString()}</td>` +
      `<td class="st st-${esc(status)}">${esc(status)}</td><td class="${d.errors.length ? 'err' : d.warnings.length ? 'warn' : ''}">${esc(msg)}${r.gwDocId ? ' [그룹웨어 ' + esc(r.gwDocId) + ']' : ''}</td>`;
    tb.appendChild(tr);
  }
  const cnt = (s) => docs.filter((d) => (results[d.docNo] || {}).status === s).length;
  const bad = docs.filter((d) => d.errors.length).length;
  $('summary').textContent = `전체 ${docs.length}건 · 완료 ${cnt('완료')} · 확인필요 ${cnt('확인필요')} · 오류 ${cnt('오류')} · 엑셀 입력오류 ${bad}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function saveResults(clearCurrent = false) {
  if (!storeKey) return;
  const all = (await chrome.storage.local.get(STORE))[STORE] || {};
  docs.forEach((d) => {
    if (clearCurrent) delete all[fp(d)];
    else if (results[d.docNo]) all[fp(d)] = results[d.docNo];
  });
  await chrome.storage.local.set({ [STORE]: all });
}
async function setRes(d, status, msg, extra = {}) {
  results[d.docNo] = { ...(results[d.docNo] || {}), status, msg: msg || '', ...extra, at: new Date().toISOString() };
  await saveResults();
  render(d.docNo);
}

// ---------- SAP 화면과 통신 ----------
async function getTab() {
  const tabs = await chrome.tabs.query({ url: ['https://yep.yonsei.ac.kr/*'] });
  if (!tabs.length) throw new Error('연세대 행정정보시스템(yep.yonsei.ac.kr) 탭을 찾지 못했습니다.');
  return tabs.find((t) => t.active) || tabs[0];
}
async function send(tab, msg) {
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { ...msg, __dr: true });
    return r || { ok: false, error: '응답 없음', noResponse: true };
  } catch (e) {
    return { ok: false, error: e.message, noResponse: true };
  }
}
async function waitClean(tab, maxMs) {
  const s = Date.now();
  let lastDlg = '';
  while (Date.now() - s < maxMs) {
    if (stopReq) return 'stopped';
    const st = await send(tab, { type: 'status' });
    if (st.ok && st.clean) return 'clean';
    if (st.ok && st.dialog && st.dialog !== lastDlg) { lastDlg = st.dialog; log('화면 메시지: ' + st.dialog); }
    await sleep(1500);
  }
  return 'timeout';
}

// ---------- 그룹웨어 창 추적 ----------
const GW_RE = /gwgw\.yonsei\.ac\.kr\/.*outProcess\.do/;
function noteGw(tabId, url, loaded) {
  if (!gwWatch || tabId == null || !GW_RE.test(url || '')) return;
  let docId = '';
  try { docId = new URL(url).searchParams.get('doc_id') || ''; } catch (e) {}
  const cur = gwSeen.get(tabId) || { tabId, docId, loaded: false, closed: false, t: Date.now() };
  if (docId) cur.docId = docId;
  if (loaded) cur.loaded = true;
  gwSeen.set(tabId, cur);
  // 임시전표 모드: 결재문서 창이 감지되는 즉시 닫음 (임시전표는 '예'를 누를 때 이미 생성됨)
  if (gwAutoClose && !cur.closed) {
    cur.closed = true;
    chrome.tabs.remove(tabId).then(
      () => log('결재문서 창 닫음 (문서 ' + (cur.docId || '?') + ')'),
      (e) => { cur.closed = false; log('결재문서 창 닫기 실패: ' + e.message); }
    );
  }
}
chrome.tabs.onCreated.addListener((t) => noteGw(t.id, t.pendingUrl || t.url, false));
chrome.tabs.onUpdated.addListener((id, ch, t) => noteGw(id, t.url || ch.url, ch.status === 'complete'));
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'gwOpened' && sender.tab) noteGw(sender.tab.id, sender.url || sender.tab.url, true);
});
// 결재문서 창이 뜰 때까지 대기 (최대 maxMs)
async function waitGw(maxMs) {
  const s = Date.now();
  while (Date.now() - s < maxMs) {
    const v = [...gwSeen.values()];
    if (v.length) return v[0];
    await sleep(150);
  }
  return null;
}

// 포털 왼쪽 메뉴를 다시 눌러 빈 입력화면 만들기
async function resetForm(tab) {
  const r = await send(tab, { type: 'resetForm' });
  if (!r.ok) { log('화면 초기화 실패: ' + r.error); return 'fail'; }
  await sleep(3000);
  return waitClean(tab, 30000);
}

const ERR_RE = /오류|실패|필수|없습니다|불가|않습니다|확인하십시오|입력하세요|선택해주세요/;
function findVoucherNo(text, d) {
  const nums = (text.match(/\d{10}/g) || []).filter((n) => n !== d.bizNo && n !== d.account);
  return nums[0] || '';
}

// 임시전표 만들기: 행 체크 → 결재문서작성 → 그룹웨어 창 닫기 → 안내메시지 [확인]
async function makeTemp(tab, d) {
  gwSeen.clear();
  gwWatch = true;
  gwAutoClose = true;
  const round = ++gwRound;
  const tStart = Date.now();
  try {
    const sub = await send(tab, { type: 'submit', lines: d.lines.length });
    if (!sub.ok) return { status: '오류', msg: '결재문서작성 단계: ' + sub.error + (sub.step ? ' (' + sub.step + ')' : '') };
    log('[' + d.docNo + '] 결재문서작성 클릭');

    // 안내메시지는 뜨는 즉시 [확인]. 결재문서 창은 감지되는 즉시 자동으로 닫히므로(noteGw) 먼저 기다리지 않는다.
    // 메시지가 아직 없으면 메시지나 결재문서 창 중 먼저 오는 것을 기다린다 (최대 30초).
    const texts = [];
    const t0 = Date.now();
    let gwAt = 0;
    let firstSeenAt = 0, firstClickedAt = 0, lastDoneAt = 0;
    for (;;) {
      // 메시지를 확인한 뒤 뒤이은 메시지가 있는지는 0.5초만 확인 (확인 후 화면 정리를 이미 기다렸으므로)
      const c = await send(tab, { type: 'confirmMessage', maxMs: texts.length ? 500 : 1000 });
      if (c.ok && c.dialog) {
        if (!firstSeenAt) { firstSeenAt = c.seenAt || 0; firstClickedAt = c.clickedAt || 0; }
        if (c.doneAt) lastDoneAt = c.doneAt;
        texts.push(c.dialog);
        log('[' + d.docNo + '] 메시지: ' + c.dialog);
        if (!c.clicked || texts.length >= 3) break;
        continue; // 이어지는 메시지가 있으면 바로 처리
      }
      if (!c.ok) await sleep(300);
      if (gwSeen.size && !gwAt) gwAt = Date.now();
      if (texts.length) break;                       // 메시지 확인 끝 (1초 동안 다음 메시지 없음)
      if (gwAt && Date.now() - gwAt > 10000) break;  // 창은 떴는데 메시지가 10초간 없음
      if (Date.now() - t0 > 30000) break;            // 아무것도 없음
    }
    const all = texts.join(' / ');
    const vno = findVoucherNo(all, d);

    // 결재문서 창이 아직 안 떴으면 조금 더 기다림 (확인 클릭 뒤에 열리는 경우 대비, 열리면 바로 닫힘)
    let gw = [...gwSeen.values()][0] || null;
    if (!gw && !(ERR_RE.test(all) && !vno)) gw = await waitGw(vno ? 3000 : 8000);
    if (!gw) log('[' + d.docNo + '] 결재문서 창이 열리지 않음');

    // 생성 단계별 소요시간
    const st = sub.t || {};
    const msgAt = st.msgAt || firstSeenAt;
    const base = st.yesAt || st.clickAt;
    const steps = [];
    if (st.selMs != null) steps.push(['행선택', st.selMs]);
    if (st.askAt && st.clickAt) steps.push(['작성클릭→확인창', st.askAt - st.clickAt]);
    if (st.yesAt && st.askAt) steps.push(['확인창→예', st.yesAt - st.askAt]);
    if (msgAt && base) steps.push([(st.yesAt ? '예' : '작성클릭') + '→안내메시지', msgAt - base]);
    if (firstClickedAt && msgAt) steps.push(['메시지→확인클릭', Math.max(0, firstClickedAt - msgAt)]);
    if (lastDoneAt && firstClickedAt) steps.push(['확인후정리', lastDoneAt - firstClickedAt]);
    if (gw && gw.t && st.clickAt) steps.push(['결재문서창(작성클릭 후)', gw.t - st.clickAt]);
    steps.push(['생성합계', Date.now() - tStart]);
    const genSteps = fmtSteps(steps);
    log('[' + d.docNo + '] 생성 단계시간: ' + genSteps);

    const extra = { voucherNo: vno, gwDocId: gw ? gw.docId : '', sapMsg: all, genSteps };
    if (!vno && ERR_RE.test(all)) return { status: '오류', msg: all, extra };
    if (!gw && !texts.length) return { status: '오류', msg: '결재문서작성 후 그룹웨어 창도 안내메시지도 없음 (팝업 차단 여부 확인)', extra };
    if (gw || vno) return { status: '완료', msg: '임시전표 생성' + (vno ? ' ' + vno : '') + (all ? ' | ' + all : ''), extra };
    return { status: '확인필요', msg: '생성 여부를 확인하지 못함: ' + all, extra };
  } finally {
    // 늦게 뜨는 창도 닫히도록 잠시 더 감시
    setTimeout(() => { if (round === gwRound) { gwWatch = false; gwAutoClose = false; } }, 3000);
  }
}

// ---------- 실행 ----------
async function run() {
  running = true; stopReq = false; updateButtons();
  const mode = $('mode').value;
  const limit = Math.max(1, Number($('limit').value) || 1);
  const stopWith = (msg) => { if (msg) banner(msg); running = false; updateButtons(); render(); };
  let tab;
  try { tab = await getTab(); } catch (e) { return stopWith(e.message); }
  let ping = await send(tab, { type: 'status' });
  if (!ping.ok) {
    log('DR 입력화면이 아니어서 메뉴를 엽니다');
    await resetForm(tab);
    ping = await send(tab, { type: 'status' });
  }
  if (!ping.ok) {
    return stopWith('DR 입력 화면을 찾지 못했습니다. 포털에서 [세금계산서/계산서/기타[DR]] 화면을 연 뒤, 확장 프로그램 설치/업데이트 후 처음이라면 포털 탭을 새로고침(F5)해 주세요.');
  }
  banner('');
  log('시작: ' + (mode === 'temp' ? '임시전표 자동생성' : '입력만') + ', 최대 ' + limit + '건');
  let done = 0;
  for (const d of docs) {
    if (stopReq || done >= limit) break;
    const prev = (results[d.docNo] || {}).status;
    if (prev === '완료' || prev === '확인필요') continue;
    if (d.errors.length) { await setRes(d, '건너뜀', '엑셀 입력오류: ' + d.errors.join(' / ')); continue; }
    done++;
    const tDoc = Date.now();

    // 1. 빈 화면 확보 (아니면 메뉴를 다시 열어 초기화)
    let w = await waitClean(tab, 4000);
    if (w !== 'clean' && w !== 'stopped') { log('화면에 이전 값이 남아 있어 메뉴를 다시 엽니다'); w = await resetForm(tab); }
    if (w !== 'clean') {
      await setRes(d, w === 'stopped' ? '대기' : '오류', w === 'stopped' ? '중지됨' : '빈 입력화면을 만들지 못함');
      if (w !== 'stopped') banner('빈 입력화면을 만들지 못해 멈췄습니다. 메뉴를 다시 연 뒤 [시작]을 누르세요.');
      break;
    }

    // 2. 입력
    const tFill = Date.now();
    await setRes(d, '입력중', '', { prepMs: tFill - tDoc, fillMs: null, genMs: null, totalMs: null, fillSteps: '', genSteps: '' });
    log('[' + d.docNo + '] 입력 시작 (' + d.lines.length + '행)' + (tFill - tDoc >= 1000 ? ' / 화면 준비 ' + sec(tFill - tDoc) : ''));
    const r = await send(tab, { type: 'fillDoc', doc: d });
    const fillMs = Date.now() - tFill;
    const fillSteps = fmtSteps(r.timing);
    if (r.timing) log('[' + d.docNo + '] 입력 단계시간: ' + (fillSteps || '-') + (r.ok ? '' : ' → 멈춘 단계: ' + (r.step || '?')) + ' (입력 합계 ' + sec(fillMs) + ')');
    const times = { fillMs, fillSteps };
    if (!r.ok) {
      await setRes(d, '오류', r.error + (r.step ? ' (단계: ' + r.step + ')' : ''), { ...times, totalMs: Date.now() - tDoc });
      log('[' + d.docNo + '] 오류: ' + r.error);
      banner('입력 중 오류로 멈췄습니다. 엑셀을 고친 뒤 다시 불러와 [시작]을 누르면 이 건부터 다시 진행합니다 (화면은 자동 초기화).');
      break;
    }
    if (r.log) log('[' + d.docNo + '] ' + r.log.join(' | '));

    // 3-A. 입력만: 사용자가 직접 처리할 때까지 대기
    if (mode === 'semi') {
      gwSeen.clear(); gwWatch = true; gwAutoClose = false; gwRound++;
      await setRes(d, '검토대기', '화면을 확인한 뒤 직접 처리하세요. 화면이 비워지면(또는 메뉴를 다시 열면) 다음 건으로 넘어갑니다.', { log: r.log, ...times });
      const tManual = Date.now();
      const w2 = await waitClean(tab, 60 * 60 * 1000);
      gwWatch = false;
      const manual = { genSteps: '직접처리(검토~화면 비움) ' + sec(Date.now() - tManual), totalMs: Date.now() - tDoc };
      if (w2 !== 'clean') { await setRes(d, '오류', w2 === 'stopped' ? '중지됨 (처리 여부 직접 확인)' : '시간 초과', manual); break; }
      const gw = [...gwSeen.values()][0];
      if (gw) await setRes(d, '완료', '결재문서작성 확인됨', { gwDocId: gw.docId, ...manual });
      else await setRes(d, '확인필요', '화면은 비워졌지만 결재문서작성을 확인하지 못함. 실제 생성 여부를 확인하세요.', manual);
      log('[' + d.docNo + '] ' + results[d.docNo].status + ' / 준비 ' + sec(tFill - tDoc) + ' · 입력 ' + sec(fillMs) + ' · ' + manual.genSteps + ' · 총 ' + sec(manual.totalMs));
      continue;
    }

    // 3-B. 임시전표 자동생성
    await setRes(d, '생성중', '');
    const tGen = Date.now();
    const t = await makeTemp(tab, d);
    const genMs = Date.now() - tGen;
    const totalMs = Date.now() - tDoc;
    await setRes(d, t.status, t.msg, { log: r.log, ...(t.extra || {}), ...times, genMs, totalMs });
    log('[' + d.docNo + '] ' + t.status + ' ' + t.msg);
    log('[' + d.docNo + '] 소요: 준비 ' + sec(tFill - tDoc) + ' · 입력 ' + sec(fillMs) + ' · 생성 ' + sec(genMs) + ' · 총 ' + sec(totalMs));
    if (t.status !== '완료') {
      banner(t.status === '오류'
        ? '임시전표 생성 단계에서 멈췄습니다. [전표 통합 관리]에서 이 건이 생성됐는지 확인하세요. 생성됐다면 다시 시작하기 전에 엑셀에서 이 건을 빼주세요.'
        : '생성 여부가 불확실해 멈췄습니다. [전표 통합 관리]에서 확인해 주세요. 이 건은 다음 실행 때 건너뜁니다.');
      break;
    }
  }
  log('종료');
  stopWith();
}

// ---------- 결과 저장 ----------
function exportResults() {
  const { aoa, headerRow } = wbSource;
  const out = aoa.map((r) => [...r]);
  const width = Math.max(...out.map((r) => r.length));
  out.forEach((r) => { while (r.length < width) r.push(''); });
  out[headerRow].push('처리결과', '임시전표번호', '처리메시지', '그룹웨어문서ID', '처리시각',
    '준비(초)', '입력(초)', '생성(초)', '총소요(초)', '입력 단계별', '생성 단계별');
  const s1 = (ms) => (typeof ms === 'number' ? Math.round(ms / 100) / 10 : '');
  const byRow = {};
  docs.forEach((d) => d.rows.forEach((r) => { byRow[r] = d; }));
  for (let r = headerRow + 1; r < out.length; r++) {
    const d = byRow[r];
    const res = d ? results[d.docNo] || {} : {};
    out[r].push(res.status || '', res.voucherNo || '', res.msg || '', res.gwDocId || '', res.at ? new Date(res.at).toLocaleString('ko-KR') : '',
      s1(res.prepMs), s1(res.fillMs), s1(res.genMs), s1(res.totalMs), res.fillSteps || '', res.genSteps || '');
  }
  const ws = XLSX.utils.aoa_to_sheet(out);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '처리결과');
  const n = new Date();
  XLSX.writeFile(wb, `DR전표_처리결과_${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}_${pad(n.getHours())}${pad(n.getMinutes())}.xlsx`);
}

// ---------- 버튼 ----------
function updateButtons() {
  const loaded = docs.length > 0;
  $('btnStart').disabled = !loaded || running;
  $('btnStop').disabled = !running;
  $('btnExport').disabled = !loaded;
  $('btnReset').disabled = !loaded || running;
  $('file').disabled = running;
}
$('file').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const info = await loadFile(f);
    const bad = docs.filter((d) => d.errors.length).length;
    const warn = docs.filter((d) => d.warnings.length).length;
    $('fileInfo').textContent = `${f.name} · [${info.sheetName}] 시트 · 전표 ${info.count}건`;
    if (!docs.length) {
      $('validation').innerHTML = `<div class="err">처리할 전표가 0건입니다. [입력] 시트의 문서번호를 확인하세요. 문서번호가 비어 있거나 '예시'로 시작하는 줄은 읽지 않습니다.</div>`;
    } else {
      $('validation').innerHTML = bad ? `<div class="err">입력오류 ${bad}건: 이 건들은 건너뜁니다. 엑셀을 고친 뒤 다시 불러오세요.</div>` : '<div class="ok">입력값 검사 통과</div>';
    }
    if (warn) $('validation').innerHTML += `<div class="warn">주의 ${warn}건 (표의 메시지 확인)</div>`;
    const doneCnt = Object.values(results).filter((r) => r.status === '완료' || r.status === '확인필요').length;
    if (doneCnt) log(`이전 진행상태 불러옴: ${doneCnt}건 처리됨 (이 건들은 건너뜁니다)`);
    render();
  } catch (e) {
    docs = []; render();
    $('fileInfo').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
  updateButtons();
});
$('btnStart').addEventListener('click', () => run());
$('btnManual').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('manual.html') }));
$('btnStop').addEventListener('click', () => { stopReq = true; log('중지 요청: 현재 단계가 끝나면 멈춥니다'); });
$('btnExport').addEventListener('click', exportResults);
// 로그를 txt 파일로 저장 (패널을 닫으면 로그가 사라지므로)
$('btnLogSave').addEventListener('click', () => {
  const text = $('log').textContent;
  if (!text) return;
  const n = new Date();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + text.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }));
  a.download = `DR전표_로그_${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}_${pad(n.getHours())}${pad(n.getMinutes())}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('btnReset').addEventListener('click', async () => {
  if (!confirm('이 파일의 진행상태(완료 표시)를 모두 지울까요? 이미 결재문서를 만든 건이 다시 처리될 수 있습니다.')) return;
  results = {}; await saveResults(true); render(); log('진행상태 초기화 (이 파일의 전표만)');
});
render();
