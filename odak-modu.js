// ══════════════════════════════════════════════════════════════
// ODAK MODU (Focus Mode) — SinUs ortak modülü
// Yalnızca admin/öğretmen tarafından atanmış (kilitli=1) göz
// egzersizlerinde kullanılır. Egzersiz "tamamlandı" sayılması
// yalnızca öğrencinin kesintisiz, geçerli bir odak oturumu
// sonucunda olur — backend nihai otoritedir, client timer'a
// veya localStorage bayrağına güvenilmez.
// ══════════════════════════════════════════════════════════════
(function (window) {
  'use strict';

  const SUPABASE_URL = 'https://kwzimkjspdtedqqwztcf.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3emlta2pzcGR0ZWRxcXd6dGNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NDg4NDAsImV4cCI6MjA5NzUyNDg0MH0.64Bq_jlCNSdOnOJx3dxw1vNeEaEcMrK3OJeATYQxlcU';

  // Çok kısa, tarayıcı kaynaklı focus dalgalanmalarında öğrenciyi
  // yanlışlıkla cezalandırmamak için tolerans. TEK merkezden yönetilir.
  const FOCUS_LOSS_GRACE_MS = 1000;

  function oturumToken() {
    try { return sessionStorage.getItem('sinus_oturum_token') || ''; } catch (e) { return ''; }
  }

  async function rpc(fonksiyon, params) {
    const gonderilecek = Object.assign({ p_token: oturumToken() }, params || {});
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fonksiyon, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(gonderilecek)
    });
    if (!res.ok) {
      const h = await res.json().catch(() => ({}));
      throw new Error(h.message || 'Odak Modu isteği başarısız');
    }
    const metin = await res.text();
    return metin ? JSON.parse(metin) : null;
  }

  const _state = {
    oturumId: null,
    aktif: false,
    graceTimer: null,
    onIhlal: null
  };

  function _ihlalYakalandi(neden) {
    if (!_state.aktif) return;
    _state.aktif = false;
    if (_state.graceTimer) { clearTimeout(_state.graceTimer); _state.graceTimer = null; }
    const oturumId = _state.oturumId;
    _state.oturumId = null;
    if (oturumId) {
      rpc('odak_ihlali_bildir', { p_oturum_id: oturumId, p_neden: neden }).catch(() => {});
    }
    const cb = _state.onIhlal;
    if (cb) { try { cb(neden); } catch (e) {} }
    OdakModu._modalGoster();
  }

  function _gorunurlukDegisti() {
    if (!_state.aktif) return;
    if (document.hidden) {
      if (_state.graceTimer) clearTimeout(_state.graceTimer);
      _state.graceTimer = setTimeout(() => { _ihlalYakalandi('TAB_HIDDEN'); }, FOCUS_LOSS_GRACE_MS);
    } else {
      if (_state.graceTimer) { clearTimeout(_state.graceTimer); _state.graceTimer = null; }
    }
  }
  function _pencereOdakKaybi() {
    if (!_state.aktif) return;
    if (_state.graceTimer) clearTimeout(_state.graceTimer);
    _state.graceTimer = setTimeout(() => { _ihlalYakalandi('WINDOW_BLUR'); }, FOCUS_LOSS_GRACE_MS);
  }
  function _pencereOdakGeldi() {
    if (_state.graceTimer) { clearTimeout(_state.graceTimer); _state.graceTimer = null; }
  }
  // Sayfa kapatma/geri tuşu gibi kesin sinyal gönderilemeyen durumlar için
  // best-effort bildirim. Garanti değildir (bkz. rapor) — bu yüzden backend
  // tarafında da yarım kalan "active" oturumlar bir sonraki odak_oturumu_baslat
  // çağrısında otomatik "abandoned" işaretlenir (güvenlik ağı budur).
  function _sayfaKapaniyor() {
    if (!_state.aktif || !_state.oturumId) return;
    try {
      fetch(SUPABASE_URL + '/rest/v1/rpc/odak_ihlali_bildir', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: oturumToken(), p_oturum_id: _state.oturumId, p_neden: 'SAYFA_KAPANDI' }),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }

  document.addEventListener('visibilitychange', _gorunurlukDegisti);
  window.addEventListener('blur', _pencereOdakKaybi);
  window.addEventListener('focus', _pencereOdakGeldi);
  window.addEventListener('beforeunload', _sayfaKapaniyor);

  const OdakModu = {
    // Egzersiz "BAŞLAT"a basıldığında çağrılır. Başarılıysa true döner.
    // false dönerse (ağ hatası, geçersiz oturum vb.) çağıran taraf
    // egzersizi BAŞLATMAMALIDIR.
    async baslat(egzersizKodu, gerekliSureSn, onIhlal) {
      try {
        const sonuc = await rpc('odak_oturumu_baslat', { p_egzersiz_kodu: egzersizKodu, p_gerekli_sure_sn: Math.round(gerekliSureSn) });
        if (!sonuc || !sonuc.length || !sonuc[0].oturum_id) return false;
        _state.oturumId = sonuc[0].oturum_id;
        _state.aktif = true;
        _state.onIhlal = onIhlal || null;
        return true;
      } catch (e) {
        return false;
      }
    },

    // Egzersiz süresi normal şekilde bitince çağrılır. Backend, geçen
    // süreyi KENDİ saatiyle yeniden hesaplayıp doğrular.
    async tamamla() {
      const oturumId = _state.oturumId;
      _state.aktif = false;
      if (_state.graceTimer) { clearTimeout(_state.graceTimer); _state.graceTimer = null; }
      if (!oturumId) return { basarili: false, mesaj: 'oturum_yok', oturumId: null };
      _state.oturumId = null;
      try {
        const sonuc = await rpc('odak_oturumu_tamamla', { p_oturum_id: oturumId });
        if (sonuc && sonuc.length) return { basarili: sonuc[0].basarili, mesaj: sonuc[0].mesaj, oturumId };
        return { basarili: false, mesaj: 'bilinmeyen_hata', oturumId };
      } catch (e) {
        return { basarili: false, mesaj: 'ag_hatasi', oturumId };
      }
    },

    // Kullanıcı egzersizi kendi isteğiyle yarıda bırakırsa (Durdur, geri
    // tuşu vb.) çağrılır — sadece kayıt hijyeni içindir, kredi zaten
    // verilmiyordu (tamamla() hiç çağrılmadığı için).
    iptal(neden) {
      const oturumId = _state.oturumId;
      _state.aktif = false;
      if (_state.graceTimer) { clearTimeout(_state.graceTimer); _state.graceTimer = null; }
      _state.oturumId = null;
      if (oturumId) {
        rpc('odak_ihlali_bildir', { p_oturum_id: oturumId, p_neden: neden || 'KULLANICI_IPTAL' }).catch(() => {});
      }
    },

    aktifMi() { return _state.aktif; },

    // "Odak Modu Sonlandırıldı" modalı — mevcut .modal-overlay/.modal-box
    // stiliyle tutarlı, suçlayıcı olmayan dille.
    _modalGoster() {
      let overlay = document.getElementById('odakIhlalOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'odakIhlalOverlay';
        overlay.className = 'modal-overlay active';
        overlay.innerHTML =
          '<div class="modal-box">' +
            '<h3>ODAK MODU SONLANDIRILDI</h3>' +
            '<div class="icerik">Egzersiz sırasında çalışma ekranından ayrıldığın için bu oturum tamamlanmadı.<br><br>Egzersizi yeniden başlatabilirsin.</div>' +
            '<button id="odakIhlalYenidenBaslaBtn" style="margin-top:16px;width:100%;padding:13px;background:linear-gradient(135deg,var(--accent2),var(--accent));border:none;border-radius:12px;color:var(--bg);font-family:\'Orbitron\',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer">Egzersizi Yeniden Başlat</button>' +
          '</div>';
        document.body.appendChild(overlay);
        document.getElementById('odakIhlalYenidenBaslaBtn').addEventListener('click', function () {
          overlay.classList.remove('active');
          if (typeof window.menuye === 'function') window.menuye();
        });
      } else {
        overlay.classList.add('active');
      }
    }
  };

  window.OdakModu = OdakModu;
})(window);
