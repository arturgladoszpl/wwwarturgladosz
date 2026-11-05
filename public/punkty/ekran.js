// Ekran nie gaśnie, dopóki licznik albo gra są na wierzchu. Wspólne dla /punkty/ i /punkty/plytki/.
// Gdzie przeglądarka ma Screen Wake Lock, używamy go wprost; w starszych przeglądarkach
// NoSleep.js odtwarza niewidoczny, wyciszony film (musi to uruchomić dotknięcie ekranu).
// Ustawienie jest wspólne dla obu stron i zapamiętane na telefonie.
(function(){
  const KEY='licznik-punktow-ekran';
  const get=()=>{try{return localStorage.getItem(KEY);}catch(e){return null;}};
  const set=v=>{try{v==null?localStorage.removeItem(KEY):localStorage.setItem(KEY,v);}catch(e){}};
  const native='wakeLock' in navigator;
  const video=!native&&typeof NoSleep==='function'?new NoSleep():null;
  let on=get()!=='0',lock=null,busy=false,active=false,blocked=false;
  const buttons=[];

  const LABELS={
    long:{active:'☀ Ekran nie gaśnie',waiting:'☀ Dotknij, by ekran nie gasł',blocked:'⚠ Telefon nie pozwala',off:'Ekran może gasnąć',none:'Ekran: brak obsługi'},
    short:{active:'☀ Ekran',waiting:'☀ Dotknij',blocked:'⚠ Ekran',off:'Ekran wył.',none:'Ekran ✕'},
  };
  function state(){
    if(!native&&!video)return 'none';
    if(!on)return 'off';
    if(active)return 'active';
    return blocked?'blocked':'waiting';
  }
  function render(){
    const s=state();
    buttons.forEach(({b,size})=>{
      b.hidden=false;
      b.textContent=LABELS[size][s];
      b.disabled=s==='none';
      b.setAttribute('aria-pressed',on&&s!=='none');
      b.dataset.state=s;
      b.title={active:'Ekran nie zgaśnie, dopóki ta strona jest otwarta. Dotknij, żeby wyłączyć.',
        waiting:'Dotknij, żeby ekran nie gasł.',
        blocked:'Telefon nie pozwolił utrzymać ekranu, np. w trybie oszczędzania baterii. Dotknij, żeby spróbować ponownie.',
        off:'Ekran gaśnie normalnie. Dotknij, żeby to zmienić.',
        none:'Ta przeglądarka nie pozwala stronom utrzymać włączonego ekranu.'}[s];
    });
  }

  async function enable(){
    if(!on||busy||document.hidden)return;
    if(native){
      if(lock)return;
      busy=true;
      try{
        const l=await navigator.wakeLock.request('screen');
        l.addEventListener('release',()=>{if(lock===l){lock=null;active=false;render();}});
        if(on){lock=l;active=true;blocked=false;}else l.release().catch(()=>{});
      }catch(e){active=false;blocked=e&&e.name==='NotAllowedError';}
      busy=false;
    }else if(video&&!active){
      busy=true;
      try{await video.enable();active=true;blocked=false;}catch(e){active=false;}
      busy=false;
    }
    render();
  }
  function disable(){
    if(lock){const l=lock;lock=null;l.release().catch(()=>{});}
    if(video&&video.isEnabled)video.disable();
    active=false;render();
  }

  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){if(video&&active){video.disable();active=false;render();}}
    else enable();
  });
  // Przeglądarki zwykle pozwalają na to dopiero po dotknięciu ekranu.
  document.addEventListener('pointerdown',enable,true);
  document.addEventListener('click',enable,true);

  window.Ekran={
    attach(b,size){
      buttons.push({b,size:size==='short'?'short':'long'});
      b.addEventListener('click',e=>{
        e.stopPropagation();
        if(on&&!active){enable();return;}
        on=!on;set(on?null:'0');
        on?enable():disable();
        render();
      });
      render();enable();
    },
  };
})();
