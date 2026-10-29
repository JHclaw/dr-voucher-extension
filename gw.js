// 결재문서작성 후 열리는 그룹웨어 창(outProcess.do)의 문서 ID를 패널에 알려줌 (처리 완료 확인용)
(() => {
  try {
    const p = new URLSearchParams(location.search);
    chrome.runtime.sendMessage({
      type: 'gwOpened',
      docId: p.get('doc_id'),
      systemId: p.get('system_id'),
      at: new Date().toISOString()
    }).catch(() => {});
  } catch (e) { /* 패널이 닫혀 있으면 무시 */ }
})();
