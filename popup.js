const $=s=>document.querySelector(s);const status=$('#status'),hover=$('#hover'),selection=$('#selection');
const filter=$('#xFilterMode');
async function refresh(){const x=await chrome.storage.local.get({hoverEnabled:true,selectionEnabled:true,xFilterMode:'off'});hover.checked=x.hoverEnabled;selection.checked=x.selectionEnabled;filter.value=x.xFilterMode||'off';try{const s=await chrome.runtime.sendMessage({type:'GET_STATUS'});status.textContent=s?.state?.error?`${s.state.detail}: ${s.state.error}`:s?.state?.detail||s?.error||'未初期化'}catch{status.textContent='未初期化'}}
hover.onchange=()=>chrome.storage.local.set({hoverEnabled:hover.checked});selection.onchange=()=>chrome.storage.local.set({selectionEnabled:selection.checked});
filter.onchange=()=>chrome.storage.local.set({xFilterMode:filter.value});
$('#prepare').onclick=async()=>{status.textContent='準備中…';const r=await chrome.runtime.sendMessage({type:'PREPARE_MODEL'});status.textContent=r?.state?.detail||r?.error||'完了'};
$('#compose').onclick=async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const r=await chrome.runtime.sendMessage({type:'OPEN_COMPOSE',tabId:tab?.id});if(!r?.ok){status.textContent=r?.error||'開けませんでした';return}window.close()};
$('#clear').onclick=async()=>{const r=await chrome.runtime.sendMessage({type:'CLEAR_MODEL_CACHE'});status.textContent=r?.state?.detail||r?.error||'削除済み'};refresh();
