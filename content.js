// DR전표 자동입력 - SAP Web Dynpro(ZWFI0001) 화면 조작 스크립트
// 필드 ID(WD42 등)는 화면이 갱신될 때마다 바뀌므로, 항상 "항목 이름표"와 "표 열 이름"으로 칸을 찾는다.
(() => {
  if (window.__DR) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s ?? '').replace(/[\s*:：]/g, '');
  const digits = (s) => String(s ?? '').replace(/\D/g, '');
  const HIDDEN_TXT = /행을 선택하려면 스페이스바를 누르십시오\.?/g;
  let currentStep = '';
  let busy = false;

  const viewOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || window;
  function fire(el, types = ['mousedown', 'mouseup', 'click']) {
    const V = viewOf(el);
    types.forEach((t) => el.dispatchEvent(new V.MouseEvent(t, { bubbles: true, cancelable: true, view: V })));
  }
  function dbl(el) {
    const V = viewOf(el);
    el.dispatchEvent(new V.MouseEvent('dblclick', { bubbles: true, cancelable: true, view: V, detail: 2 }));
  }
  function key(el, k, code) {
    const V = viewOf(el);
    ['keydown', 'keypress', 'keyup'].forEach((t) =>
      el.dispatchEvent(new V.KeyboardEvent(t, { bubbles: true, cancelable: true, key: k, code: k, keyCode: code, which: code }))
    );
  }
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  // ---------- 화면 상태 ----------
  function findButton(text, root = document) {
    const t = norm(text);
    // 버튼 글자 뒤에 숨은 안내문구가 붙는 경우가 있음 (예: "예\n포지티브 액션") → 첫 줄만 비교
    const label = (b) => {
      const first = String(b.innerText || '').split('\n')[0];
      return norm(first || b.title || b.getAttribute('aria-label'));
    };
    return [...root.querySelectorAll('[role=button],[ct="B"]')].find((b) => label(b) === t);
  }
  const isMainForm = () => !!findButton('결재문서작성');

  function isBusy() {
    return [...document.querySelectorAll('[id^="ur-loading"]')].some((l) => {
      const cs = getComputedStyle(l);
      return visible(l) && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    });
  }
  // 서버 왕복(화면 갱신)이 끝날 때까지 대기: DOM 변경이 quiet ms 동안 없으면 완료로 본다
  async function waitIdle(quiet = 500, max = 20000) {
    const start = Date.now();
    let last = Date.now();
    const mo = new MutationObserver(() => { last = Date.now(); });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      await sleep(150);
      while (Date.now() - start < max) {
        if (Date.now() - last >= quiet && !isBusy()) return true;
        await sleep(100);
      }
      return false;
    } finally { mo.disconnect(); }
  }

  // ---------- 팝업(검색창/메시지창) ----------
  // 팝업은 이 프레임의 자식 iframe(URLSPW-*) 안에 그려진다. 닫히면 크기가 0이 된다.
  function popupDocs() {
    const out = [];
    for (let i = 0; i < window.frames.length; i++) {
      try { const d = window.frames[i].document; if (d && d.querySelector) out.push(d); } catch (e) { /* 다른 출처 */ }
    }
    return out;
  }
  function openDialog() {
    for (const doc of popupDocs()) {
      for (const dlg of doc.querySelectorAll('[role=dialog],[role=alertdialog]')) {
        if (visible(dlg)) return { doc, dlg };
      }
    }
    return null;
  }
  async function waitDialog(max = 10000) {
    const s = Date.now();
    while (Date.now() - s < max) {
      if (openDialog()) { await sleep(500); return openDialog(); }
      await sleep(150);
    }
    return null;
  }
  async function waitDialogClosed(max = 8000) {
    const s = Date.now();
    while (Date.now() - s < max) { if (!openDialog()) return true; await sleep(150); }
    return false;
  }
  const dialogText = (d) => (d.dlg.innerText || '').replace(HIDDEN_TXT, '').replace(/\s+/g, ' ').trim();
  async function closeDialog(d, prefer = ['취소', '닫기', '확인']) {
    for (const t of prefer) {
      const b = findButton(t, d.dlg);
      if (b) { fire(b); await waitDialogClosed(5000); await waitIdle(); return t; }
    }
    const x = d.dlg.querySelector('[id$="-close"],[title*="닫기"],[aria-label*="닫기"]');
    if (x) { fire(x); await waitDialogClosed(5000); await waitIdle(); return 'x'; }
    return null;
  }
  // 단계 직후 메시지창이 떠 있으면 오류로 처리
  async function failIfDialog(stepName) {
    const d = openDialog();
    if (!d) return;
    const t = dialogText(d);
    await closeDialog(d, ['확인', '취소', '닫기']);
    throw new Error(`${stepName}: ${t.slice(0, 200)}`);
  }
  function pageMessages() {
    const set = new Set();
    document.querySelectorAll('[ct="MA"],[class*="MessageArea"],[class*="lsMessageBar"],[role=alert]').forEach((e) => {
      (e.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s.length > 4 && !/^모두/.test(s)).forEach((s) => set.add(s));
    });
    return [...set];
  }

  // ---------- 칸 찾기 ----------
  function fieldByLabel(text) {
    const t = norm(text);
    for (const l of document.querySelectorAll('label')) {
      if (norm(l.innerText) === t) {
        const id = l.getAttribute('for') || l.getAttribute('f');
        const el = id && document.getElementById(id);
        if (el) return el;
      }
    }
    for (const el of document.querySelectorAll('input,[role=textbox],[role=listbox],[role=combobox]')) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb && lb.split(' ').some((i) => norm(document.getElementById(i)?.innerText) === t)) return el;
    }
    return null;
  }
  const valOf = (el) => (el ? (el.tagName === 'INPUT' ? el.value : el.innerText || '').trim() : '');

  // 입력칸 옆의 돋보기(검색) 버튼
  function helpButtonFor(el) {
    let node = el;
    for (let up = 0; up < 6 && node; up++) {
      node = node.parentElement;
      if (!node) break;
      const b = [...node.querySelectorAll('[ct="B"],[role=button]')].find(
        (b) => !norm(b.innerText) && (el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      if (b) return b;
    }
    return null;
  }

  // 화면을 그릴 때 빈 칸은 <span role=textbox>로 그려졌다가 클릭하면 <input>으로 바뀐다
  async function activate(el) {
    if (!el) throw new Error('입력칸을 찾지 못함');
    const id = el.id;
    fire(el);
    if (el.focus) el.focus();
    if (el.tagName !== 'INPUT') { await sleep(300); el = document.getElementById(id) || el; if (el.focus) el.focus(); }
    return el;
  }
  async function setText(el, value, enter = true) {
    el = await activate(el);
    if (el.tagName !== 'INPUT') throw new Error(`입력할 수 없는 칸 (${currentStep})`);
    if (el.readOnly) throw new Error(`읽기전용 칸 (${currentStep})`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (enter) key(el, 'Enter', 13);
    else { el.dispatchEvent(new FocusEvent('blur')); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }
    await waitIdle();
  }

  async function setLabeled(label, value) {
    currentStep = label;
    const el = fieldByLabel(label);
    if (!el) throw new Error(`'${label}' 칸을 찾지 못함`);
    await setText(el, value);
    await failIfDialog(label);
    const now = fieldByLabel(label);
    if (now && now.getAttribute('aria-invalid') === 'true') {
      throw new Error(`${label}: 입력값 오류 ${pageMessages().join(' / ')}`);
    }
    return valOf(now);
  }

  async function setRadio(text) {
    currentStep = text;
    const t = norm(text);
    const r = [...document.querySelectorAll('[role=radio]')].find((r) => norm(r.innerText || r.getAttribute('aria-label')).includes(t));
    if (!r) throw new Error(`'${text}' 선택 버튼을 찾지 못함`);
    if (r.getAttribute('aria-checked') !== 'true') { fire(r); await waitIdle(); }
  }

  async function setCombo(label, value) {
    currentStep = label;
    let el = fieldByLabel(label);
    if (!el) throw new Error(`'${label}' 칸을 찾지 못함`);
    if (norm(valOf(el)).includes(norm(value))) return valOf(el);
    const findOpt = () => [...document.querySelectorAll('[role=option]')].find((o) => visible(o) && norm(o.innerText).includes(norm(value)));
    fire(el); await sleep(500);
    let opt = findOpt();
    if (!opt) { key(el, 'F4', 115); await sleep(500); opt = findOpt(); }
    if (!opt) throw new Error(`${label}: '${value}' 항목을 찾지 못함`);
    fire(opt);
    await waitIdle();
    el = fieldByLabel(label);
    if (!norm(valOf(el)).includes(norm(value))) throw new Error(`${label}: 선택 확인 실패 (현재값 ${valOf(el)})`);
    return valOf(el);
  }

  async function ensureSection(title, anchorLabel) {
    if (fieldByLabel(anchorLabel)) return;
    const b = [...document.querySelectorAll('[role=button]')].find((b) => norm(b.innerText) === norm(title));
    if (b) { fire(b); await waitIdle(); }
    if (!fieldByLabel(anchorLabel)) throw new Error(`'${title}' 영역을 펼치지 못함`);
  }

  // ---------- 전표 입력 표 ----------
  function getGrid() {
    return [...document.querySelectorAll('[role=grid]')].find((g) =>
      [...g.querySelectorAll('[role=columnheader]')].some((h) => norm(h.innerText) === '계정사유')
    );
  }
  const gridCols = (g) => [...g.querySelectorAll('[role=columnheader]')].map((h) => norm(h.innerText));
  const gridRows = (g) => [...g.querySelectorAll('[role=row]')].filter((r) => r.querySelector('[role=gridcell]'));
  function cellCtl(i, col) {
    const g = getGrid();
    if (!g) return null;
    const ci = gridCols(g).indexOf(norm(col));
    const row = gridRows(g)[i];
    if (ci < 0 || !row) return null;
    const cell = row.querySelectorAll('[role=gridcell]')[ci];
    return cell ? cell.querySelector('input,[role=textbox]') || cell : null;
  }
  const cellVal = (i, col) => valOf(cellCtl(i, col));

  async function ensureRow(i) {
    for (let k = 0; k < 20; k++) {
      const g = getGrid();
      if (!g) throw new Error('전표 입력 표를 찾지 못함');
      if (gridRows(g).length > i) return;
      const add = findButton('추가');
      if (!add) throw new Error("'추가' 버튼을 찾지 못함");
      fire(add);
      await waitIdle();
    }
    throw new Error(`${i + 1}행을 만들지 못함`);
  }

  // 검색창(F4)에서 조건에 맞는 행을 찾아 더블클릭으로 선택
  async function pickFromHelp(matcher, label, opts = {}) {
    let d = await waitDialog();
    if (!d) throw new Error(`${label}: 검색창이 열리지 않음`);
    // 검색창 표는 '선택(라디오) 열'과 '데이터 열'이 별도 표로 그려지므로, 셀을 tr 단위로 묶어서 읽는다
    const rowsOf = (dlg) => {
      const groups = new Map();
      dlg.querySelectorAll('[role=gridcell]').forEach((c) => {
        const tr = c.closest('tr') || c.parentElement;
        if (!groups.has(tr)) groups.set(tr, []);
        groups.get(tr).push(c);
      });
      return [...groups.entries()]
        .map(([r, cs]) => ({ r, cells: cs.map((c) => (c.innerText || '').replace(HIDDEN_TXT, '').trim()) }))
        .filter((x) => x.cells.some(Boolean));
    };
    const scb = (dlg, suf) => dlg.querySelector(`[ct="SCB"] [id$="-${suf}"]`);
    const sig = (dlg) => rowsOf(dlg).map((x) => x.cells.join('|')).join('/');
    const refresh = () => { d = openDialog() || d; };

    if (!rowsOf(d.dlg).length) {
      const t = dialogText(d);
      await closeDialog(d);
      throw new Error(`${label}: 검색 결과 없음 (${t.slice(0, 120)})`);
    }
    // 맨 위로
    for (let k = 0; k < 30; k++) {
      const p = scb(d.dlg, 'Prev');
      if (!p) break;
      const before = sig(d.dlg);
      for (let j = 0; j < 5; j++) { fire(p); await sleep(120); }
      await sleep(600); refresh();
      if (sig(d.dlg) === before) break;
    }
    const seen = [];
    for (let k = 0; k < 60; k++) {
      const rows = rowsOf(d.dlg);
      rows.forEach((x) => { const s = x.cells.filter(Boolean).join(' '); if (!seen.includes(s)) seen.push(s); });
      const hit = rows.find((x) => matcher(x.cells));
      if (hit) {
        if (opts.uniqueOnly && (rows.length !== 1 || scb(d.dlg, 'Nxt'))) break;
        await chooseRow(hit.r);
        return hit.cells.filter(Boolean);
      }
      const n = scb(d.dlg, 'Nxt');
      if (!n) break;
      const before = sig(d.dlg);
      for (let j = 0; j < 4; j++) { fire(n); await sleep(120); }
      await sleep(700); refresh();
      if (sig(d.dlg) === before) break;
    }
    await closeDialog(d, ['취소', '닫기', '확인']);
    throw new Error(`${label}: 검색 목록에서 찾지 못함 (목록 일부: ${seen.slice(0, 8).join(' / ')})`);
  }
  async function chooseRow(r) {
    const cells = [...r.querySelectorAll('[role=gridcell]')];
    const cell = cells.find((c) => (c.innerText || '').replace(HIDDEN_TXT, '').trim()) || cells[0];
    // 링크형 목록(예: 자금)은 한 번 클릭, 라디오형 목록(예: 계정사유/계정과목)은 더블클릭
    const link = cell.querySelector('a,[ct="LN"]');
    if (link) {
      fire(link);
      if (await waitDialogClosed(5000)) { await waitIdle(); return; }
    }
    const el = cell.querySelector('span,a,[ct]') || cell;
    fire(el); await sleep(250);
    dbl(el);
    if (await waitDialogClosed(5000)) { await waitIdle(); return; }
    const d = openDialog();
    if (d) {
      const b = findButton('확인', d.dlg) || findButton('선택', d.dlg);
      if (b) { fire(b); if (await waitDialogClosed(5000)) { await waitIdle(); return; } }
    }
    throw new Error('검색창에서 선택 확정 실패');
  }

  async function pickCell(i, col, matcher, label) {
    let el = await activate(cellCtl(i, col));
    key(el, 'F4', 115);
    await pickFromHelp(matcher, label);
    await waitIdle();
  }
  async function typeCell(i, col, value, enter) {
    currentStep = `${i + 1}행 ${col}`;
    const el = cellCtl(i, col);
    if (!el) throw new Error(`${currentStep} 칸을 찾지 못함`);
    await setText(el, value, enter);
    await failIfDialog(currentStep);
  }
  // 검색창에서 코드로 선택. 엑셀 값이 비어 있으면 후보가 1개일 때만 자동 선택
  async function pickCode(i, col, nameCol, v) {
    currentStep = `${i + 1}행 ${col}`;
    if (v && norm(cellVal(i, col)) === norm(v) && cellVal(i, nameCol)) return;
    if (!v && cellVal(i, col) && cellVal(i, nameCol)) return;
    let el = await activate(cellCtl(i, col));
    key(el, 'F4', 115);
    if (v) await pickFromHelp((cells) => cells.some((c) => norm(c) === norm(v)), currentStep);
    else await pickFromHelp(() => true, `${currentStep}(엑셀 미입력: 후보가 1개일 때만 자동 선택)`, { uniqueOnly: true });
    await failIfDialog(currentStep);
    if (!cellVal(i, nameCol)) throw new Error(`${currentStep}: ${nameCol}이 조회되지 않음`);
  }

  async function fillLine(i, ln) {
    await ensureRow(i);
    const rowName = `${i + 1}행`;

    currentStep = `${rowName} 계정사유`;
    if (norm(cellVal(i, '계정사유')) !== norm(ln.reason)) {
      await pickCell(i, '계정사유', (cells) => cells.some((c) => norm(c) === norm(ln.reason)), currentStep);
      await failIfDialog(currentStep);
    }
    if (norm(cellVal(i, '계정사유')) !== norm(ln.reason)) throw new Error(`${currentStep}: 선택 확인 실패`);

    // 계정과목/자금: 검색창에서 선택 (칸마다 Enter를 치면 행 전체 필수값 검사가 돌아 오류가 나므로)
    await pickCode(i, '계정과목', '계정과목명', ln.acct);
    await pickCode(i, '자금', '자금명', ln.fund);

    // 금액, 적요사항은 값만 넣고 마지막에 한 번 Enter
    await typeCell(i, '금액', ln.amount, false);
    const memo = ln.lineText || cellVal(i, '적요사항');
    if (!memo) throw new Error(`${rowName} 적요사항이 비어 있음`);
    await typeCell(i, '적요사항', memo, true);
    if (digits(cellVal(i, '금액')) !== digits(ln.amount)) throw new Error(`${rowName} 금액 확인 실패 (화면값 ${cellVal(i, '금액')})`);

    return {
      계정과목명: cellVal(i, '계정과목명'),
      자금명: cellVal(i, '자금명'),
      예산항목: cellVal(i, '예산항목'),
      예산항목명: cellVal(i, '예산항목명')
    };
  }

  async function fillAccount(acc) {
    currentStep = '청구계좌';
    let el = fieldByLabel('청구계좌');
    if (!el) throw new Error("'청구 계좌' 칸을 찾지 못함");
    if (acc && digits(valOf(el)) === digits(acc)) return valOf(el);
    const btn = helpButtonFor(el);
    if (!btn) throw new Error('청구계좌 검색 버튼을 찾지 못함');
    fire(btn);
    const d = await waitDialog();
    if (!d) throw new Error('청구계좌 검색창이 열리지 않음');
    if (!d.dlg.querySelector('[role=gridcell]')) { const t = dialogText(d); await closeDialog(d, ['확인', '취소', '닫기']); throw new Error(`청구계좌: ${t.slice(0, 150)}`); }
    if (acc) {
      const a = digits(acc);
      await pickFromHelp((cells) => cells.some((c) => digits(c) === a) || cells.join(' ').replace(/\D/g, '').includes(a), '청구계좌');
    } else {
      await pickFromHelp(() => true, '청구계좌(엑셀 미입력: 계좌가 1개일 때만 자동 선택)', { uniqueOnly: true });
    }
    await failIfDialog('청구계좌');
    el = fieldByLabel('청구계좌');
    if (!valOf(el)) throw new Error('청구계좌 선택 확인 실패');
    if (acc && digits(valOf(el)) !== digits(acc)) throw new Error(`청구계좌 불일치 (화면값 ${valOf(el)})`);
    return valOf(el);
  }

  function isClean() {
    if (openDialog()) return false;
    const total = fieldByLabel('총금액(세금포함)');
    return !!total && !valOf(total) && !cellVal(0, '계정사유') && !cellVal(0, '금액');
  }

  // ---------- 전표 1건 입력 ----------
  async function fillDoc(doc) {
    const log = [];
    // 0. 남은 팝업 정리
    const leftover = openDialog();
    if (leftover) await closeDialog(leftover, ['취소', '닫기', '확인']);
    if (!isClean()) throw new Error('화면에 이전 입력값이 남아 있습니다. 왼쪽 메뉴의 [세금계산서/계산서/기타[DR]]를 다시 눌러 빈 화면으로 만든 뒤 재시도하세요.');

    // 1. 기본정보
    await setRadio(doc.issueType || '정발행');
    log.push('증빙구분=' + (await setCombo('증빙구분', doc.evidence)));
    await setRadio(doc.claimType || '청구');
    await setLabeled('증빙일', doc.date);
    await setLabeled('총금액(세금포함)', doc.total);
    await setLabeled('적요', doc.summary);

    // 2. 거래처
    await ensureSection('거래처', '사업자등록번호');
    await setRadio('일반');
    await setLabeled('사업자등록번호', doc.bizNo);
    const contactAuto = valOf(fieldByLabel('담당자'));
    if (doc.contact) await setLabeled('담당자', doc.contact);
    if (doc.phone) await setLabeled('연락처', doc.phone);
    if (doc.email) await setLabeled('E-MAIL', doc.email);
    if (!valOf(fieldByLabel('담당자'))) throw new Error('사업자등록번호 조회 후 담당자가 비어 있음 (엑셀에 담당자/연락처/E-MAIL 입력 필요)');
    log.push('담당자=' + valOf(fieldByLabel('담당자')) + (doc.contact ? '' : '(자동조회)'));

    // 3. 전표 행
    await ensureSection('매출/수입전표입력', '총금액(세금포함)');
    const lineInfo = [];
    for (let i = 0; i < doc.lines.length; i++) lineInfo.push(await fillLine(i, doc.lines[i]));

    // 4. 청구계좌 (계정사유 입력 후에만 조회 가능)
    log.push('청구계좌=' + (await fillAccount(doc.account)));

    // 5. 최종 확인
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')].filter(visible);
    if (invalid.length) throw new Error('오류 표시된 칸이 있음: ' + pageMessages().join(' / '));
    lineInfo.forEach((x, i) => log.push(`${i + 1}행: ${x.계정과목명} / ${x.자금명} / 예산 ${x.예산항목 || '-'} ${x.예산항목명 || ''}`));

    return { ok: true, log, contactAuto };
  }

  // ---------- 임시전표 생성: 행 선택 → 결재문서작성 ----------
  function lineCheckbox(i) {
    const g = getGrid();
    if (!g) return null;
    let ci = gridCols(g).indexOf('선택');
    if (ci < 0) ci = 0;
    const row = gridRows(g)[i];
    const cell = row && row.querySelectorAll('[role=gridcell]')[ci];
    return cell ? cell.querySelector('[role=checkbox]') : null;
  }
  const isChecked = (cb) => !!cb && cb.getAttribute('aria-checked') === 'true';
  async function selectLines(n) {
    for (let i = 0; i < n; i++) {
      currentStep = `${i + 1}행 체크박스`;
      let cb = lineCheckbox(i);
      if (!cb) throw new Error(`${i + 1}행 체크박스를 찾지 못함`);
      if (!cellVal(i, '계정사유')) throw new Error(`${i + 1}행이 비어 있어 선택하지 않음`);
      if (!isChecked(cb)) { fire(cb); await waitIdle(); }
      cb = lineCheckbox(i);
      if (!isChecked(cb)) throw new Error(`${i + 1}행 체크박스 선택 실패`);
    }
  }
  async function submitDoc(n) {
    const left = openDialog();
    if (left) throw new Error('메시지창이 열려 있음: ' + dialogText(left).slice(0, 150));
    await selectLines(n);
    currentStep = '결재문서작성';
    const b = findButton('결재문서작성');
    if (!b) throw new Error("'결재문서작성' 버튼을 찾지 못함");
    fire(b);
    await waitIdle(800, 40000);
    // '...하시겠습니까?' 확인창은 '예'로 넘기고, 그 외 메시지는 그대로 두고 패널에 알려줌
    for (let k = 0; k < 3; k++) {
      const d = openDialog();
      if (!d) break;
      const t = dialogText(d);
      if (!/하시겠습니까/.test(t)) return { ok: true, dialog: t };
      const y = findButton('예', d.dlg) || findButton('확인', d.dlg);
      if (!y) throw new Error('결재문서작성 확인창 버튼을 찾지 못함: ' + t);
      fire(y);
      await waitDialogClosed(5000);
      await waitIdle(800, 40000);
    }
    return { ok: true, dialog: null };
  }
  // 메시지창(예: 전표 생성 안내)이 뜨면 내용을 읽고 [확인] 클릭
  async function confirmMessage(maxMs) {
    const d = await waitDialog(maxMs);
    if (!d) return { ok: true, dialog: null };
    const t = dialogText(d);
    const btn = findButton('확인', d.dlg) || findButton('예', d.dlg) || findButton('닫기', d.dlg);
    if (!btn) return { ok: true, dialog: t, clicked: false };
    fire(btn);
    await waitDialogClosed(8000);
    await waitIdle();
    return { ok: true, dialog: t, clicked: true };
  }

  window.__DR = { findButton, fillDoc, submitDoc, confirmMessage, selectLines, isClean, isMainForm, openDialog, dialogText, fieldByLabel, cellVal, pageMessages };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.__dr) return false;
      if (!['status', 'fillDoc', 'submit', 'confirmMessage'].includes(msg.type)) return false; // 다른 스크립트(포털) 담당
      if (!isMainForm()) return false; // 팝업용 프레임 등은 응답하지 않음
      (async () => {
        try {
          if (msg.type === 'status') {
            const d = openDialog();
            sendResponse({ ok: true, clean: isClean(), busy, dialog: d ? dialogText(d).slice(0, 200) : null });
          } else if (msg.type === 'fillDoc') {
            if (busy) return sendResponse({ ok: false, error: '이미 입력 중입니다' });
            busy = true;
            try { sendResponse(await fillDoc(msg.doc)); } finally { busy = false; }
          } else if (msg.type === 'submit') {
            if (busy) return sendResponse({ ok: false, error: '이미 작업 중입니다' });
            busy = true;
            try { sendResponse(await submitDoc(msg.lines)); } finally { busy = false; }
          } else if (msg.type === 'confirmMessage') {
            sendResponse(await confirmMessage(msg.maxMs || 20000));
          }
        } catch (e) {
          busy = false;
          sendResponse({ ok: false, error: e.message, step: currentStep });
        }
      })();
      return true;
    });
  }
})();
