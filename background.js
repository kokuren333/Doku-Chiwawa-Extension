let creatingOffscreen;

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const url = chrome.runtime.getURL('offscreen.html');
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run local Hugging Face tokenizer and ONNX Runtime WASM inference.'
      });
    }
  })().catch((e) => { creatingOffscreen = null; throw e; });
  return creatingOffscreen;
}

const MODEL_MESSAGES = new Set(['GET_STATUS','PREPARE_MODEL','INFER','CLEAR_MODEL_CACHE']);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.__fromOffscreen || msg?.__fromServiceWorker || !MODEL_MESSAGES.has(msg?.type)) return false;
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({...msg, __fromServiceWorker: true}))
    .then(sendResponse)
    .catch((e) => sendResponse({ok:false, error:String(e?.message || e)}));
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'OPEN_COMPOSE') return false;
  (async () => {
    let tabId = msg.tabId;
    if (!tabId) {
      const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
      tabId = tab?.id;
    }
    if (!tabId) throw new Error('Active tab not found.');
    try {
      await chrome.tabs.sendMessage(tabId, {type:'OPEN_COMPOSE', text:msg.text || ''});
    } catch {
      await chrome.scripting.executeScript({target:{tabId}, files:['content.js']});
      await chrome.scripting.insertCSS({target:{tabId}, files:['content.css']});
      await chrome.tabs.sendMessage(tabId, {type:'OPEN_COMPOSE', text:msg.text || ''});
    }
    return {ok:true};
  })().then(sendResponse).catch((e)=>sendResponse({ok:false,error:String(e?.message||e)}));
  return true;
});
