// 포털(yep) 최상위 창: 왼쪽 메뉴 [세금계산서/계산서/기타[DR]]를 다시 눌러 빈 입력화면으로 만드는 기능
(() => {
  if (window.top !== window || window.__DR_PORTAL) return;
  window.__DR_PORTAL = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LINK = '세금계산서/계산서/기타[DR]';
  const MENU = '매출/수입';

  function allDocs(win, out = []) {
    let d;
    try { d = win.document; d.querySelector('a'); } catch (e) { return out; } // 다른 출처 프레임은 건너뜀
    out.push(d);
    for (let i = 0; i < win.frames.length; i++) allDocs(win.frames[i], out);
    return out;
  }
  function shown(el) {
    // 요소와 그 요소를 담은 프레임들이 모두 화면에 보이는지
    let e = el;
    while (e) {
      const r = e.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const fe = e.ownerDocument.defaultView.frameElement;
      e = fe || null;
    }
    return true;
  }
  const findLink = (t) => {
    for (const d of allDocs(window)) {
      const a = [...d.querySelectorAll('a')].find((a) => (a.innerText || '').trim() === t && shown(a));
      if (a) return a;
    }
    return null;
  };

  async function openDR() {
    let a = findLink(LINK);
    if (!a) {
      const m = findLink(MENU);
      if (!m) throw new Error(`상단 '${MENU}' 메뉴를 찾지 못함`);
      m.click();
      for (let k = 0; k < 40 && !(a = findLink(LINK)); k++) await sleep(250);
    }
    if (!a) throw new Error(`왼쪽 '${LINK}' 메뉴를 찾지 못함`);
    a.click();
    return true;
  }
  window.__DR_openDR = openDR;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.__dr || msg.type !== 'resetForm') return false;
      openDR().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    });
  }
})();
